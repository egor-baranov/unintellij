import { execFile } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TreeAction, TreeActionResult, TreeActionsInfo, TreeActionTarget } from '../src/bridge';
import { GitService, runGit, safeRepositoryPath, safeWorkingGit } from './git';

const execute = promisify(execFile);
const LIMIT = 10000;
const decode = (buffer: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
const parentPath = (value: string) => { const parent = path.posix.dirname(value); return parent === '.' ? '' : parent; };
const pathspec = (value: string) => `:(top,literal)${value || '.'}`;
const childPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;

export function validateTreeActionTarget(value: unknown): TreeActionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tree action target.');
  const target = value as Record<string, unknown>;
  const id = (item: unknown) => { if (typeof item !== 'string' || !item || item.length > 128 || item.includes('\0')) throw new Error('Invalid tree capability.'); return item; };
  if (target.kind === 'project') return { kind: 'project', id: target.id === null ? null : id(target.id) };
  if (target.kind === 'change') return { kind: 'change', id: id(target.id) };
  if (target.kind === 'change-group') {
    if (!Array.isArray(target.changeIds) || !target.changeIds.length || target.changeIds.length > LIMIT) throw new Error('Choose between 1 and 10,000 changed files.');
    const changeIds = target.changeIds.map(id);
    if (new Set(changeIds).size !== changeIds.length) throw new Error('Duplicate change capabilities are not allowed.');
    return { kind: 'change-group', changeIds };
  }
  if (target.kind === 'change-directory' && typeof target.path === 'string' && target.path.length <= 32768 && !target.path.includes('\0')) return { kind: 'change-directory', changeId: id(target.changeId), path: target.path };
  throw new Error('Invalid tree action target.');
}
export function validateTreeAction(value: unknown): TreeAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tree action.');
  const action = value as Record<string, unknown>;
  if (action.kind === 'add' || action.kind === 'remove') return { kind: action.kind };
  if (!['rename', 'create-file', 'create-directory'].includes(String(action.kind))) throw new Error('Unsupported tree action.');
  if (typeof action.name !== 'string' || !action.name.trim() || Buffer.byteLength(action.name, 'utf8') > 255 || /[\0-\x1f\x7f/\\]/.test(action.name) || ['.', '..', '.git'].includes(action.name.toLowerCase())) throw new Error('Enter a single file or folder name without path separators.');
  return { kind: action.kind as 'rename' | 'create-file' | 'create-directory', name: action.name };
}

// NSFileManager's move operation refuses an existing destination for files and
// directories. Paths are argv values, never interpolated into executable text.
const macMove = `ObjC.import('Foundation'); function run(argv) { var error = Ref(); if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(argv[0], argv[1], error)) throw new Error(ObjC.unwrap(error[0].localizedDescription)); }`;
async function moveWithoutOverwrite(source: string, destination: string): Promise<void> {
  if (process.platform === 'darwin') await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macMove, '--', source, destination], { shell: false, timeout: 15000, maxBuffer: 65536 });
  else if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; if ([System.IO.Directory]::Exists($env:SMART_DIFF_MOVE_FROM)) { [System.IO.Directory]::Move($env:SMART_DIFF_MOVE_FROM,$env:SMART_DIFF_MOVE_TO) } else { [System.IO.File]::Move($env:SMART_DIFF_MOVE_FROM,$env:SMART_DIFF_MOVE_TO) }";
    await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { shell: false, timeout: 15000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, SMART_DIFF_MOVE_FROM: source, SMART_DIFF_MOVE_TO: destination } });
  } else {
    await execute('/bin/mv', ['--no-clobber', '--no-target-directory', '--', source, destination], { shell: false, timeout: 15000, maxBuffer: 65536 });
    // GNU mv --no-clobber can exit successfully without moving the source.
    try { await lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('The destination already exists. Choose another name.');
  }
}

/** All public operations authorize a tree capability independently of Open In discovery. */
export class TreeActionsService {
  constructor(private readonly git: GitService) {}

  private async listed(id: string, relative: string, options: string[]): Promise<string[]> {
    const output = await runGit(this.git.getRepositoryRoot(id), ['ls-files', ...options, '-z', '--', pathspec(relative)], 16 * 1024 * 1024);
    const paths = [...new Set(decode(output).split('\0').filter(Boolean))];
    if (paths.length > LIMIT) throw new Error('This action contains more than 10,000 files. Select a smaller folder.');
    return paths;
  }

