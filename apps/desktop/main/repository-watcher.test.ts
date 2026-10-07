import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git';
import { RepositoryWatcher, type DirectoryWatch, type RepositoryWatchState } from './repository-watcher';

const exec = promisify(execFile);
const roots: string[] = [];
const watchers: RepositoryWatcher[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function directory() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'smart-diff-watch-')));
  roots.push(root); return root;
}
async function git(root: string, ...args: string[]) { return (await exec('git', args, { cwd: root })).stdout; }
afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('persistent repository watching', () => {
  async function setup(options: { native?: boolean; pollMs?: number } = {}) {
    const root = await directory();
    const file = path.join(root, 'source.ts');
    await writeFile(file, 'first');
    const nativeWatch = vi.fn<DirectoryWatch>((directory, options, listener) => watch(directory, options, listener));
    const notify = vi.fn();
    const readState = async (): Promise<RepositoryWatchState> => {
      const info = await lstat(root);
      let signature: string;
      try { const fileInfo = await lstat(file); signature = `${fileInfo.ino}:${fileInfo.size}:${fileInfo.mtimeMs}`; }
      catch { signature = 'missing'; }
      return { signature, paths: [{ path: root, identity: `${info.dev}:${info.ino}`, kind: 'working' }] };
    };
    const watcher = new RepositoryWatcher(readState, notify, { debounceMs: 15, pollMs: options.pollMs ?? 10000, watch: options.native === false ? () => { throw new Error('No native watch'); } : nativeWatch });
    watchers.push(watcher); await watcher.check();
    return { root, file, watcher, notify, nativeWatch };
  }

  it('retains watchers across refresh, catches atomic saves and reappearance, and stops on dispose', async () => {
    const { root, file, watcher, notify, nativeWatch } = await setup();
    await watcher.check(); await watcher.check();
    expect(nativeWatch).toHaveBeenCalledTimes(1);
    const replacement = path.join(root, 'replacement');
    await writeFile(replacement, 'replacement contents'); await rename(replacement, file);
    await expect.poll(() => notify.mock.calls.length).toBe(1);
    await rm(file);
    await expect.poll(() => notify.mock.calls.length).toBe(2);
    await writeFile(file, 'returned');
    await expect.poll(() => notify.mock.calls.length).toBe(3);
    watcher.dispose(); await writeFile(file, 'after disposal'); await pause(80);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('automatically detects changes when native watching is unavailable without no-op notifications', async () => {
    const { file, notify } = await setup({ native: false, pollMs: 25 });
    await pause(90); expect(notify).not.toHaveBeenCalled();
    await writeFile(file, 'polling catches this');
    await expect.poll(() => notify.mock.calls.length).toBe(1);
    await pause(90); expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retains one trailing probe without overlapping work or losing an event mid-read', async () => {
    let finish: ((state: RepositoryWatchState) => void) | undefined;
    let calls = 0;
    const notify = vi.fn();
    const read = () => {
      calls++;
      if (calls === 2) return new Promise<RepositoryWatchState>(resolve => { finish = resolve; });
      return Promise.resolve({ signature: calls === 1 ? 'initial' : 'latest', paths: [] });
    };
    const watcher = new RepositoryWatcher(read, notify, { debounceMs: 5, pollMs: 10000 });
    watchers.push(watcher); await watcher.check();
    const inflight = watcher.check();
    for (let i = 0; i < 50; i++) void watcher.check();
    expect(calls).toBe(2);
    finish!({ signature: 'initial', paths: [] }); await inflight;
    await expect.poll(() => calls).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a pending probe after disposal', async () => {
    let finish: ((state: RepositoryWatchState) => void) | undefined;
    const notify = vi.fn();
    const watcher = new RepositoryWatcher(() => new Promise(resolve => { finish = resolve; }), notify);
    watchers.push(watcher);
    const pending = watcher.check(); watcher.dispose();
    finish!({ signature: 'late', paths: [] }); await pending;
    expect(notify).not.toHaveBeenCalled();
  });

  it('baselines added/removed watch interests without masking changes to already watched paths', async () => {
    let state: RepositoryWatchState = { signature: 'initial', baseSignature: 'git', paths: [], fingerprints: { first: 'a' } };
    const notify = vi.fn();
    const watcher = new RepositoryWatcher(async () => state, notify, { pollMs: 10000 });
    watchers.push(watcher);
    await watcher.check();
    state = { ...state, signature: 'added', fingerprints: { first: 'a', second: 'b' } };
    await watcher.check();
    state = { ...state, signature: 'removed', fingerprints: { second: 'b' } };
    await watcher.check();
    expect(notify).not.toHaveBeenCalled();
    state = { ...state, signature: 'edited-and-added', fingerprints: { second: 'changed', third: 'c' } };
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(1);
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(1);
    state = { ...state, baseSignature: 'new-git-status' };
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('safe Git watch probes', () => {
  async function setup() {
    const root = await directory();
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Fixture');
    await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src/nested/source.ts'), 'first\n');
    await writeFile(path.join(root, '.gitignore'), '*.ignored\n');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    return { root, service, id: snapshot.repository.id, snapshot };
  }

  it('detects nested changes, repeated same-status edits, and newly untracked directories without replacing capabilities', async () => {
    const { root, service, id, snapshot } = await setup();
    const original = await service.getRepositoryWatchState(id);
    await writeFile(path.join(root, 'src/nested/source.ts'), 'second\n');
    const changed = await service.getRepositoryWatchState(id);
    expect(changed.signature).not.toBe(original.signature);
    expect(changed.paths.some(item => item.path === path.join(root, 'src/nested'))).toBe(true);
    await writeFile(path.join(root, 'src/nested/source.ts'), 'third revision\n');
    const repeated = await service.getRepositoryWatchState(id);
    expect(repeated.signature).not.toBe(changed.signature);
    await mkdir(path.join(root, 'new/deep'), { recursive: true });
    await writeFile(path.join(root, 'new/deep/entry.ts'), 'new\n');
    expect((await service.getRepositoryWatchState(id)).signature).not.toBe(repeated.signature);
    expect(await service.listChanges(id)).toBe(snapshot);
    service.dispose();
  });

  it('tracks opened ignored files and directories while excluding symlink escapes and Git object directories', async () => {
    const { root, service, id } = await setup();
    const rootEntries = await service.listProjectDirectory(id, null);
    const source = rootEntries.entries.find(entry => entry.name === 'src')!;
    const sourceEntries = await service.listProjectDirectory(id, source.id);
    const nested = sourceEntries.entries.find(entry => entry.name === 'nested')!;
    await writeFile(path.join(root, 'src/nested/cache.ignored'), 'ignored text');
    const children = await service.listProjectDirectory(id, nested.id);
    await service.readProjectFile(id, children.entries.find(entry => entry.name === 'cache.ignored')!.id);
    const before = await service.getRepositoryWatchState(id);
    await writeFile(path.join(root, 'src/nested/cache.ignored'), 'changed ignored contents');
    expect((await service.getRepositoryWatchState(id)).signature).not.toBe(before.signature);
    const outside = await directory();
    await rename(path.join(root, 'src/nested'), path.join(root, 'src/previous'));
    await symlink(outside, path.join(root, 'src/nested'));
    const escaped = await service.getRepositoryWatchState(id);
    expect(escaped.paths.some(item => item.path === outside || item.path === path.join(root, 'src/nested'))).toBe(false);
    expect(escaped.paths.some(item => item.path.includes(`${path.sep}.git${path.sep}objects`))).toBe(false);
    service.dispose();
  });

  it('ignores transient metadata locks in fallback signatures', async () => {
    const { root, service, id } = await setup();
    const before = await service.getRepositoryWatchState(id);
    await writeFile(path.join(root, '.git/index.lock'), '');
    const during = await service.getRepositoryWatchState(id);
    await rm(path.join(root, '.git/index.lock'));
    expect(during.signature).toBe(before.signature);
    expect((await service.getRepositoryWatchState(id)).signature).toBe(before.signature);
    service.dispose();
  });

  it('does not refresh the repository just for expanding directories or opening files', async () => {
    const { root, service, id, snapshot } = await setup();
    // Already-existing ignored content must also establish a quiet baseline.
    await writeFile(path.join(root, 'src/nested/cache.ignored'), 'ignored before opening');
    const notify = vi.fn();
    const watcher = new RepositoryWatcher(() => service.getRepositoryWatchState(id), notify, {
      pollMs: 10000, watch: () => { throw new Error('Use deterministic probes'); },
    });
    watchers.push(watcher);
    await watcher.check();
    const top = await service.listProjectDirectory(id, null);
    await watcher.check();
    const source = await service.listProjectDirectory(id, top.entries.find(entry => entry.name === 'src')!.id);
    await watcher.check();
    const nested = await service.listProjectDirectory(id, source.entries.find(entry => entry.name === 'nested')!.id);
    await watcher.check();
    await service.readProjectFile(id, nested.entries.find(entry => entry.name === 'cache.ignored')!.id);
    await watcher.check();
    expect(notify).not.toHaveBeenCalled();
    expect((await service.listChanges(id)).generation).toBe(snapshot.generation);
    await writeFile(path.join(root, 'src/nested/cache.ignored'), 'actual ignored-file edit');
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(1);
    await writeFile(path.join(root, 'src/nested/tsconfig.json'), '{"compilerOptions":{"rootDir":"."}}');
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(2);
    await service.refreshRepository(id);
    await service.listProjectDirectory(id, null);
    await watcher.check();
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(2);
    service.dispose();
  });
});
