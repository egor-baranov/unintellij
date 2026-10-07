import { execFile, execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git';
import { BranchService, validateBranchOperation } from './branches';
import type { BranchOperation } from '../../shared/branches/types';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) => (await exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
async function repo(commit = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-branches-')); roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'tests@example.invalid'); await git(root, 'config', 'user.name', 'Test');
  if (commit) { await writeFile(path.join(root, 'file.txt'), 'base\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Base'); }
  const service = new GitService(); const registered = await service.registerRepository(root); const branches = new BranchService(service); const id = registered.repository.id;
  const run = async (operation: BranchOperation) => branches.runBranchOperation(id, (await branches.listBranches(id)).token, operation);
  return { root, service, branches, id, run };
}
async function remote(root: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-remote-')); roots.push(directory);
  await git(directory, 'init', '--bare'); await git(root, 'remote', 'add', 'origin', directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('branch operation payloads', () => {
  it('rejects options, unknown operations and untyped booleans', () => {
    for (const operation of [{ kind: 'checkout', ref: '--orphan' }, { kind: 'create', name: '-bad' }, { kind: 'rename', ref: 'refs/heads/../main', name: 'safe' }, { kind: 'delete', ref: 'refs/heads/main', force: 'true' }, { kind: 'checkout-revision', revision: '--output=oops' }, { kind: 'run', command: 'status' }]) expect(() => validateBranchOperation(operation)).toThrow();
    expect(validateBranchOperation({ kind: 'create', name: 'feature/名', checkout: true })).toMatchObject({ name: 'feature/名' });
    for (const extra of [{ changeIds: [] }, { changeIds: ['../file'] }, { options: { author: '--config=bad' } }, { options: { author: 'Name\nInjected <a@b>' } }, { options: { signOff: 'true' } }, { options: { checkTodo: 1 } }]) {
      expect(() => validateBranchOperation({ kind: 'commit', message: 'Message', amend: false, ...extra })).toThrow();
    }
  });
});

describe('branch service in real repositories', { timeout: 60000 }, () => {
  it('lists current, tags, remote tracking and recent checkouts; rejects stale operations', async () => {
    const { root, branches, id, run } = await repo();
    await remote(root); await git(root, 'push', '-u', 'origin', 'main'); await git(root, 'tag', 'v1');
    const initial = await branches.listBranches(id);
    expect(initial).toMatchObject({ current: 'refs/heads/main', unborn: false, dirty: false });
    expect(initial.branches.find(branch => branch.current)).toMatchObject({ upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0 });
    expect(initial.branches.some(branch => branch.kind === 'tag' && branch.name === 'v1')).toBe(true);
    await run({ kind: 'create', name: 'feature/test', checkout: true });
    await expect(branches.runBranchOperation(id, initial.token, { kind: 'delete', ref: 'refs/heads/main' })).rejects.toThrow('Branches changed');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    expect((await branches.listBranches(id)).recent).toContain('refs/heads/feature/test');
    await run({ kind: 'rename', ref: 'refs/heads/feature/test', name: 'renamed' });
    await run({ kind: 'delete', ref: 'refs/heads/renamed' });
    await run({ kind: 'delete', ref: 'refs/tags/v1' });
    expect((await branches.listBranches(id)).branches.some(branch => branch.name === 'renamed' || branch.name === 'v1')).toBe(false);
  });

  it('handles unborn HEAD, staged-only commit, amend and detached revisions', async () => {
    const { root, branches, id, run } = await repo(false);
    expect(await branches.listBranches(id)).toMatchObject({ current: 'refs/heads/main', head: null, unborn: true });
    await writeFile(path.join(root, 'tracked'), 'index\n'); await git(root, 'add', 'tracked'); await writeFile(path.join(root, 'tracked'), 'working\n');
    await run({ kind: 'commit', message: 'First commit\n\nDetails', amend: false });
    expect(await git(root, 'show', 'HEAD:tracked')).toBe('index\n');
    expect(await readFile(path.join(root, 'tracked'), 'utf8')).toBe('working\n');
    await run({ kind: 'commit', message: 'Amended message', amend: true });
    expect((await git(root, 'log', '-1', '--format=%s')).trim()).toBe('Amended message');
    await run({ kind: 'checkout-revision', revision: 'HEAD' });
    expect(await branches.listBranches(id)).toMatchObject({ current: null, unborn: false });
  });

  it('does not overwrite dirty files and restores tracked/untracked changes with smart checkout', async () => {
    const { root, branches, id, run } = await repo();
    await run({ kind: 'create', name: 'other', checkout: true });
    await writeFile(path.join(root, 'file.txt'), 'other\n'); await git(root, 'commit', '-am', 'Other');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await writeFile(path.join(root, 'file.txt'), 'dirty\n');
    await expect(run({ kind: 'checkout', ref: 'refs/heads/other' })).rejects.toThrow();
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('dirty\n');
    // Nonoverlapping local changes survive smart checkout with staged state.
    await writeFile(path.join(root, 'file.txt'), 'base\n');
    await writeFile(path.join(root, 'staged'), 'stage\n'); await git(root, 'add', 'staged');
    await writeFile(path.join(root, 'untracked'), 'keep\n');
    await run({ kind: 'checkout', ref: 'refs/heads/other', smart: true });
    expect(await readFile(path.join(root, 'untracked'), 'utf8')).toBe('keep\n');
    expect((await branches.listBranches(id)).stagedCount).toBe(1);
    expect((await git(root, 'stash', 'list')).trim()).toBe('');
  });

  it('lists and protects branches checked out in another worktree', async () => {
    const { root, branches, id, run } = await repo();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-worktree-')); roots.push(parent);
    const linked = path.join(parent, 'with\nnewline');
    await git(root, 'worktree', 'add', '-b', 'linked', linked);
    expect((await branches.listBranches(id)).branches.find(branch => branch.name === 'linked')?.worktree).toBe(await realpath(linked));
    await expect(run({ kind: 'checkout', ref: 'refs/heads/linked' })).rejects.toThrow('another worktree');
    await expect(run({ kind: 'delete', ref: 'refs/heads/linked', force: true })).rejects.toThrow('another worktree');
  });

  it('pushes, fetches, creates remote tracking branches and updates from a local bare remote', async () => {
    const { root, branches, id, run } = await repo();
    const bare = await remote(root);
    await run({ kind: 'push', remote: 'origin', setUpstream: true });
    expect((await branches.listBranches(id)).branches.find(branch => branch.current)?.upstream).toBe('refs/remotes/origin/main');
    const clone = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-clone-')); roots.push(clone);
    await git(clone, 'clone', '-b', 'main', bare, '.'); await git(clone, 'config', 'user.email', 'test@example.invalid'); await git(clone, 'config', 'user.name', 'Test');
    await writeFile(path.join(clone, 'remote.txt'), 'remote\n'); await git(clone, 'add', '.'); await git(clone, 'commit', '-m', 'Remote'); await git(clone, 'push');
    await git(clone, 'branch', 'remote-feature'); await git(clone, 'push', 'origin', 'remote-feature');
    await run({ kind: 'fetch' });
    expect((await branches.listBranches(id)).branches.find(branch => branch.current)?.behind).toBe(1);
    await run({ kind: 'update', method: 'ff-only' });
    expect(await readFile(path.join(root, 'remote.txt'), 'utf8')).toBe('remote\n');
    await run({ kind: 'checkout', ref: 'refs/remotes/origin/remote-feature' });
    expect((await branches.listBranches(id)).current).toBe('refs/heads/remote-feature');
    await run({ kind: 'checkout-update', ref: 'refs/heads/main', method: 'merge' });
    await run({ kind: 'delete', ref: 'refs/remotes/origin/remote-feature' });
    expect((await git(bare, 'for-each-ref', '--format=%(refname)')).includes('remote-feature')).toBe(false);
  });

  it('merges, rebases, reports conflicts and aborts without losing the previous commit', async () => {
    const { root, branches, id, run } = await repo();
    await run({ kind: 'create', name: 'other', checkout: true });
    await writeFile(path.join(root, 'file.txt'), 'other\n'); await git(root, 'commit', '-am', 'Other');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await writeFile(path.join(root, 'file.txt'), 'main\n'); await git(root, 'commit', '-am', 'Main');
    const head = (await branches.listBranches(id)).head;
    await expect(run({ kind: 'merge', ref: 'refs/heads/other' })).rejects.toThrow('merge is now in progress');
    expect((await branches.listBranches(id)).operation).toBe('merge');
    await run({ kind: 'abort' }); expect((await branches.listBranches(id)).head).toBe(head);
    await expect(run({ kind: 'rebase', ref: 'refs/heads/other' })).rejects.toThrow('rebase is now in progress');
    expect((await branches.listBranches(id)).operation).toBe('rebase');
    await writeFile(path.join(root, 'file.txt'), 'resolved\n'); await git(root, 'add', 'file.txt');
    await run({ kind: 'continue' }); expect((await branches.listBranches(id)).operation).toBeNull();
  });

  it('disables hooks and rejects executable filters without executing them', async () => {
    const { root, run } = await repo();
    const marker = path.join(root, 'executed');
    await writeFile(path.join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await run({ kind: 'create', name: 'safe', checkout: true });
    await expect(readFile(marker)).rejects.toThrow();
    await git(root, 'config', 'filter.dangerous.clean', `touch '${marker}'; cat`);
    await writeFile(path.join(root, '.gitattributes'), '*.txt filter=dangerous\n');
    await expect(run({ kind: 'checkout', ref: 'refs/heads/main' })).rejects.toThrow('executable filters');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('compares immutable branch contents and working changes with odd paths, limits, swap and stale detection', async () => {
    const { root, branches, id, run } = await repo();
    const unusual = 'space 名\ttab\nnewline.ts';
    await run({ kind: 'create', name: 'other', checkout: true });
    await writeFile(path.join(root, unusual), 'other\r\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Add odd path');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    const comparison = await branches.compareBranches(id, 'refs/heads/other', 'head');
    expect(comparison.commits.map(commit => commit.subject)).toContain('Add odd path');
    const selected = comparison.changes.find(change => change.path === unusual)!;
    expect(await branches.readBranchComparison(id, comparison.id, selected.id)).toMatchObject({ state: 'text', changeType: 'deleted', original: { text: 'other\r\n' }, modified: { text: '' } });
    // Cached comparison remains valid after the source branch advances.
    await git(root, 'branch', '-f', 'other', 'main');
    expect((await branches.readBranchComparison(id, comparison.id, selected.id)).original?.text).toBe('other\r\n');
    await writeFile(path.join(root, unusual), 'working\n');
    const working = await branches.compareBranches(id, 'refs/heads/other', 'working', true);
    const workingFile = working.changes.find(change => change.path === unusual)!;
    expect(await branches.readBranchComparison(id, working.id, workingFile.id)).toMatchObject({ changeType: 'deleted', original: { text: 'working\n' }, modified: { text: '' } });
    await writeFile(path.join(root, unusual), 'new working\n');
    expect((await branches.readBranchComparison(id, working.id, workingFile.id)).state).toBe('stale');
    await symlink('/etc/passwd', path.join(root, 'link'));
    const links = await branches.compareBranches(id, 'refs/heads/main', 'working');
    const link = links.changes.find(change => change.path === 'link')!;
    expect((await branches.readBranchComparison(id, links.id, link.id)).state).toBe('symlink');
    await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'file'), 'safe');
    const race = await branches.compareBranches(id, 'refs/heads/main', 'working');
    await rm(path.join(root, 'folder'), { recursive: true }); await symlink('/etc', path.join(root, 'folder'));
    expect((await branches.readBranchComparison(id, race.id, race.changes.find(change => change.path === 'folder/file')!.id)).state).not.toBe('text');
  });

  it('serializes competing writes so only the first stale-token operation succeeds', async () => {
    const { branches, id } = await repo(); const snapshot = await branches.listBranches(id);
    const results = await Promise.allSettled(['one', 'two'].map(name => branches.runBranchOperation(id, snapshot.token, { kind: 'create', name, checkout: false })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('keeps existing file comparison capabilities valid while opening the branch menu', async () => {
    const { root, service, branches, id } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'working\n');
    const files = await service.refreshRepository(id);
    await branches.listBranches(id);
    expect((await service.listChanges(id)).generation).toBe(files.generation);
    expect((await service.readComparison(id, files.changes[0].id)).modified?.text).toBe('working\n');
  });

  it('invalidates a commit review when staged content changes and excludes working files identical to the selected branch', async () => {
    const { root, branches, id, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'first staged\n'); await git(root, 'add', 'file.txt');
    const review = await branches.listBranches(id);
    await writeFile(path.join(root, 'file.txt'), 'second staged\n'); await git(root, 'add', 'file.txt');
    await expect(branches.runBranchOperation(id, review.token, { kind: 'commit', message: 'Not approved', amend: false })).rejects.toThrow('Branches changed');
    await run({ kind: 'commit', message: 'Second', amend: false });
    await run({ kind: 'create', name: 'source', checkout: false });
    await writeFile(path.join(root, 'file.txt'), 'new HEAD\n'); await git(root, 'commit', '-am', 'New HEAD');
    await writeFile(path.join(root, 'file.txt'), 'second staged\n');
    expect((await branches.compareBranches(id, 'refs/heads/source', 'working')).changes).toEqual([]);
  });

  it('retains local changes in a named stash when smart restoration conflicts', async () => {
    const { root, branches, id, run } = await repo();
    await run({ kind: 'create', name: 'other', checkout: true });
    await writeFile(path.join(root, 'file.txt'), 'other\n'); await git(root, 'commit', '-am', 'Other');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await writeFile(path.join(root, 'file.txt'), 'dirty\n');
    await expect(run({ kind: 'checkout', ref: 'refs/heads/other', smart: true })).rejects.toThrow('remain saved in stash');
    expect((await branches.listBranches(id)).current).toBe('refs/heads/other');
    expect(await git(root, 'stash', 'show', '--patch')).toContain('+dirty');
  });

  it('never executes steps from an externally started interactive rebase', async () => {
    const { root, run } = await repo();
    const marker = path.join(root, 'executed');
    // Rebase state intentionally simulates an interrupted externally authored
    // plan. Only temporary test metadata is written; no user repo is modified.
    await mkdir(path.join(root, '.git/rebase-merge'));
    await writeFile(path.join(root, '.git/rebase-merge/git-rebase-todo'), `exec touch '${marker}'\n`);
    await expect(run({ kind: 'continue' })).rejects.toThrow('executable steps');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('reports binary, encoding and oversized branch blobs without truncation', async () => {
    const { root } = await repo();
    await writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, 'encoding'), Buffer.from([0xff, 0xfe, 0x61, 0]));
    await writeFile(path.join(root, 'large'), 'x'.repeat(200));
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Special files'); await git(root, 'branch', 'source');
    await git(root, 'rm', 'binary', 'encoding', 'large'); await git(root, 'commit', '-m', 'Remove');
    const files = new GitService({ maxFileBytes: 20 }); const snapshot = await files.registerRepository(root);
    const branches = new BranchService(files);
    const comparison = await branches.compareBranches(snapshot.repository.id, 'refs/heads/source', 'head');
    for (const [filePath, state] of [['binary', 'binary'], ['encoding', 'encoding'], ['large', 'oversized']]) {
      const file = comparison.changes.find(change => change.path === filePath)!;
      expect((await branches.readBranchComparison(snapshot.repository.id, comparison.id, file.id)).state).toBe(state);
    }
  });

  it('rebases a selected branch onto the current branch, merges it, and requires force to delete unmerged work', async () => {
    const { root, branches, id, run } = await repo();
    await run({ kind: 'create', name: 'feature', checkout: true });
    await writeFile(path.join(root, 'feature'), 'feature\n'); await git(root, 'add', 'feature'); await git(root, 'commit', '-m', 'Feature');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await expect(run({ kind: 'delete', ref: 'refs/heads/feature' })).rejects.toThrow('not fully merged');
    await writeFile(path.join(root, 'main'), 'main\n'); await git(root, 'add', 'main'); await git(root, 'commit', '-m', 'Main');
    await run({ kind: 'rebase', ref: 'refs/heads/feature', checkout: true });
    expect((await branches.listBranches(id)).current).toBe('refs/heads/feature');
    expect(await readFile(path.join(root, 'main'), 'utf8')).toBe('main\n');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await run({ kind: 'merge', ref: 'refs/heads/feature' });
    await run({ kind: 'delete', ref: 'refs/heads/feature' });
    await run({ kind: 'create', name: 'discard', checkout: true });
    await writeFile(path.join(root, 'unique'), 'unique\n'); await git(root, 'add', 'unique'); await git(root, 'commit', '-m', 'Unique');
    await run({ kind: 'checkout', ref: 'refs/heads/main' });
    await run({ kind: 'delete', ref: 'refs/heads/discard', force: true });
  });

  it('pushes tags and renames tracking branches while optionally removing upstream', async () => {
    const { root, branches, id, run } = await repo();
    const bare = await remote(root);
    await run({ kind: 'push', remote: 'origin', setUpstream: true });
    await git(root, 'tag', '-a', 'v1', '-m', 'Version 1');
    await run({ kind: 'push', ref: 'refs/tags/v1', remote: 'origin' });
    expect((await git(bare, 'show-ref', '--tags')).includes('refs/tags/v1')).toBe(true);
    await run({ kind: 'rename', ref: 'refs/heads/main', name: 'new-main', unsetUpstream: true });
    expect((await branches.listBranches(id)).branches.find(branch => branch.current)).toMatchObject({ name: 'new-main', upstream: undefined });
  });

  it('does not run signing tools or push unselected tags from repository push configuration', async () => {
    const { root, run } = await repo(); const bare = await remote(root);
    const marker = path.join(root, 'signing-executed');
    const program = path.join(root, 'signer');
    await writeFile(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    await git(root, 'config', 'gpg.program', program); await git(root, 'config', 'push.gpgSign', 'true');
    await git(root, 'tag', '-a', 'unreviewed', '-m', 'Keep local'); await git(root, 'config', 'push.followTags', 'true');
    await run({ kind: 'push', remote: 'origin', setUpstream: true });
    expect(await git(bare, 'for-each-ref', '--format=%(refname)', 'refs/tags')).toBe('');
    await expect(readFile(marker)).rejects.toThrow();
    await git(root, 'config', 'fetch.pruneTags', 'true'); await git(root, 'config', 'fetch.prune', 'true');
    await run({ kind: 'fetch' });
    expect(await git(root, 'tag', '--list')).toContain('unreviewed');
    await git(root, 'config', 'core.alternateRefsCommand', `touch '${marker}'`);
    await expect(run({ kind: 'fetch' })).rejects.toThrow('executable filters');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('commits exactly the reviewed split index even if external Git stages more during commit', async () => {
    const { root, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'reviewed\n'); await git(root, 'add', 'file.txt');
    await git(root, 'update-index', '--split-index');
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let inserted = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!inserted && Array.isArray(args[1]) && args[1].includes('commit')) {
        inserted = true;
        writeFileSync(path.join(root, 'late'), 'not reviewed\n');
        execFileSync('git', ['add', '--', 'late'], { cwd: root });
      }
      return originalSpawn(...args);
    });
    try { await run({ kind: 'commit', message: 'Reviewed only', amend: false }); }
    finally { spy.mockImplementation(originalSpawn); }
    expect(inserted).toBe(true);
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('reviewed\n');
    expect(await git(root, 'ls-tree', '--name-only', 'HEAD')).not.toContain('late');
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('late\n');
  });

  it('commits only checked staged files and preserves unchecked index entries and working edits', async () => {
    const { root, service, id, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'selected staged\n');
    await writeFile(path.join(root, 'unchecked'), 'keep staged\n');
    await git(root, 'add', '.');
    await git(root, 'update-index', '--split-index');
    await writeFile(path.join(root, 'file.txt'), 'later working edit\n');
    const changes = (await service.refreshRepository(id)).changes;
    const selected = changes.find(change => change.path === 'file.txt' && change.group === 'staged')!;
    const unchecked = await git(root, 'rev-parse', ':unchecked');
    await run({ kind: 'commit', message: 'Selected staged', amend: false, changeIds: [selected.id] });
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('selected staged\n');
    expect(await git(root, 'rev-parse', ':unchecked')).toBe(unchecked);
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('unchecked\n');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('later working edit\n');
    await expect(git(root, 'show', 'HEAD:unchecked')).rejects.toThrow();
  });

  it('prefers a checked working version over its checked staged version and retains unchecked staged snapshots', async () => {
    const { root, service, id, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'staged\n'); await git(root, 'add', '.');
    await writeFile(path.join(root, 'file.txt'), 'working\n');
    let changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'Both versions selected', amend: false, changeIds: changes.map(change => change.id) });
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('working\n');
    expect(await git(root, 'status', '--porcelain')).toBe('');
    await writeFile(path.join(root, 'file.txt'), 'unchecked staged version\n'); await git(root, 'add', '.');
    await writeFile(path.join(root, 'file.txt'), 'selected working version\n');
    changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'Working version only', amend: false, changeIds: changes.filter(change => change.group === 'unstaged').map(change => change.id) });
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('selected working version\n');
    expect(await git(root, 'show', ':file.txt')).toBe('unchecked staged version\n');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('selected working version\n');
  });

  it('commits selected untracked binary and executable files on unborn HEAD with unusual paths', async () => {
    const { root, service, id, run } = await repo(false);
    const unusual = '-new\n名.txt';
    const data = Buffer.from([0, 1, 255, 20]);
    await writeFile(path.join(root, unusual), data);
    await writeFile(path.join(root, 'executable'), '#!/bin/sh\necho not executed\n', { mode: 0o755 });
    await writeFile(path.join(root, 'unchecked'), 'left alone\n');
    const changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'First selected files', amend: false, changeIds: changes.filter(change => change.path !== 'unchecked').map(change => change.id) });
    const blob = await exec('git', ['show', `HEAD:${unusual}`], { cwd: root, encoding: 'buffer' });
    expect(blob.stdout).toEqual(data);
    expect(await git(root, 'ls-tree', 'HEAD', '--', 'executable')).toMatch(/^100755 blob /);
    expect(await git(root, 'status', '--porcelain')).toBe('?? unchecked\n');
  });

  it('commits selected renames and deletions without altering unchecked files', async () => {
    const { root, service, id, run } = await repo();
    await writeFile(path.join(root, 'delete.txt'), 'delete this\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Deletion fixture');
    await git(root, 'mv', 'file.txt', 'renamed.txt'); await rm(path.join(root, 'delete.txt'));
    await writeFile(path.join(root, 'unchecked'), 'untracked\n');
    const changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'Rename and deletion', amend: false, changeIds: changes.filter(change => change.path !== 'unchecked').map(change => change.id) });
    expect(await git(root, 'ls-tree', '--name-only', 'HEAD')).toBe('renamed.txt\n');
    expect(await git(root, 'status', '--porcelain')).toBe('?? unchecked\n');
    expect(await readFile(path.join(root, 'renamed.txt'), 'utf8')).toBe('base\n');
  });

  it('retains a checked recreated rename source regardless of selection order', async () => {
    const { root, service, id, run } = await repo();
    await git(root, 'mv', 'file.txt', 'renamed.txt');
    await writeFile(path.join(root, 'file.txt'), 'new source contents\n');
    const changes = (await service.refreshRepository(id)).changes;
    const renamed = changes.find(change => change.path === 'renamed.txt')!;
    const recreated = changes.find(change => change.group === 'untracked')!;
    await run({ kind: 'commit', message: 'Both paths', amend: false, changeIds: [recreated.id, renamed.id] });
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('new source contents\n');
    expect(await git(root, 'show', 'HEAD:renamed.txt')).toBe('base\n');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  it('sets author/sign-off and blocks whitespace and new TODOs without changing HEAD or the real index', async () => {
    const { root, service, id, run } = await repo();
    const options = { author: 'Other Author <other@example.invalid>', signOff: true, checkWhitespace: true, checkTodo: true };
    const head = await git(root, 'rev-parse', 'HEAD');
    const index = await readFile(path.join(root, '.git/index'));
    await writeFile(path.join(root, 'file.txt'), 'trailing space  \n');
    let changes = (await service.refreshRepository(id)).changes;
    await expect(run({ kind: 'commit', message: 'Blocked whitespace', amend: false, changeIds: changes.map(change => change.id), options })).rejects.toThrow('Whitespace check failed');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head); expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
    await writeFile(path.join(root, 'file.txt'), '++ TODO: finish this\n');
    changes = (await service.refreshRepository(id)).changes;
    await expect(run({ kind: 'commit', message: 'Blocked TODO', amend: false, changeIds: changes.map(change => change.id), options })).rejects.toThrow('TODO check failed');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head); expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
    await run({ kind: 'commit', message: 'Explicitly skip TODO check', amend: false, changeIds: changes.map(change => change.id), options: { ...options, checkTodo: false } });
    expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Other Author <other@example.invalid>\n');
    expect(await git(root, 'log', '-1', '--format=%B')).toContain('Signed-off-by: Test <tests@example.invalid>');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  it('rejects stale selected capabilities, unsupported symlinks, and changed files during capture', async () => {
    const { root, service, id, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'first\n');
    const first = (await service.refreshRepository(id)).changes;
    await writeFile(path.join(root, 'file.txt'), 'second\n');
    await expect(run({ kind: 'commit', message: 'Stale', amend: false, changeIds: first.map(change => change.id) })).rejects.toThrow('changed after review');
    const latest = (await service.refreshRepository(id)).changes;
    const head = await git(root, 'rev-parse', 'HEAD');
    const index = await readFile(path.join(root, '.git/index'));
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let raced = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!raced && Array.isArray(args[1]) && args[1].includes('hash-object')) { raced = true; writeFileSync(path.join(root, 'file.txt'), 'changed during capture\n'); }
      return originalSpawn(...args);
    });
    try { await expect(run({ kind: 'commit', message: 'Race', amend: false, changeIds: latest.map(change => change.id) })).rejects.toThrow('changed after review'); }
    finally { spy.mockImplementation(originalSpawn); }
    expect(raced).toBe(true); expect(await git(root, 'rev-parse', 'HEAD')).toBe(head); expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
    await symlink('file.txt', path.join(root, 'link'));
    const changes = (await service.refreshRepository(id)).changes;
    await expect(run({ kind: 'commit', message: 'Link', amend: false, changeIds: [changes.find(change => change.path === 'link')!.id] })).rejects.toThrow('Symbolic links');
    await expect(readFile(path.join(root, '.git/index.lock'))).rejects.toThrow();
  });

  it('locks the real index during selected commits and rejects a concurrent checkout atomically', async () => {
    const { root, service, id, run } = await repo();
    await git(root, 'branch', 'other');
    await writeFile(path.join(root, 'file.txt'), 'selected\n');
    const changes = (await service.refreshRepository(id)).changes;
    const head = await git(root, 'rev-parse', 'HEAD');
    const index = await readFile(path.join(root, '.git/index'));
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let raced = false;
    let indexWasLocked = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!raced && Array.isArray(args[1]) && args[1].includes('commit-tree')) {
        raced = true;
        try { execFileSync('git', ['add', '--', 'file.txt'], { cwd: root, stdio: 'pipe' }); } catch { indexWasLocked = true; }
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: root });
      }
      return originalSpawn(...args);
    });
    try { await expect(run({ kind: 'commit', message: 'Must not commit the other branch', amend: false, changeIds: changes.map(change => change.id) })).rejects.toThrow(); }
    finally { spy.mockImplementation(originalSpawn); }
    expect(raced).toBe(true); expect(indexWasLocked).toBe(true);
    expect(await git(root, 'rev-parse', 'main')).toBe(head); expect(await git(root, 'rev-parse', 'other')).toBe(head);
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
  });

  it('cannot replace symbolic HEAD when a detached selected commit races an external checkout at the same OID', async () => {
    const { root, service, id, run } = await repo();
    await git(root, 'checkout', '--detach', 'HEAD');
    await writeFile(path.join(root, 'file.txt'), 'selected detached\n');
    const changes = (await service.refreshRepository(id)).changes;
    const head = await git(root, 'rev-parse', 'HEAD');
    const index = await readFile(path.join(root, '.git/index'));
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let raced = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!raced && Array.isArray(args[1]) && args[1].includes('commit-tree')) {
        raced = true;
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root });
      }
      return originalSpawn(...args);
    });
    try { await expect(run({ kind: 'commit', message: 'Detached race', amend: false, changeIds: changes.map(change => change.id) })).rejects.toThrow('checked-out branch changed'); }
    finally { spy.mockImplementation(originalSpawn); }
    expect(raced).toBe(true);
    expect(await git(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main\n');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
  });

  it('supports selected detached commits and amendments, and applies options to legacy staged commits', async () => {
    const { root, service, id, run } = await repo();
    const options = { author: 'Selected Author <selected@example.invalid>', signOff: true, checkWhitespace: true, checkTodo: true };
    await git(root, 'checkout', '--detach', 'HEAD');
    await writeFile(path.join(root, 'file.txt'), 'detached selection\n');
    let changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'Selected detached commit', amend: false, changeIds: changes.map(change => change.id), options });
    await expect(git(root, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    const parents = await git(root, 'log', '-1', '--format=%P');
    await writeFile(path.join(root, 'file.txt'), 'amended selection\n');
    changes = (await service.refreshRepository(id)).changes;
    await run({ kind: 'commit', message: 'Selected amendment', amend: true, changeIds: changes.map(change => change.id) });
    expect(await git(root, 'log', '-1', '--format=%P')).toBe(parents);
    expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Selected Author <selected@example.invalid>\n');
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('amended selection\n');
    await writeFile(path.join(root, 'file.txt'), 'legacy staged\n'); await git(root, 'add', '.');
    await run({ kind: 'commit', message: 'Legacy options', amend: false, options });
    expect(await git(root, 'log', '-1', '--format=%B')).toContain('Signed-off-by: Test <tests@example.invalid>');
    expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Selected Author <selected@example.invalid>\n');
  });

  it('invalidates selected staged capabilities when only the executable mode changes', async () => {
    const { root, service, id, run } = await repo();
    await writeFile(path.join(root, 'file.txt'), 'same blob\n'); await git(root, 'add', '.');
    const previous = (await service.refreshRepository(id)).changes.find(change => change.group === 'staged')!;
    await git(root, 'update-index', '--chmod=+x', '--', 'file.txt');
    await expect(run({ kind: 'commit', message: 'Unreviewed mode', amend: false, changeIds: [previous.id] })).rejects.toThrow('changed after review');
    const current = (await service.refreshRepository(id)).changes.find(change => change.group === 'staged')!;
    expect(current.id).not.toBe(previous.id);
    await run({ kind: 'commit', message: 'Reviewed executable mode', amend: false, changeIds: [current.id] });
    expect(await git(root, 'ls-tree', 'HEAD', '--', 'file.txt')).toMatch(/^100755 blob /);
  });
});
