import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from './git';
import { BranchService } from './branches';

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) => (await exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
async function repository(hasHead = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-working-')); roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  if (hasHead) {
    await writeFile(path.join(root, 'file.txt'), 'head\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture');
  }
  const service = new GitService();
  const snapshot = await service.registerRepository(root);
  const id = snapshot.repository.id;
  const commit = async (changeIds: string[]) => {
    const branches = new BranchService(service);
    return branches.runBranchOperation(id, (await branches.listBranches(id)).token, { kind: 'commit', message: 'Selected working files', amend: false, changeIds });
  };
  return { root, service, id, commit };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('combined working-tree changes', () => {
  it('exposes one editable HEAD-to-working comparison while retaining separate legacy capabilities', async () => {
    const { root, service, id } = await repository();
    await writeFile(path.join(root, 'file.txt'), 'staged\n'); await git(root, 'add', '.');
    await writeFile(path.join(root, 'file.txt'), 'working\n');
    const snapshot = await service.refreshRepository(id);
    expect(snapshot.changes.map(change => change.group)).toEqual(['staged', 'unstaged']);
    expect(snapshot.workingChanges).toHaveLength(1);
    const combined = snapshot.workingChanges![0];
    expect(combined).toMatchObject({ group: 'working', path: 'file.txt', status: 'M' });
    expect(await service.readComparison(id, combined.id)).toMatchObject({ state: 'text', original: { label: 'HEAD', text: 'head\n' }, modified: { label: 'Working tree', text: 'working\n', editable: { id: expect.any(String) } } });
    expect((await service.refreshRepository(id)).workingChanges![0].id).toBe(combined.id);
    await git(root, 'add', '.');
    expect((await service.refreshRepository(id)).workingChanges![0].id).toBe(combined.id);
    await writeFile(path.join(root, 'file.txt'), 'new working\n');
    expect((await service.readComparison(id, combined.id)).state).toBe('stale');
    const refreshed = (await service.refreshRepository(id)).workingChanges![0];
    expect(refreshed.id).not.toBe(combined.id);
    expect((await service.readComparison(id, refreshed.id)).modified?.text).toBe('new working\n');
  });

  it.each([true, false])('keeps staged additions editable, with no fabricated original (HEAD exists: %s)', async hasHead => {
    const { root, service, id } = await repository(hasHead);
    await writeFile(path.join(root, 'added.txt'), 'new\n'); await git(root, 'add', 'added.txt');
    const change = (await service.refreshRepository(id)).workingChanges!.find(item => item.path === 'added.txt')!;
    expect(await service.readComparison(id, change.id)).toMatchObject({ state: 'text', changeType: 'added', original: { text: '' }, modified: { text: 'new\n', editable: { id: expect.any(String) } } });
  });

  it.each([true, false])('shows the real staged addition when it has been deleted from disk (HEAD exists: %s)', async hasHead => {
    const { root, service, id } = await repository(hasHead);
    const filePath = 'migration test 名.go';
    const source = 'package catalog\n\nfunc TestMigration() {}\n';
    await writeFile(path.join(root, filePath), source); await git(root, 'add', '--', filePath);
    await rm(path.join(root, filePath));
    const snapshot = await service.refreshRepository(id);
    expect(snapshot.changes.map(change => change.group)).toEqual(['staged', 'unstaged']);
    expect(snapshot.workingChanges).toHaveLength(1);
    const selected = snapshot.workingChanges![0];
    expect(selected).toMatchObject({ group: 'staged', path: filePath, status: 'A' });
    expect(selected.id).toBe(snapshot.changes.find(change => change.group === 'staged')!.id);
    const comparison = await service.readComparison(id, selected.id);
    expect(comparison).toMatchObject({ state: 'text', changeType: 'added', original: { label: 'HEAD', text: '' }, modified: { label: 'Index', text: source, readOnlyReason: expect.stringContaining('missing from the working tree') } });
    expect(comparison.modified?.editable).toBeUndefined();
    expect((await service.refreshRepository(id)).workingChanges![0].id).toBe(selected.id);
    await expect(readFile(path.join(root, filePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(root, 'show', `:${filePath}`)).toBe(source);
  });

  it('keeps an empty staged addition classified as an added index file', async () => {
    const { root, service, id } = await repository();
    await writeFile(path.join(root, 'empty.txt'), ''); await git(root, 'add', 'empty.txt');
    await rm(path.join(root, 'empty.txt'));
    const selected = (await service.refreshRepository(id)).workingChanges![0];
    expect(selected.group).toBe('staged');
    expect(await service.readComparison(id, selected.id)).toMatchObject({ state: 'text', changeType: 'added', modified: { label: 'Index', text: '' } });
  });

  it('switches back to working content when restored, and rejects obsolete index contents', async () => {
    const { root, service, id } = await repository();
    const file = path.join(root, 'added.txt');
    await writeFile(file, 'staged\n'); await git(root, 'add', 'added.txt'); await rm(file);
    const staged = (await service.refreshRepository(id)).workingChanges![0];
    await writeFile(file, 'restored with edits\n');
    const working = (await service.refreshRepository(id)).workingChanges![0];
    expect(working).toMatchObject({ group: 'working', status: 'A' });
    expect(working.id).not.toBe(staged.id);
    expect(await service.readComparison(id, working.id)).toMatchObject({ state: 'text', changeType: 'added', modified: { label: 'Working tree', text: 'restored with edits\n', editable: { id: expect.any(String) } } });
    await git(root, 'add', 'added.txt'); await rm(file);
    expect((await service.readComparison(id, staged.id)).state).toBe('stale');
    const next = (await service.refreshRepository(id)).workingChanges![0];
    expect(next.id).not.toBe(staged.id);
    expect(await service.readComparison(id, next.id)).toMatchObject({ state: 'text', changeType: 'added', modified: { label: 'Index', text: 'restored with edits\n' } });
  });

  it('commits the reviewed missing addition from the index without restoring it or touching unchecked content', async () => {
    const { root, service, id, commit } = await repository();
    await writeFile(path.join(root, 'missing.txt'), 'staged contents\n');
    await writeFile(path.join(root, 'unchecked.txt'), 'keep staged\n'); await git(root, 'add', '.');
    await rm(path.join(root, 'missing.txt'));
    const selected = (await service.refreshRepository(id)).workingChanges!.find(change => change.path === 'missing.txt')!;
    const captured = await service.captureCommitChanges(id, [selected.id]);
    expect(captured.changes[0]).toMatchObject({ group: 'staged', mode: '100644', oid: expect.any(String) });
    await commit([selected.id]);
    expect(await git(root, 'show', 'HEAD:missing.txt')).toBe('staged contents\n');
    expect(await git(root, 'show', ':missing.txt')).toBe('staged contents\n');
    await expect(readFile(path.join(root, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('unchecked.txt\n');
    expect(await git(root, 'show', ':unchecked.txt')).toBe('keep staged\n');
    const remaining = (await service.refreshRepository(id)).workingChanges!.find(change => change.path === 'missing.txt')!;
    expect(await service.readComparison(id, remaining.id)).toMatchObject({ state: 'text', changeType: 'deleted', original: { text: 'staged contents\n' }, modified: { text: '' } });
  });

  it('combines a staged rename with working edits and preserves deleted endpoints', async () => {
    const { root, service, id } = await repository();
    await writeFile(path.join(root, 'deleted.txt'), 'remove\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Deletion fixture');
    const renamed = 'renamed\t名\n.txt';
    await git(root, 'mv', 'file.txt', renamed); await writeFile(path.join(root, renamed), 'renamed and edited\n');
    await git(root, 'rm', 'deleted.txt');
    const changes = (await service.refreshRepository(id)).workingChanges!;
    expect(changes).toHaveLength(2);
    const rename = changes.find(change => change.path === renamed)!;
    expect(rename).toMatchObject({ oldPath: 'file.txt', status: 'R' });
    expect(await service.readComparison(id, rename.id)).toMatchObject({ state: 'text', changeType: 'modified', original: { text: 'head\n' }, modified: { text: 'renamed and edited\n' } });
    const deletion = changes.find(change => change.path === 'deleted.txt')!;
    expect(await service.readComparison(id, deletion.id)).toMatchObject({ state: 'text', changeType: 'deleted', original: { text: 'remove\n' }, modified: { text: '' } });
  });

  it('merges a staged deletion and untracked recreation into one tracked comparison', async () => {
    const { root, service, id } = await repository();
    await git(root, 'rm', 'file.txt'); await writeFile(path.join(root, 'file.txt'), 'recreated\n');
    const snapshot = await service.refreshRepository(id);
    expect(snapshot.changes).toHaveLength(2);
    expect(snapshot.workingChanges).toHaveLength(1);
    expect(snapshot.workingChanges![0]).toMatchObject({ group: 'working', status: 'M' });
    expect(await service.readComparison(id, snapshot.workingChanges![0].id)).toMatchObject({ state: 'text', changeType: 'modified', original: { text: 'head\n' }, modified: { text: 'recreated\n' } });
  });

  it('commits the selected whole file and leaves unchecked staged files intact', async () => {
    const { root, service, id, commit } = await repository();
    await writeFile(path.join(root, 'file.txt'), 'staged\n'); await writeFile(path.join(root, 'unchecked'), 'keep staged\n'); await git(root, 'add', '.');
    await writeFile(path.join(root, 'file.txt'), 'working\n');
    const selected = (await service.refreshRepository(id)).workingChanges!.find(change => change.path === 'file.txt')!;
    await commit([selected.id]);
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('working\n');
    expect(await git(root, 'show', ':file.txt')).toBe('working\n');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('working\n');
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('unchecked\n');
    expect(await git(root, 'show', ':unchecked')).toBe('keep staged\n');
    await expect(git(root, 'show', 'HEAD:unchecked')).rejects.toThrow();
  });

  it('commits combined renames and recreated staged deletions without leaving staged reversions', async () => {
    const { root, service, id, commit } = await repository();
    await writeFile(path.join(root, 'recreated'), 'old\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Recreation fixture');
    await git(root, 'mv', 'file.txt', 'renamed'); await writeFile(path.join(root, 'renamed'), 'new rename\n');
    await git(root, 'rm', 'recreated'); await writeFile(path.join(root, 'recreated'), 'new recreated\n');
    const changes = (await service.refreshRepository(id)).workingChanges!;
    await commit(changes.map(change => change.id));
    expect(await git(root, 'show', 'HEAD:renamed')).toBe('new rename\n');
    expect(await git(root, 'show', 'HEAD:recreated')).toBe('new recreated\n');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  it('rejects committing a combined capability after its working file changes', async () => {
    const { root, service, id, commit } = await repository();
    await writeFile(path.join(root, 'file.txt'), 'staged\n'); await git(root, 'add', '.');
    const selected = (await service.refreshRepository(id)).workingChanges![0];
    await writeFile(path.join(root, 'file.txt'), 'changed after review\n');
    await expect(commit([selected.id])).rejects.toThrow('changed after review');
    expect(await git(root, 'show', 'HEAD:file.txt')).toBe('head\n');
    expect(await git(root, 'show', ':file.txt')).toBe('staged\n');
  });
});
