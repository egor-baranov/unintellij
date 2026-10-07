import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectEntry, TreeActionTarget } from '../src/bridge';
import { GitService } from './git';
import { TreeActionsService, validateTreeAction, validateTreeActionTarget } from './tree-actions';

const execute = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) => (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout;
const rootTarget: TreeActionTarget = { kind: 'project', id: null };
async function fixture(files: Record<string, string> = { 'file.txt': 'original\n' }, gitAvailable = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-tree-actions-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  if (gitAvailable) {
    await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture');
  }
  const service = new GitService(), actions = new TreeActionsService(service);
  const snapshot = await service.registerRepository(root), id = snapshot.repository.id;
  const target = async (filePath: string): Promise<TreeActionTarget> => {
    let parent: string | null = null;
    for (const name of filePath.split('/')) {
      const found: ProjectEntry | undefined = (await service.listProjectDirectory(id, parent)).entries.find(entry => entry.name === name);
      if (!found) throw new Error(`Fixture entry missing: ${filePath}`);
      parent = found.id;
    }
    return { kind: 'project', id: parent };
  };
  return { root, service, actions, id, target };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('tree action capabilities and filesystem operations', () => {
  it('creates exclusive files and folders at the root, in a folder, and beside a file', async () => {
    const f = await fixture({ 'src/file.txt': 'original\n' });
    const file = await f.actions.performTreeAction(f.id, rootTarget, { kind: 'create-file', name: 'new [名].txt' });
    expect(file.entry).toMatchObject({ kind: 'file', path: 'new [名].txt' });
    expect(await readFile(path.join(f.root, file.path), 'utf8')).toBe('');
    const folder = await f.actions.performTreeAction(f.id, await f.target('src'), { kind: 'create-directory', name: 'new folder' });
    expect(folder.entry).toMatchObject({ kind: 'directory', path: 'src/new folder' });
    const sibling = await f.actions.performTreeAction(f.id, await f.target('src/file.txt'), { kind: 'create-file', name: 'sibling.ts' });
    expect(sibling.path).toBe('src/sibling.ts');
    await expect(f.actions.performTreeAction(f.id, await f.target('src'), { kind: 'create-file', name: 'file.txt' })).rejects.toThrow('already exists');
    expect(await readFile(path.join(f.root, 'src/file.txt'), 'utf8')).toBe('original\n');
    expect((await f.service.listChanges(f.id)).changes.some(change => change.path === 'src/sibling.ts')).toBe(true);
  });

  it('renames a file without staging it, retains its capability, and rejects existing destinations', async () => {
    const f = await fixture({ 'one [名].txt': 'original\n', 'other.txt': 'other\n' });
    const target = await f.target('one [名].txt');
    const index = await git(f.root, 'ls-files', '--stage');
    const result = await f.actions.performTreeAction(f.id, target, { kind: 'rename', name: 'renamed $() [名].txt' });
    expect(result).toMatchObject({ previousPath: 'one [名].txt', path: 'renamed $() [名].txt', remap: { from: 'one [名].txt', to: 'renamed $() [名].txt', directory: false }, entry: { id: target.kind === 'project' ? target.id : '' } });
    expect(await git(f.root, 'ls-files', '--stage')).toBe(index);
    expect((await f.actions.getTreeActions(f.id, target)).path).toBe(result.path);
    expect(await readFile(path.join(f.root, result.path), 'utf8')).toBe('original\n');
    await expect(f.actions.performTreeAction(f.id, target, { kind: 'rename', name: 'other.txt' })).rejects.toThrow('already exists');
    expect(await readFile(path.join(f.root, 'other.txt'), 'utf8')).toBe('other\n');
  });

  it('renames folders and remaps issued descendant capabilities', async () => {
    const f = await fixture({ 'src/deep/file.txt': 'content\n' });
    const child = await f.target('src/deep/file.txt');
    const result = await f.actions.performTreeAction(f.id, await f.target('src'), { kind: 'rename', name: 'renamed' });
    expect(result.remap).toEqual({ from: 'src', to: 'renamed', directory: true });
    expect((await f.actions.getTreeActions(f.id, child)).path).toBe('renamed/deep/file.txt');
    expect(await readFile(path.join(f.root, 'renamed/deep/file.txt'), 'utf8')).toBe('content\n');
  });

  it('allows creation and rename in a non-Git project but disables index actions', async () => {
    const f = await fixture(undefined, false);
    expect(await f.actions.getTreeActions(f.id, rootTarget)).toMatchObject({ canCreate: true, canRename: false, canAdd: false, canRemove: false });
    await f.actions.performTreeAction(f.id, rootTarget, { kind: 'create-directory', name: 'folder' });
    await f.actions.performTreeAction(f.id, await f.target('file.txt'), { kind: 'rename', name: 'renamed.txt' });
    expect(await readFile(path.join(f.root, 'renamed.txt'), 'utf8')).toBe('original\n');
    await expect(f.actions.performTreeAction(f.id, rootTarget, { kind: 'add' })).rejects.toThrow('no Git repository');
  });

  it('rejects forged, cross-repository, non-ancestor, and unsafe name inputs', async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.actions.getTreeActions(f.id, await other.target('file.txt'))).rejects.toThrow('Unknown project entry');
    await expect(f.actions.getTreeActions(f.id, { kind: 'project', id: '../file.txt' })).rejects.toThrow('Unknown project entry');
    for (const name of ['', ' ', '..', '.git', '.GIT', '../outside', '/tmp/outside', 'a/b', 'a\\b', 'a\0b']) expect(() => validateTreeAction({ kind: 'rename', name })).toThrow();
    expect(() => validateTreeActionTarget({ kind: 'directory', path: '.' })).toThrow();
    await writeFile(path.join(f.root, 'file.txt'), 'changed\n');
    const snapshot = await f.service.refreshRepository(f.id), change = snapshot.workingChanges!.find(item => item.path === 'file.txt')!;
    await expect(f.actions.getTreeActions(f.id, { kind: 'change-directory', changeId: change.id, path: '..' })).rejects.toThrow('not an ancestor');
    await expect(f.actions.performTreeAction(f.id, rootTarget, { kind: 'rename', name: 'newroot' })).rejects.toThrow('root cannot');
  });
});