  async getTreeActions(id: string, rawTarget: TreeActionTarget): Promise<TreeActionsInfo> {
    const target = validateTreeActionTarget(rawTarget);
    if (target.kind === 'change-group') {
      const group = this.git.resolveTreeActionGroup(id, target.changeIds);
      return {
        path: '', parentPath: '', kind: 'group', label: group.label, fileCount: group.fileCount,
        addFileCount: group.addPaths.length, removeFileCount: group.removePaths.length,
        canAdd: !!group.addPaths.length, canRemove: !!group.removePaths.length, canRename: false, canCreate: false,
        ...(!group.addPaths.length ? { addReason: 'There are no eligible unstaged changes to add.' } : {}),
        ...(!group.removePaths.length ? { removeReason: 'There are no eligible files in the Git index.' } : {}),
        renameReason: 'Choose a file or directory to rename.', createReason: 'Choose a project directory to create a file or folder.',
      };
    }
    const relative = await this.git.resolveTreeActionPath(id, target);
    const current = await this.git.inspectTreeActionPath(id, relative);
    const parent = parentPath(relative);
    const regular = current.kind === 'file' || current.kind === 'directory' || current.kind === 'missing';
    const gitAvailable = this.git.isGitRepository(id);
    let indexed = false, pending = false, ignored = false, gitError: string | undefined;
    if (gitAvailable && regular) {
      ({ indexed, pending } = this.git.getTreeGitPresence(id, relative));
      try {
        if (relative && !indexed) ignored = (await runGit(this.git.getRepositoryRoot(id), ['check-ignore', '-z', '--stdin'], 32768, { input: Buffer.from(`${relative}${current.kind === 'directory' ? '/' : ''}\0`), allowedExitCodes: [1] })).length > 0;
      } catch { gitError = 'Git state is unavailable. Refresh the project and try again.'; }
    }
    const blocked = !regular ? 'Symbolic links and submodules cannot be changed here.' : undefined;
    const containing = current.kind === 'directory' ? current : await this.git.inspectTreeActionPath(id, parent);
    const canCreate = regular && containing.kind === 'directory';
    const canRename = regular && current.kind !== 'missing' && !!relative;
    const canAdd = gitAvailable && regular && !gitError && !ignored && pending;
    const canRemove = gitAvailable && regular && !gitError && indexed;
    return {
      path: relative, parentPath: parent, kind: current.kind, canAdd, canRemove, canRename, canCreate,
      ...(!canAdd ? { addReason: blocked ?? gitError ?? (!gitAvailable ? 'This project has no Git repository.' : ignored ? 'This path is ignored by Git.' : 'There are no unstaged changes to add.') } : {}),
      ...(!canRemove ? { removeReason: blocked ?? gitError ?? (!gitAvailable ? 'This project has no Git repository.' : 'This path is not in the Git index.') } : {}),
      ...(!canRename ? { renameReason: blocked ?? (!relative ? 'The project root cannot be renamed here.' : 'This path no longer exists.') } : {}),
      ...(!canCreate ? { createReason: blocked ?? 'Choose an existing project directory.' } : {}),
    };
  }

  async performTreeAction(id: string, rawTarget: TreeActionTarget, rawAction: TreeAction): Promise<TreeActionResult> {
    const target = validateTreeActionTarget(rawTarget), action = validateTreeAction(rawAction);
    return this.git.serializeRepositoryOperation(id, async root => {
      // Revalidate every captured member after preceding queued mutations and
      // external Git changes. A stale member aborts the whole group operation.
      if (target.kind === 'change-group') await this.git.refreshRepository(id);
      const info = await this.getTreeActions(id, target);
      const relative = info.path;
      const result: TreeActionResult = { repositoryId: id, path: relative };
      if (action.kind === 'add' || action.kind === 'remove') {
        const allowed = action.kind === 'add' ? info.canAdd : info.canRemove;
        if (!allowed) throw new Error((action.kind === 'add' ? info.addReason : info.removeReason) ?? 'This Git action is unavailable.');
        // Avoid silently bypassing an application's required content filters.
        // The isolated facade also prevents a concurrently added driver running.
        const filters = await runGit(root, ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], 1024 * 1024, { allowedExitCodes: [1] });
        if (filters.length) throw new Error('Use Git externally while executable content filters are configured for this repository.');
        const group = target.kind === 'change-group' ? this.git.resolveTreeActionGroup(id, target.changeIds) : undefined;
        const paths = group ? action.kind === 'add' ? group.addPaths : group.removePaths : await this.listed(id, relative, action.kind === 'add' ? ['--modified', '--deleted', '--others', '--exclude-standard'] : ['--cached']);
        for (const file of paths) {
          if (file.endsWith('/')) throw new Error('Nested repositories must be opened as separate projects.');
          const inspected = await this.git.inspectTreeActionPath(id, file);
          if (inspected.kind !== 'file' && inspected.kind !== 'missing') throw new Error('Select regular files; symbolic links and submodules are not changed by this action.');
        }
        const input = Buffer.from(paths.map(file => `${pathspec(file)}\0`).join(''));
        await safeWorkingGit(root, action.kind === 'add'
          ? ['add', '--pathspec-from-file=-', '--pathspec-file-nul']
          : ['rm', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul'], input);
      } else {
        const rename = action.kind === 'rename';
        if (rename ? !info.canRename : !info.canCreate) throw new Error((rename ? info.renameReason : info.createReason) ?? 'This filesystem action is unavailable.');
        const directory = rename ? info.parentPath : info.kind === 'directory' ? relative : info.parentPath;
        const destination = childPath(directory, action.name);
        const parent = await this.git.inspectTreeActionPath(id, directory);
        if (parent.kind !== 'directory') throw new Error('The containing directory is no longer available.');
        const next = await this.git.inspectTreeActionPath(id, destination);
        if (next.kind !== 'missing') throw new Error('A file or folder with this name already exists.');
        if (rename) {
          const source = await this.git.inspectTreeActionPath(id, relative);
          if (source.kind !== info.kind) throw new Error('The selected path changed. Open its menu again.');
          await moveWithoutOverwrite(source.absolutePath, next.absolutePath);
          this.git.remapTreeActionPaths(id, relative, destination);
          result.previousPath = relative;
          result.remap = { from: relative, to: destination, directory: info.kind === 'directory' };
        } else if (action.kind === 'create-directory') await mkdir(safeRepositoryPath(root, destination));
        else { const file = await open(safeRepositoryPath(root, destination), 'wx'); await file.close(); }
        result.path = destination;
        result.entry = await this.git.issueTreeActionEntry(id, destination);
      }
      await this.git.refreshRepository(id);
      return result;
    });
  }
}
