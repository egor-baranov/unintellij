import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git';
import { createNativeFileActionsPlatform, FileActionsService, type FileActionsPlatform } from './file-actions';
import type { FileActionTarget } from '../src/bridge';

const exec = promisify(execFile);
const roots: string[] = [];
const fileName = 'src/space 名\ttab\nfile.ts';
async function git(root: string, ...args: string[]) { return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout; }
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-file-actions-'));
  roots.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, fileName), 'committed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'Fixture');
  return root;
}
function platform(): FileActionsPlatform & { open: ReturnType<typeof vi.fn> } {
  return {
    applications: vi.fn(async () => [
      { kind: 'application' as const, name: 'Installed editor', applicationPath: '/Applications/Installed.app', isDefault: true },
      { kind: 'file-manager' as const, name: 'Finder', applicationPath: '/System/Library/CoreServices/Finder.app' },
    ]),
    icon: vi.fn(async () => 'data:image/png;base64,aWNvbg=='),
    open: vi.fn(async () => {}),
  };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('file-item capability actions', () => {
  it('preserves native bundle icons and uses the Electron fallback only for missing icons', async () => {
    const resolveFileActionTarget = vi.fn(async () => ({
      path: 'file.ts', absolutePath: '/repository/file.ts', fingerprint: 'unchanged',
      source: { id: 'source-id', name: 'file.ts', path: 'file.ts', kind: 'file' as const },
    }));
    const native = platform();
    native.applications = async () => [
      { kind: 'file-manager', name: 'Finder', icon: 'data:image/png;base64,bmF0aXZlLWZpbmRlcg==' },
      { kind: 'application', name: 'Native editor', icon: 'data:image/png;base64,bmF0aXZlLWVkaXRvcg==', isDefault: true },
      { kind: 'application', name: 'Fallback editor', applicationPath: '/Applications/Fallback.app' },
    ];
    const actions = new FileActionsService({ resolveFileActionTarget, resolveTreeActionPath: vi.fn(), getRepositoryRoot: vi.fn() }, native);
    const info = await actions.getFileActions('repository-id', { kind: 'project', id: 'source-id' });
    expect(info.applications.map(application => application.icon)).toEqual([
      'data:image/png;base64,bmF0aXZlLWZpbmRlcg==', 'data:image/png;base64,bmF0aXZlLWVkaXRvcg==', 'data:image/png;base64,aWNvbg==',
    ]);
    expect(native.icon).toHaveBeenCalledExactlyOnceWith('/Applications/Fallback.app');
    expect(native.open).not.toHaveBeenCalled();
  });

  it('resolves a nested change into an openable working source without previously listing folders', async () => {
    const root = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const native = platform();
    const actions = new FileActionsService(backend, native);
    const target: FileActionTarget = { kind: 'change', id: snapshot.changes[0].id };
    const info = await actions.getFileActions(snapshot.repository.id, target);
    expect(info.path).toBe(fileName);
    expect(info.absolutePath).toBe(path.join(snapshot.repository.path, fileName));
    expect(info.source).toMatchObject({ path: fileName, kind: 'file' });
    expect(info.applications.map(app => app.name)).toEqual(['Installed editor', 'Finder']);
    expect(info.applications[0]).toMatchObject({ icon: 'data:image/png;base64,aWNvbg==', isDefault: true });
    expect(info.applications[0].id).not.toContain('/Applications');
    expect(native.open).not.toHaveBeenCalled();
    expect((await backend.readProjectFile(snapshot.repository.id, info.source!.id)).content?.text).toBe('working\n');
    await actions.openFileIn(snapshot.repository.id, target, info.applications[0].id);
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.open).toHaveBeenCalledWith(info.absolutePath, expect.objectContaining({ name: 'Installed editor' }));
    const projectInfo = await actions.getFileActions(snapshot.repository.id, { kind: 'project', id: info.source!.id });
    expect(projectInfo.source?.id).toBe(info.source!.id);
  });

  it('keeps deleted paths copyable without creating a source capability or launching applications', async () => {
    const root = await repository();
    await rm(path.join(root, fileName));
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const native = platform();
    const actions = new FileActionsService(backend, native);
    const info = await actions.getFileActions(snapshot.repository.id, { kind: 'change', id: snapshot.changes[0].id });
    expect(info.path).toBe(fileName);
    expect(info.absolutePath).toBe(path.join(snapshot.repository.path, fileName));
    expect(info.source).toBeUndefined();
    expect(info.applications).toEqual([]);
    expect(info.unavailableReason).toContain('does not exist');
    expect(native.applications).not.toHaveBeenCalled();
    expect(native.open).not.toHaveBeenCalled();
  });

  it('copies only capability-resolved paths, preserving unusual and deleted names', async () => {
    const root = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    let snapshot = await backend.registerRepository(root);
    const clipboard = vi.fn();
    const native = platform();
    const actions = new FileActionsService(backend, native, clipboard);
    let target: FileActionTarget = { kind: 'change', id: snapshot.changes[0].id };
    await actions.copyFilePath(snapshot.repository.id, target, 'relative');
    expect(clipboard).toHaveBeenLastCalledWith(fileName);
    await actions.copyFilePath(snapshot.repository.id, target, 'absolute');
    expect(clipboard).toHaveBeenLastCalledWith(path.join(snapshot.repository.path, fileName));
    const source = (await backend.resolveFileActionTarget(snapshot.repository.id, target)).source!;
    await actions.copyFilePath(snapshot.repository.id, { kind: 'project', id: source.id }, 'relative');
    expect(clipboard).toHaveBeenLastCalledWith(fileName);
    await rm(path.join(root, fileName));
    snapshot = await backend.refreshRepository(snapshot.repository.id);
    target = { kind: 'change', id: snapshot.changes[0].id };
    await actions.copyFilePath(snapshot.repository.id, target, 'absolute');
    expect(clipboard).toHaveBeenLastCalledWith(path.join(snapshot.repository.path, fileName));
    expect(native.applications).not.toHaveBeenCalled();
    expect(native.open).not.toHaveBeenCalled();
  });

  it('rejects arbitrary clipboard formats, raw targets, and foreign capabilities', async () => {
    const root = await repository();
    const other = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const otherSnapshot = await backend.registerRepository(other);
    const clipboard = vi.fn();
    const actions = new FileActionsService(backend, platform(), clipboard);
    const target: FileActionTarget = { kind: 'change', id: snapshot.changes[0].id };
    await expect(actions.copyFilePath(snapshot.repository.id, target, 'arbitrary text' as 'absolute')).rejects.toThrow('Invalid file path format');
    for (const id of ['../secret', '/etc/hosts', fileName]) await expect(actions.copyFilePath(snapshot.repository.id, { kind: 'project', id }, 'absolute')).rejects.toThrow('Unknown project entry');
    await expect(actions.copyFilePath(otherSnapshot.repository.id, target, 'absolute')).rejects.toThrow('no longer current');
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('copies root, Project folders, and Commit folders through the native clipboard without app discovery', async () => {
    const root = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root), id = snapshot.repository.id;
    const native = platform(), clipboard = vi.fn();
    const actions = new FileActionsService(backend, native, clipboard);
    await actions.copyFilePath(id, { kind: 'project', id: null }, 'absolute');
    expect(clipboard).toHaveBeenLastCalledWith(snapshot.repository.path);
    await actions.copyFilePath(id, { kind: 'project', id: null }, 'relative');
    expect(clipboard).toHaveBeenLastCalledWith('.');
    const sourceFolder = (await backend.listProjectDirectory(id, null)).entries.find(entry => entry.name === 'src')!;
    await actions.copyFilePath(id, { kind: 'project', id: sourceFolder.id }, 'absolute');
    expect(clipboard).toHaveBeenLastCalledWith(path.join(snapshot.repository.path, 'src'));
    await actions.copyFilePath(id, { kind: 'change-directory', changeId: snapshot.changes[0].id, path: 'src' }, 'relative');
    expect(clipboard).toHaveBeenLastCalledWith('src');
    expect(native.applications).not.toHaveBeenCalled();
    expect(native.open).not.toHaveBeenCalled();
    clipboard.mockClear();
    for (const folder of ['elsewhere', '..', 'src/..', '', '/tmp', fileName]) {
      await expect(actions.copyFilePath(id, { kind: 'change-directory', changeId: snapshot.changes[0].id, path: folder }, 'absolute')).rejects.toThrow('not an ancestor');
    }
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('jumps to the new working path of a staged rename, not its historical blob', async () => {
    const root = await repository();
    const renamed = 'src/new name.ts';
    await rename(path.join(root, fileName), path.join(root, renamed));
    await git(root, 'add', '-A');
    await writeFile(path.join(root, renamed), 'after rename\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const actions = new FileActionsService(backend, platform());
    const staged = snapshot.changes.find(change => change.group === 'staged')!;
    const info = await actions.getFileActions(snapshot.repository.id, { kind: 'change', id: staged.id });
    expect(staged.oldPath).toBe(fileName);
    expect(info.path).toBe(renamed);
    expect((await backend.readProjectFile(snapshot.repository.id, info.source!.id)).content?.text).toBe('after rename\n');
  });

  it('rejects raw paths, foreign targets, stale change IDs, and arbitrary application IDs', async () => {
    const root = await repository();
    const other = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const otherSnapshot = await backend.registerRepository(other);
    const native = platform();
    const actions = new FileActionsService(backend, native);
    const id = snapshot.repository.id;
    const target: FileActionTarget = { kind: 'change', id: snapshot.changes[0].id };
    const info = await actions.getFileActions(id, target);
    for (const id of ['../secret', '/etc/hosts', '.git/index', fileName]) await expect(actions.getFileActions(snapshot.repository.id, { kind: 'project', id })).rejects.toThrow('Unknown project entry');
    await expect(actions.getFileActions(otherSnapshot.repository.id, target)).rejects.toThrow('no longer current');
    await expect(actions.openFileIn(id, target, '/Applications/Arbitrary.app')).rejects.toThrow('no longer available');
    await expect(actions.openFileIn(otherSnapshot.repository.id, target, info.applications[0].id)).rejects.toThrow('no longer available');
    await expect(actions.openFileIn(id, { kind: 'project', id: info.source!.id }, info.applications[0].id)).rejects.toThrow('no longer available');
    // Identical refreshes preserve issued targets; a real endpoint change revokes them.
    await backend.refreshRepository(id);
    expect((await actions.getFileActions(id, target)).path).toBe(fileName);
    await writeFile(path.join(root, fileName), 'changed comparison contents\n');
    await backend.refreshRepository(id);
    await expect(actions.getFileActions(id, target)).rejects.toThrow('no longer current');
    await expect(actions.openFileIn(id, target, info.applications[0].id)).rejects.toThrow('no longer current');
    expect(native.open).not.toHaveBeenCalled();
  });

  it('refuses changed, removed, or symlink-escaped files after a menu was loaded', async () => {
    const root = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-file-action-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, path.basename(fileName)), 'outside\n');
    const backend = new GitService();
    let snapshot = await backend.registerRepository(root);
    const native = platform();
    const actions = new FileActionsService(backend, native);
    let target: FileActionTarget = { kind: 'change', id: snapshot.changes[0].id };
    let info = await actions.getFileActions(snapshot.repository.id, target);
    await writeFile(path.join(root, fileName), 'external modification\n');
    await expect(actions.openFileIn(snapshot.repository.id, target, info.applications[0].id)).rejects.toThrow('changed');
    snapshot = await backend.refreshRepository(snapshot.repository.id);
    target = { kind: 'change', id: snapshot.changes[0].id };
    info = await actions.getFileActions(snapshot.repository.id, target);
    await rename(path.join(root, 'src'), path.join(root, 'old-src'));
    await symlink(outside, path.join(root, 'src'));
    await expect(actions.openFileIn(snapshot.repository.id, target, info.applications[0].id)).rejects.toThrow(/Symbolic|symbolic/);
    expect((await actions.getFileActions(snapshot.repository.id, target)).applications).toEqual([]);
    expect(await readFile(path.join(outside, path.basename(fileName)), 'utf8')).toBe('outside\n');
    expect(native.open).not.toHaveBeenCalled();
  });

  it('does not issue launch capabilities when a file disappears during discovery', async () => {
    const root = await repository();
    await writeFile(path.join(root, fileName), 'working\n');
    const backend = new GitService();
    const snapshot = await backend.registerRepository(root);
    const native = platform();
    native.applications = async () => { await rm(path.join(root, fileName)); return [{ kind: 'default', name: 'Default application' }]; };
    const actions = new FileActionsService(backend, native);
    const info = await actions.getFileActions(snapshot.repository.id, { kind: 'change', id: snapshot.changes[0].id });
    expect(info.source).toBeUndefined();
    expect(info.applications).toEqual([]);
    expect(info.unavailableReason).toContain('does not exist');
    expect(native.open).not.toHaveBeenCalled();
  });

  it('offers graceful default/file-manager fallbacks without performing actions during discovery', async () => {
    const openDefault = vi.fn(async () => '');
    const reveal = vi.fn();
    const native = createNativeFileActionsPlatform({ platform: 'linux', getFileIcon: async () => undefined, openDefault, reveal });
    const handlers = await native.applications('/tmp/example.ts');
    expect(handlers.map(handler => handler.name)).toEqual(['Default application', 'File manager']);
    expect(openDefault).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await native.open('/tmp/example.ts', handlers[0]);
    expect(openDefault).toHaveBeenCalledWith('/tmp/example.ts');
    await native.open('/tmp/example.ts', handlers[1]);
    expect(reveal).toHaveBeenCalledWith('/tmp/example.ts');
    openDefault.mockResolvedValue('No associated application');
    await expect(native.open('/tmp/example.ts', handlers[0])).rejects.toThrow('No associated application');
  });
});