describe('tree index actions', () => {
  const groupTarget = async (f: Awaited<ReturnType<typeof fixture>>, group: 'working' | 'untracked'): Promise<TreeActionTarget> => ({
    kind: 'change-group', changeIds: (await f.service.refreshRepository(f.id)).workingChanges!.filter(change => change.group === group).map(change => change.id),
  });

  it('adds an unversioned group by exact capabilities without staging tracked or ignored files', async () => {
    const f = await fixture({ '.gitignore': '*.ignore\n', 'tracked.txt': 'original\n' });
    await writeFile(path.join(f.root, 'tracked.txt'), 'modified\n');
    await writeFile(path.join(f.root, 'new [名] $.txt'), 'new\n');
    await mkdir(path.join(f.root, 'dir'));
    await writeFile(path.join(f.root, 'dir/second.txt'), 'second\n');
    await writeFile(path.join(f.root, 'secret.ignore'), 'ignored\n');
    const target = await groupTarget(f, 'untracked');
    expect(await f.actions.getTreeActions(f.id, target)).toMatchObject({ kind: 'group', label: 'Unversioned Files', fileCount: 2, addFileCount: 2, removeFileCount: 0, canAdd: true, canRemove: false, canRename: false, canCreate: false });
    await f.actions.performTreeAction(f.id, target, { kind: 'add' });
    expect((await git(f.root, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean)).toEqual(['dir/second.txt', 'new [名] $.txt']);
    expect(await git(f.root, 'show', ':tracked.txt')).toBe('original\n');
    expect(await git(f.root, 'ls-files', '--', 'secret.ignore')).toBe('');
  });

  it('adds the Changes group without widening to unversioned or unchanged files', async () => {
    const f = await fixture({ 'changed.txt': 'old\n', 'deleted.txt': 'gone\n', 'clean.txt': 'same\n' });
    await writeFile(path.join(f.root, 'changed.txt'), 'new\n');
    await rm(path.join(f.root, 'deleted.txt'));
    await writeFile(path.join(f.root, 'untracked.txt'), 'untracked\n');
    await writeFile(path.join(f.root, 'staged.txt'), 'staged\n');
    await git(f.root, 'add', '--', 'staged.txt');
    const target = await groupTarget(f, 'working');
    expect(await f.actions.getTreeActions(f.id, target)).toMatchObject({ label: 'Changes', fileCount: 3, addFileCount: 2, removeFileCount: 3 });
    await f.actions.performTreeAction(f.id, target, { kind: 'add' });
    expect(await git(f.root, 'diff', '--cached', '--name-status')).toBe('M\tchanged.txt\nD\tdeleted.txt\nA\tstaged.txt\n');
    expect(await git(f.root, 'ls-files', '--', 'untracked.txt')).toBe('');
    expect(await git(f.root, 'show', ':clean.txt')).toBe('same\n');
  });

  it('removes only indexed Changes members and preserves their working files', async () => {
    const f = await fixture({ 'modified.txt': 'old\n', 'deleted.txt': 'gone\n', 'clean.txt': 'same\n' });
    await writeFile(path.join(f.root, 'modified.txt'), 'new\n');
    await rm(path.join(f.root, 'deleted.txt'));
    await git(f.root, 'add', '--', 'deleted.txt');
    await writeFile(path.join(f.root, 'untracked.txt'), 'untracked\n');
    await writeFile(path.join(f.root, 'staged.txt'), 'staged\n');
    await git(f.root, 'add', '--', 'staged.txt');
    const target = await groupTarget(f, 'working');
    expect(await f.actions.getTreeActions(f.id, target)).toMatchObject({ fileCount: 3, removeFileCount: 2 });
    await f.actions.performTreeAction(f.id, target, { kind: 'remove' });
    expect(await git(f.root, 'ls-files')).toBe('clean.txt\n');
    expect(await readFile(path.join(f.root, 'modified.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(f.root, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(await readFile(path.join(f.root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it('aborts the whole group when any captured capability becomes stale while queued', async () => {
    const f = await fixture({ 'a.txt': 'old\n', 'b.txt': 'old\n' });
    await writeFile(path.join(f.root, 'a.txt'), 'new\n');
    await writeFile(path.join(f.root, 'b.txt'), 'new\n');
    const target = await groupTarget(f, 'working');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preceding = f.service.serializeRepositoryOperation(f.id, () => gate);
    const pending = f.actions.performTreeAction(f.id, target, { kind: 'add' });
    const rejected = expect(pending).rejects.toThrow('no longer current');
    await writeFile(path.join(f.root, 'b.txt'), 'changed again\n');
    release(); await preceding; await rejected;
    expect(await git(f.root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('keeps Git safety checks atomic when one group member has divergent staged contents', async () => {
    const f = await fixture({ 'a.txt': 'old\n', 'b.txt': 'old\n' });
    await writeFile(path.join(f.root, 'a.txt'), 'new\n');
    await writeFile(path.join(f.root, 'b.txt'), 'index contents\n');
    await git(f.root, 'add', '--', 'b.txt');
    await writeFile(path.join(f.root, 'b.txt'), 'working contents\n');
    const target = await groupTarget(f, 'working');
    const index = await git(f.root, 'ls-files', '--stage');
    await expect(f.actions.performTreeAction(f.id, target, { kind: 'remove' })).rejects.toThrow();
    expect(await git(f.root, 'ls-files', '--stage')).toBe(index);
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(f.root, 'b.txt'), 'utf8')).toBe('working contents\n');
  });

  it('rejects forged, mixed, cross-repository, and non-Git group targets', async () => {
    const f = await fixture(), other = await fixture(), noGit = await fixture(undefined, false);
    await writeFile(path.join(f.root, 'file.txt'), 'new\n');
    await writeFile(path.join(f.root, 'new.txt'), 'new\n');
    await writeFile(path.join(other.root, 'new.txt'), 'new\n');
    const target = { kind: 'change-group' as const, changeIds: (await f.service.refreshRepository(f.id)).workingChanges!.map(change => change.id) };
    await expect(f.actions.getTreeActions(f.id, target)).rejects.toThrow('separately');
    const otherTarget = await groupTarget(other, 'untracked');
    await expect(f.actions.performTreeAction(f.id, otherTarget, { kind: 'add' })).rejects.toThrow('no longer current');
    await expect(noGit.actions.getTreeActions(noGit.id, otherTarget)).rejects.toThrow('no Git repository');
    for (const changeIds of [[], ['a', 'a'], [''], ['a\0b'], [true], 'a', Array.from({ length: 10001 }, (_, i) => String(i))]) {
      expect(() => validateTreeActionTarget({ kind: 'change-group', changeIds })).toThrow();
    }
    await expect(f.actions.getTreeActions(f.id, { kind: 'change-group', changeIds: ['../file.txt'] })).rejects.toThrow('no longer current');
    expect(await git(f.root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('excludes unsupported group members and cannot use a group as a filesystem target', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'new.txt'), 'new\n');
    await symlink('file.txt', path.join(f.root, 'link'));
    const target = await groupTarget(f, 'untracked');
    expect(await f.actions.getTreeActions(f.id, target)).toMatchObject({ fileCount: 2, addFileCount: 1 });
    await expect(f.actions.performTreeAction(f.id, target, { kind: 'rename', name: 'renamed' })).rejects.toThrow('Choose a file');
    await expect(f.actions.performTreeAction(f.id, target, { kind: 'create-file', name: 'created' })).rejects.toThrow('Choose a project directory');
    await f.actions.performTreeAction(f.id, target, { kind: 'add' });
    expect(await git(f.root, 'diff', '--cached', '--name-only')).toBe('new.txt\n');
    expect(await git(f.root, 'ls-files', '--', 'link')).toBe('');
  });

  it('does not resolve conflicts as a side effect of adding other Changes members', async () => {
    const f = await fixture({ 'conflict.txt': 'base\n', 'other.txt': 'original\n' });
    await git(f.root, 'checkout', '-b', 'side');
    await writeFile(path.join(f.root, 'conflict.txt'), 'side\n');
    await git(f.root, 'commit', '-am', 'Side');
    await git(f.root, 'checkout', 'main');
    await writeFile(path.join(f.root, 'conflict.txt'), 'main\n');
    await git(f.root, 'commit', '-am', 'Main');
    await expect(git(f.root, 'merge', 'side')).rejects.toThrow();
    await writeFile(path.join(f.root, 'other.txt'), 'changed\n');
    const target = await groupTarget(f, 'working');
    expect(await f.actions.getTreeActions(f.id, target)).toMatchObject({ fileCount: 2, addFileCount: 1, removeFileCount: 1 });
    const conflict = await git(f.root, 'ls-files', '--unmerged');
    await f.actions.performTreeAction(f.id, target, { kind: 'add' });
    expect(await git(f.root, 'ls-files', '--unmerged')).toBe(conflict);
    expect(await git(f.root, 'show', ':other.txt')).toBe('changed\n');
  });

  it('adds only selected literal paths and respects ignored descendants', async () => {
    const f = await fixture({ '.gitignore': '*.ignore\n', 'dir [1]/changed.txt': 'original\n', 'dir [1]/deleted.txt': 'delete me\n', 'other.txt': 'original\n' });
    await writeFile(path.join(f.root, 'dir [1]/changed.txt'), 'changed\n');
    await rm(path.join(f.root, 'dir [1]/deleted.txt'));
    await writeFile(path.join(f.root, 'dir [1]/new [名].txt'), 'new\n');
    await writeFile(path.join(f.root, 'dir [1]/secret.ignore'), 'ignored\n');
    await writeFile(path.join(f.root, 'other.txt'), 'outside change\n');
    await f.service.refreshRepository(f.id);
    await f.actions.performTreeAction(f.id, await f.target('dir [1]'), { kind: 'add' });
    expect((await git(f.root, 'diff', '--cached', '--name-only')).trim().split('\n')).toHaveLength(3);
    expect(await git(f.root, 'show', ':dir [1]/changed.txt')).toBe('changed\n');
    expect(await git(f.root, 'show', ':dir [1]/new [名].txt')).toBe('new\n');
    expect(await git(f.root, 'show', ':other.txt')).toBe('original\n');
    expect(await git(f.root, 'ls-files', '--', ':(literal)dir [1]/secret.ignore')).toBe('');
    const ignored = await f.target('dir [1]/secret.ignore');
    expect(await f.actions.getTreeActions(f.id, ignored)).toMatchObject({ canAdd: false, canCreate: true, canRename: true });
    await expect(f.actions.performTreeAction(f.id, ignored, { kind: 'add' })).rejects.toThrow('ignored by Git');
  });

  it('removes tracked folder contents from the index while keeping every disk file unchanged', async () => {
    const f = await fixture({ 'src/a.txt': 'a\n', 'src/deep/b.txt': 'b\n', 'other.txt': 'other\n' });
    await f.actions.performTreeAction(f.id, await f.target('src'), { kind: 'remove' });
    expect(await git(f.root, 'ls-files')).toBe('other.txt\n');
    expect(await readFile(path.join(f.root, 'src/a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(path.join(f.root, 'src/deep/b.txt'), 'utf8')).toBe('b\n');
    expect(await git(f.root, 'diff', '--cached', '--name-status')).toBe('D\tsrc/a.txt\nD\tsrc/deep/b.txt\n');
    expect((await f.service.listChanges(f.id)).changes.some(item => item.group === 'untracked' && item.path === 'src/a.txt')).toBe(true);
    expect((await f.actions.getTreeActions(f.id, await f.target('src'))).canRemove).toBe(false);
  });

  it('rejects removing divergent staged content and leaves the index and disk intact', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'file.txt'), 'staged only\n'); await git(f.root, 'add', 'file.txt');
    await writeFile(path.join(f.root, 'file.txt'), 'working only\n'); await f.service.refreshRepository(f.id);
    await expect(f.actions.performTreeAction(f.id, await f.target('file.txt'), { kind: 'remove' })).rejects.toThrow();
    expect(await git(f.root, 'show', ':file.txt')).toBe('staged only\n');
    expect(await readFile(path.join(f.root, 'file.txt'), 'utf8')).toBe('working only\n');
  });

  it('keeps split-index repositories readable after Add and Remove', async () => {
    const f = await fixture({ 'file.txt': 'original\n', 'kept.txt': 'keep\n' });
    await git(f.root, 'update-index', '--split-index');
    await writeFile(path.join(f.root, 'file.txt'), 'changed\n');
    await f.service.refreshRepository(f.id);
    await f.actions.performTreeAction(f.id, await f.target('file.txt'), { kind: 'add' });
    expect(await git(f.root, 'show', ':file.txt')).toBe('changed\n');
    expect(await git(f.root, 'show', ':kept.txt')).toBe('keep\n');
    await f.actions.performTreeAction(f.id, await f.target('kept.txt'), { kind: 'remove' });
    expect(await git(f.root, 'ls-files')).toBe('file.txt\n');
  });

  it('authorizes change file and directory witnesses, including deleted parent directories', async () => {
    const f = await fixture({ 'src/deep/file.txt': 'original\n' });
    await writeFile(path.join(f.root, 'src/deep/file.txt'), 'changed\n');
    let snapshot = await f.service.refreshRepository(f.id), change = snapshot.workingChanges![0];
    const directory: TreeActionTarget = { kind: 'change-directory', changeId: change.id, path: 'src/deep' };
    expect(await f.actions.getTreeActions(f.id, directory)).toMatchObject({ path: 'src/deep', kind: 'directory', canAdd: true });
    await f.actions.performTreeAction(f.id, directory, { kind: 'add' });
    await rm(path.join(f.root, 'src'), { recursive: true });
    snapshot = await f.service.refreshRepository(f.id); change = snapshot.workingChanges![0];
    expect(await f.actions.getTreeActions(f.id, { kind: 'change', id: change.id })).toMatchObject({ kind: 'missing', canAdd: true, canCreate: false });
    await f.actions.performTreeAction(f.id, { kind: 'change', id: change.id }, { kind: 'add' });
    expect(await git(f.root, 'ls-files')).toBe('');
  });

  it('rejects symbolic links and nested repositories without partially staging a folder', async () => {
    const f = await fixture({ 'folder/a.txt': 'a\n' });
    await writeFile(path.join(f.root, 'folder/a.txt'), 'changed\n');
    await symlink('../file.txt', path.join(f.root, 'folder/link'));
    await f.service.refreshRepository(f.id);
    const link = await f.target('folder/link');
    expect(await f.actions.getTreeActions(f.id, link)).toMatchObject({ canAdd: false, canRename: false, canCreate: false });
    await expect(f.actions.performTreeAction(f.id, await f.target('folder'), { kind: 'add' })).rejects.toThrow('symbolic links');
    expect(await git(f.root, 'diff', '--cached', '--name-only')).toBe('');
    await mkdir(path.join(f.root, 'nested')); await git(path.join(f.root, 'nested'), 'init', '-b', 'main');
    await expect(f.actions.getTreeActions(f.id, await f.target('nested'))).rejects.toThrow('nested repository');
  });

  it('never executes configured content filters or hooks during an Add operation', async () => {
    const f = await fixture();
    const marker = path.join(f.root, 'executed');
    await writeFile(path.join(f.root, 'file.txt'), 'changed\n');
    await git(f.root, 'config', 'filter.danger.clean', `touch '${marker}'`);
    await writeFile(path.join(f.root, '.gitattributes'), '*.txt filter=danger\n');
    await f.service.refreshRepository(f.id);
    await expect(f.actions.performTreeAction(f.id, await f.target('file.txt'), { kind: 'add' })).rejects.toThrow('content filters');
    await expect(readFile(marker)).rejects.toThrow();
    await git(f.root, 'config', '--remove-section', 'filter.danger');
    await writeFile(path.join(f.root, '.git/hooks/post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await f.actions.performTreeAction(f.id, await f.target('file.txt'), { kind: 'add' });
    expect(await git(f.root, 'show', ':file.txt')).toBe('changed\n');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('shares a queue across repository operations and continues after a failed operation', async () => {
    const f = await fixture();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = f.service.serializeRepositoryOperation(f.id, async () => { seen.push('first'); await gate; throw new Error('fixture failure'); });
    const failure = expect(first).rejects.toThrow('fixture failure');
    const second = f.actions.performTreeAction(f.id, rootTarget, { kind: 'create-file', name: 'later.txt' }).then(() => seen.push('second'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual(['first']);
    release(); await failure; await second;
    expect(seen).toEqual(['first', 'second']);
  });
});
