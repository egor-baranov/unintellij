import { execFile, execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeText, GitService, parsePorcelainV2, resolveEndpoints, safeRepositoryPath } from './git';
import type { ChangeGroup, RepositorySnapshot } from '../src/bridge';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const exec = promisify(execFile);
const roots: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout;
}
async function repository(commit = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-git-'));
  roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test Fixture');
  await git(root, 'config', 'core.autocrlf', 'false');
  if (commit) {
    await writeFile(path.join(root, 'sample.ts'), 'export const value = 1;\n');
    await git(root, 'add', '--', 'sample.ts');
    await git(root, 'commit', '-m', 'Fixture');
  }
  return root;
}
const change = (snapshot: RepositorySnapshot, filePath: string, group: ChangeGroup) => {
  const result = snapshot.changes.find(item => item.path === filePath && item.group === group);
  if (!result) throw new Error(`Missing ${group} change ${filePath}`);
  return result;
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('closed repository memory lifecycle', () => {
  it('waits for authorized operations and rechecks ownership before releasing capabilities', async () => {
    const root = await repository();
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const id = snapshot.repository.id;
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const operation = service.serializeRepositoryOperation(id, async () => {
      await blocked;
      expect(service.getRepositoryRoot(id)).toBe(snapshot.repository.path);
    });
    let unused = true;
    const releasing = service.releaseRepository(id, () => unused);
    unused = false; // A second window reopened this project while work was pending.
    finish();
    await operation;
    await expect(releasing).resolves.toBe(false);
    expect((await service.listChanges(id)).repository.id).toBe(id);
    await expect(service.releaseRepository(id, () => true)).resolves.toBe(true);
    expect(() => service.getRepositoryRoot(id)).toThrow('Unknown repository');
    const reopened = await service.registerRepository(root);
    expect(reopened.repository.id).not.toBe(id);
    expect(reopened.repository.path).toBe(snapshot.repository.path);
    await expect(service.releaseRepository(id, () => true)).resolves.toBe(false);
  });
});

describe('porcelain and endpoint unit behavior', () => {
  const head = '1'.repeat(40);
  const index = '2'.repeat(40);
  it('preserves NUL-delimited unusual filenames and the extra rename field', () => {
    const records = parsePorcelainV2(`2 RM N... 100644 100644 100644 ${head} ${index} R100 new\t名\n file.ts\0old\n file.ts\0? a b\t\n.ts\0`);
    expect(records).toHaveLength(2);
    expect(records[0].path).toBe('new\t名\n file.ts');
    expect(records[0].oldPath).toBe('old\n file.ts');
    expect(records[1].path).toBe('a b\t\n.ts');
    expect(resolveEndpoints(records[0])).toEqual([
      { group: 'staged', status: 'R', original: { kind: 'blob', oid: head }, modified: { kind: 'blob', oid: index }, unsupported: undefined },
      { group: 'unstaged', status: 'M', original: { kind: 'blob', oid: index }, modified: { kind: 'working', path: 'new\t名\n file.ts' }, unsupported: undefined },
    ]);
  });
  it('uses empty endpoints for additions and deletions', () => {
    const addition = parsePorcelainV2(`1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${index} added\0`)[0];
    expect(resolveEndpoints(addition)[0].original).toEqual({ kind: 'empty' });
    const deletion = parsePorcelainV2(`1 .D N... 100644 100644 000000 ${head} ${index} deleted\0`)[0];
    expect(resolveEndpoints(deletion)[0].modified).toEqual({ kind: 'empty' });
  });
  it('keeps submodules and unsupported type changes out of ordinary text endpoints', () => {
    const submodule = parsePorcelainV2(`1 M. S... 160000 160000 160000 ${head} ${index} dependency\0`)[0];
    expect(resolveEndpoints(submodule)[0].unsupported).toBe('submodule');
    const typeChange = parsePorcelainV2(`1 T. N... 100644 100644 100644 ${head} ${index} changed-type\0`)[0];
    expect(resolveEndpoints(typeChange)[0].unsupported).toBe('type-change');
  });
  it('rejects traversal and absolute paths', () => {
    for (const candidate of ['../secret', 'a/../../secret', '/tmp/secret', 'a/./b', 'a//b', 'a\0b']) expect(() => safeRepositoryPath('/tmp/repo', candidate)).toThrow();
    expect(safeRepositoryPath('/tmp/repo', 'normal/名\t\n.ts')).toBe('/tmp/repo/normal/名\t\n.ts');
  });
  it('retains UTF-8 BOM and newline metadata without normalizing source', () => {
    const result = decodeText(Buffer.from('\ufeffone\r\ntwo\r\n'));
    expect(result.text).toBe('one\r\ntwo\r\n');
    expect(result.metadata).toMatchObject({ encoding: 'utf-8-bom', lineEnding: 'CRLF', finalNewline: true });
    expect(decodeText(Buffer.from('one\ntwo')).metadata).toMatchObject({ lineEnding: 'LF', finalNewline: false });
    expect(decodeText(Buffer.from('one\r\ntwo\n')).metadata.lineEnding).toBe('mixed');
  });
});

describe('real Git repository comparisons', () => {
  it('resolves staged and unstaged versions independently and preserves odd names', async () => {
    const root = await repository();
    const name = 'space 名\ttab\nnewline.ts';
    await writeFile(path.join(root, 'sample.ts'), 'staged\n');
    await git(root, 'add', '--', 'sample.ts');
    await writeFile(path.join(root, 'sample.ts'), 'working\n');
    await writeFile(path.join(root, name), 'untracked ✓\r\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    expect(snapshot.changes).toHaveLength(3);
    const staged = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'staged').id);
    expect(staged.state).toBe('text');
    expect(staged.changeType).toBe('modified');
    expect(staged.original?.text).toBe('export const value = 1;\n');
    expect(staged.modified?.text).toBe('staged\n');
    expect(staged.original?.label).toBe('HEAD');
    const unstaged = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(unstaged.original?.text).toBe('staged\n');
    expect(unstaged.modified?.text).toBe('working\n');
    const untracked = await service.readComparison(snapshot.repository.id, change(snapshot, name, 'untracked').id);
    expect(untracked.changeType).toBe('added');
    expect(untracked.original?.text).toBe('');
    expect(untracked.modified?.text).toBe('untracked ✓\r\n');
    expect(untracked.modified?.metadata.lineEnding).toBe('CRLF');
    expect((await service.listChanges(snapshot.repository.id)).generation).toBe(snapshot.generation);
  });

  it('loads a rename from captured blob identities, then its working modification', async () => {
    const root = await repository();
    const renamed = 'renamed \t\n名.ts';
    await rename(path.join(root, 'sample.ts'), path.join(root, renamed));
    await git(root, 'add', '-A');
    await writeFile(path.join(root, renamed), 'work after rename\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    expect(change(snapshot, renamed, 'staged').oldPath).toBe('sample.ts');
    const staged = await service.readComparison(snapshot.repository.id, change(snapshot, renamed, 'staged').id);
    expect(staged.state).toBe('text');
    expect(staged.changeType).toBe('modified');
    expect(staged.original?.text).toBe(staged.modified?.text);
    const unstaged = await service.readComparison(snapshot.repository.id, change(snapshot, renamed, 'unstaged').id);
    expect(unstaged.modified?.text).toBe('work after rename\n');
  });

  it('works before the first commit and handles staged deletion', async () => {
    const root = await repository(false);
    await writeFile(path.join(root, 'new'), 'new\n');
    await git(root, 'add', '--', 'new');
    const service = new GitService();
    let snapshot = await service.registerRepository(root);
    const added = await service.readComparison(snapshot.repository.id, change(snapshot, 'new', 'staged').id);
    expect(added.changeType).toBe('added');
    expect(added.original?.text).toBe('');
    expect(added.modified?.text).toBe('new\n');
    await git(root, 'commit', '-m', 'Add fixture');
    await rm(path.join(root, 'new'));
    await git(root, 'add', '-A');
    snapshot = await service.refreshRepository(snapshot.repository.id);
    const removed = await service.readComparison(snapshot.repository.id, change(snapshot, 'new', 'staged').id);
    expect(removed.changeType).toBe('deleted');
    expect(removed.original?.text).toBe('new\n');
    expect(removed.modified?.text).toBe('');
  });

  it('shows deleted working files with an empty modified side', async () => {
    const root = await repository();
    await rm(path.join(root, 'sample.ts'));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(comparison.state).toBe('text');
    expect(comparison.changeType).toBe('deleted');
    expect(comparison.modified?.text).toBe('');
  });

  it.each([true, false])('classifies absent originals as added, including zero-byte files and intent-to-add (HEAD exists: %s)', async hasHead => {
    const root = await repository(hasHead);
    await writeFile(path.join(root, 'staged-empty'), '');
    await writeFile(path.join(root, 'staged-text'), 'new staged file\n');
    await git(root, 'add', '--', 'staged-empty', 'staged-text');
    await writeFile(path.join(root, 'untracked-empty'), '');
    await writeFile(path.join(root, 'intent-to-add'), 'new working file\n');
    await git(root, 'add', '--intent-to-add', '--', 'intent-to-add');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    for (const [filePath, group, text] of [
      ['staged-empty', 'staged', ''],
      ['staged-text', 'staged', 'new staged file\n'],
      ['untracked-empty', 'untracked', ''],
      ['intent-to-add', 'unstaged', 'new working file\n'],
    ] as const) {
      const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, filePath, group).id);
      expect(comparison).toMatchObject({ state: 'text', changeType: 'added', original: { text: '' }, modified: { text } });
    }
  });

  it('keeps an existing empty file modified for both HEAD-to-index and index-to-working comparisons', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'empty-staged'), '');
    await writeFile(path.join(root, 'empty-working'), '');
    await git(root, 'add', '--', 'empty-staged', 'empty-working');
    await git(root, 'commit', '-m', 'Existing empty fixture files');
    await writeFile(path.join(root, 'empty-staged'), 'staged content\n');
    await git(root, 'add', '--', 'empty-staged');
    await writeFile(path.join(root, 'empty-working'), 'working content\n');
    await writeFile(path.join(root, 'sample.ts'), '');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    for (const [filePath, group, text] of [
      ['empty-staged', 'staged', 'staged content\n'],
      ['empty-working', 'unstaged', 'working content\n'],
    ] as const) {
      const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, filePath, group).id);
      expect(comparison).toMatchObject({ state: 'text', changeType: 'modified', original: { text: '' }, modified: { text } });
    }
    const emptied = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(emptied).toMatchObject({ state: 'text', changeType: 'modified', modified: { text: '' } });
  });

  it('rejects stale capabilities and content even when status letters are unchanged', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'version two\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'sample.ts', 'unstaged');
    await writeFile(path.join(root, 'sample.ts'), 'version three\n');
    expect((await service.readComparison(snapshot.repository.id, selected.id)).state).toBe('stale');
    const refreshed = await service.refreshRepository(snapshot.repository.id);
    expect((await service.readComparison(snapshot.repository.id, selected.id)).state).toBe('stale');
    const comparison = await service.readComparison(snapshot.repository.id, change(refreshed, 'sample.ts', 'unstaged').id);
    expect(comparison.modified?.text).toBe('version three\n');
    await expect(service.listChanges('../../repo')).rejects.toThrow('Unknown repository');
    service.dispose();
    await expect(service.listChanges(snapshot.repository.id)).rejects.toThrow('Unknown repository');
  });

  it('preserves comparison capabilities through unchanged refreshes and concurrent reads', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'current working contents\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'sample.ts', 'unstaged');
    const refreshed = await service.refreshRepository(snapshot.repository.id);
    expect(refreshed.generation).toBeGreaterThan(snapshot.generation);
    expect(change(refreshed, selected.path, selected.group).id).toBe(selected.id);
    const [comparison, next] = await Promise.all([
      service.readComparison(snapshot.repository.id, selected.id),
      service.refreshRepository(snapshot.repository.id),
    ]);
    expect(comparison).toMatchObject({ state: 'text', modified: { text: 'current working contents\n' } });
    expect(change(next, selected.path, selected.group).id).toBe(selected.id);
  });

  it('ignores unrelated status changes before and during a selected comparison read', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'selected working contents\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'sample.ts', 'unstaged');
    await writeFile(path.join(root, 'unrelated-before.txt'), 'created before loading\n');
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let changedDuringRead = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!changedDuringRead && Array.isArray(args[1]) && args[1].includes('cat-file')) {
        changedDuringRead = true;
        writeFileSync(path.join(root, 'unrelated-during.txt'), 'created while loading\n');
      }
      return originalSpawn(...args);
    });
    try {
      const comparison = await service.readComparison(snapshot.repository.id, selected.id);
      expect(changedDuringRead).toBe(true);
      expect(comparison).toMatchObject({ state: 'text', modified: { text: 'selected working contents\n' } });
      const refreshed = await service.refreshRepository(snapshot.repository.id);
      expect(change(refreshed, selected.path, selected.group).id).toBe(selected.id);
    } finally { spy.mockImplementation(originalSpawn); }
  });

  it('validates comparison paths literally without scanning unrelated working directories', async () => {
    const root = await repository();
    const originalName = 'source [*] 名.ts';
    const renamed = 'renamed [*] 名.ts';
    await writeFile(path.join(root, originalName), 'original contents\n');
    await git(root, 'add', '--', originalName);
    await git(root, 'commit', '-m', 'literal filename');
    await rename(path.join(root, originalName), path.join(root, renamed));
    await git(root, 'add', '-A');
    await writeFile(path.join(root, renamed), 'working contents\n');
    const untracked = 'new [*] file.ts';
    await writeFile(path.join(root, untracked), 'new contents\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    // Force revalidation by changing the index outside the selected paths.
    await writeFile(path.join(root, 'unrelated.txt'), 'unrelated staging\n');
    await git(root, 'add', '--', 'unrelated.txt');
    const statusPaths: string[][] = [];
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const command = args[1];
      if (Array.isArray(command) && command.includes('status')) {
        const separator = command.indexOf('--');
        if (separator < 0) throw new Error('Comparison attempted a repository-wide status scan');
        statusPaths.push(command.slice(separator + 1));
      }
      return originalSpawn(...args);
    });
    try {
      for (const group of ['staged', 'unstaged'] as const) {
        expect(await service.readComparison(snapshot.repository.id, change(snapshot, renamed, group).id)).toMatchObject({ state: 'text',
          modified: { text: group === 'staged' ? 'original contents\n' : 'working contents\n' } });
      }
      const working = snapshot.workingChanges!.find(item => item.path === renamed)!;
      expect(await service.readComparison(snapshot.repository.id, working.id)).toMatchObject({ state: 'text', original: { text: 'original contents\n' }, modified: { text: 'working contents\n' } });
      expect(await service.readComparison(snapshot.repository.id, change(snapshot, untracked, 'untracked').id)).toMatchObject({ state: 'text', modified: { text: 'new contents\n' } });
      expect(statusPaths).toHaveLength(4);
      expect(statusPaths.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => [`:(top,literal)${renamed}`, `:(top,literal)${originalName}`]));
      expect(statusPaths.slice(3)).toEqual([[`:(top,literal)${untracked}`]]);
    } finally { spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it('opens captured tracked comparisons without status, configuration, or index enumeration subprocesses', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'selected working contents\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = snapshot.workingChanges!.find(item => item.path === 'sample.ts')!;
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    const commands: string[][] = [];
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1])) commands.push([...args[1]]);
      return originalSpawn(...args);
    });
    try {
      expect(await service.readComparison(snapshot.repository.id, selected.id)).toMatchObject({ state: 'text', original: { text: 'export const value = 1;\n' }, modified: { text: 'selected working contents\n' } });
      expect(commands).toHaveLength(4); // HEAD before/after + bounded immutable blob size/content.
      expect(commands.every(command => command.includes('rev-parse') || command.includes('cat-file'))).toBe(true);
      expect(commands.some(command => command.includes('status') || command.includes('config') || command.includes('ls-files'))).toBe(false);
    } finally { spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it.each(['before', 'during'])('rejects a changed HEAD with an unchanged index %s reading the selected comparison', async when => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'second commit\n');
    await git(root, 'add', '--', 'sample.ts');
    await git(root, 'commit', '-m', 'Second');
    await writeFile(path.join(root, 'sample.ts'), 'working contents\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = snapshot.workingChanges!.find(item => item.path === 'sample.ts')!;
    const previousHead = (await git(root, 'rev-parse', 'HEAD^')).trim();
    if (when === 'before') await git(root, 'update-ref', 'HEAD', previousHead);
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let changed = when === 'before';
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!changed && Array.isArray(args[1]) && args[1].includes('cat-file')) {
        changed = true;
        execFileSync('git', ['update-ref', 'HEAD', previousHead], { cwd: root });
      }
      return originalSpawn(...args);
    });
    try {
      expect((await service.readComparison(snapshot.repository.id, selected.id)).state).toBe('stale');
      expect(changed).toBe(true);
    } finally { spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it('revalidates untracked ignore rules even when HEAD, index and selected file are unchanged', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'untracked.txt'), 'new file\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'untracked.txt', 'untracked');
    await writeFile(path.join(root, '.gitignore'), 'untracked.txt\n');
    expect((await service.readComparison(snapshot.repository.id, selected.id)).state).toBe('stale');
    service.dispose();
  });

  it('opens untracked files with literal Git ignore checks and honors ignore negation', async () => {
    const root = await repository();
    const filePath = 'new [*] 名 file.tf';
    await writeFile(path.join(root, filePath), 'resource "example" "test" {}\n');
    await writeFile(path.join(root, '.gitignore'), '*.tf\n!new*\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, filePath, 'untracked');
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    const commands: string[][] = [];
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1])) commands.push([...args[1]]);
      return originalSpawn(...args);
    });
    try {
      expect(await service.readComparison(snapshot.repository.id, selected.id)).toMatchObject({ state: 'text', changeType: 'added', modified: { text: 'resource "example" "test" {}\n' } });
      expect(commands.filter(command => command.includes('check-ignore'))).toHaveLength(2);
      expect(commands.some(command => command.includes('status') || command.includes('config') || command.includes('ls-files'))).toBe(false);
    } finally { spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it('publishes usable tracked changes before scanning untracked directories', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'tracked change\n');
    await writeFile(path.join(root, 'untracked.ts'), 'not scanned yet\n');
    const service = new GitService();
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let fullScans = 0;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const command = args[1];
      if (Array.isArray(command) && command.includes('status') && command.includes('--untracked-files=all') && !command.includes('--')) fullScans++;
      return originalSpawn(...args);
    });
    try {
      const initial = await service.registerRepository(root, { deferUntracked: true });
      expect(initial.untrackedPending).toBe(true);
      expect(fullScans).toBe(0);
      expect(initial.workingChanges!.map(item => item.path)).toEqual(['sample.ts']);
      const selected = initial.workingChanges![0];
      expect(await service.readComparison(initial.repository.id, selected.id)).toMatchObject({ state: 'text', modified: { text: 'tracked change\n' } });
      expect(fullScans).toBe(0);
      expect(await service.registerRepository(root, { deferUntracked: true })).toBe(initial);
      const complete = await service.refreshRepository(initial.repository.id);
      expect(fullScans).toBe(1);
      expect(complete.untrackedPending).toBeUndefined();
      expect(complete.workingChanges!.map(item => item.path).sort()).toEqual(['sample.ts', 'untracked.ts']);
      expect(complete.workingChanges!.find(item => item.path === selected.path)!.id).toBe(selected.id);
    } finally { spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it('keeps recreated tracked paths correct in the initial tracked-only snapshot', async () => {
    const root = await repository();
    await git(root, 'rm', '--', 'sample.ts');
    await writeFile(path.join(root, 'sample.ts'), 'recreated contents\n');
    const service = new GitService();
    try {
      const initial = await service.registerRepository(root, { deferUntracked: true });
      const selected = initial.workingChanges!.find(item => item.path === 'sample.ts')!;
      expect(selected).toMatchObject({ status: 'M', group: 'working' });
      expect(await service.readComparison(initial.repository.id, selected.id)).toMatchObject({ state: 'text', changeType: 'modified', modified: { text: 'recreated contents\n' } });
    } finally { service.dispose(); }
  });

  it('finishes full discovery when a newer tracked-only refresh overtakes it', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'untracked.ts'), 'discover after reopening\n');
    const service = new GitService();
    const initial = await service.registerRepository(root, { deferUntracked: true });
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let release: (() => void) | undefined;
    let held = false;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      const command = args[1];
      if (!held && Array.isArray(command) && command.includes('status') && command.includes('--untracked-files=all') && !command.includes('--')) {
        held = true;
        const emit = child.emit.bind(child);
        child.emit = ((event: string | symbol, ...values: unknown[]) => {
          if (event === 'close') { release = () => { emit(event, ...values); }; reached(); return true; }
          return emit(event, ...values);
        }) as typeof child.emit;
      }
      return child;
    });
    try {
      const full = service.refreshRepository(initial.repository.id);
      await paused;
      expect((await service.refreshRepository(initial.repository.id, { deferUntracked: true })).untrackedPending).toBe(true);
      release!();
      const complete = await full;
      expect(complete.untrackedPending).toBeUndefined();
      expect(complete.workingChanges!.some(item => item.path === 'untracked.ts')).toBe(true);
      expect(await service.listChanges(initial.repository.id)).toBe(complete);
    } finally { release?.(); spy.mockImplementation(originalSpawn); service.dispose(); }
  });

  it('keeps staged comparisons current when only working contents change, but rejects changed index endpoints', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'index snapshot\n');
    await git(root, 'add', '--', 'sample.ts');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const staged = change(snapshot, 'sample.ts', 'staged');
    await writeFile(path.join(root, 'sample.ts'), 'working snapshot\n');
    expect(await service.readComparison(snapshot.repository.id, staged.id)).toMatchObject({ state: 'text', modified: { text: 'index snapshot\n' } });
    const refreshed = await service.refreshRepository(snapshot.repository.id);
    expect(change(refreshed, staged.path, staged.group).id).toBe(staged.id);
    await git(root, 'add', '--', 'sample.ts');
    expect((await service.readComparison(snapshot.repository.id, staged.id)).state).toBe('stale');
    const replaced = await service.refreshRepository(snapshot.repository.id);
    expect(change(replaced, staged.path, staged.group).id).not.toBe(staged.id);
    expect((await service.readComparison(snapshot.repository.id, staged.id)).state).toBe('stale');
  });

  it('rejects an empty deletion endpoint when the working file reappears', async () => {
    const root = await repository();
    await rm(path.join(root, 'sample.ts'));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const removed = change(snapshot, 'sample.ts', 'unstaged');
    await writeFile(path.join(root, 'sample.ts'), 'recreated file\n');
    expect((await service.readComparison(snapshot.repository.id, removed.id)).state).toBe('stale');
    const refreshed = await service.refreshRepository(snapshot.repository.id);
    expect(await service.readComparison(snapshot.repository.id, change(refreshed, removed.path, removed.group).id)).toMatchObject({ state: 'text', modified: { text: 'recreated file\n' } });
  });

  it('distinguishes a staged deletion and untracked file at the same path', async () => {
    const root = await repository();
    await git(root, 'rm', '--cached', '--', 'sample.ts');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const staged = change(snapshot, 'sample.ts', 'staged');
    const untracked = change(snapshot, 'sample.ts', 'untracked');
    expect(await service.readComparison(snapshot.repository.id, staged.id)).toMatchObject({ state: 'text', changeType: 'deleted', modified: { text: '' } });
    expect(await service.readComparison(snapshot.repository.id, untracked.id)).toMatchObject({ state: 'text', changeType: 'added', modified: { text: 'export const value = 1;\n' } });
  });

  it('rejects an index endpoint replaced while immutable blobs are being loaded', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'sample.ts'), 'first index contents\n');
    await git(root, 'add', '--', 'sample.ts');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'sample.ts', 'staged');
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let changedDuringRead = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!changedDuringRead && Array.isArray(args[1]) && args[1].includes('cat-file')) {
        changedDuringRead = true;
        writeFileSync(path.join(root, 'sample.ts'), 'replacement index contents\n');
        execFileSync('git', ['add', '--', 'sample.ts'], { cwd: root });
      }
      return originalSpawn(...args);
    });
    try {
      expect((await service.readComparison(snapshot.repository.id, selected.id)).state).toBe('stale');
      expect(changedDuringRead).toBe(true);
    } finally { spy.mockImplementation(originalSpawn); }
  });

  it('reports binary, unsupported encodings, and limits without truncating files', async () => {
    const root = await repository(false);
    await writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, 'utf16'), Buffer.from([0xff, 0xfe, 0x61, 0]));
    await writeFile(path.join(root, 'invalid'), Buffer.from([0xff, 0xab]));
    await writeFile(path.join(root, 'huge'), 'x'.repeat(20));
    const service = new GitService({ maxFileBytes: 10 });
    const snapshot = await service.registerRepository(root);
    for (const [filePath, expected] of [['binary', 'binary'], ['utf16', 'encoding'], ['invalid', 'encoding'], ['huge', 'oversized']]) {
      const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, filePath, 'untracked').id);
      expect(comparison.state).toBe(expected);
      expect(comparison.original).toBeUndefined();
    }
    expect(await readFile(path.join(root, 'huge'), 'utf8')).toHaveLength(20);
  });

  it('checks immutable Git blob sizes before loading their contents', async () => {
    const root = await repository(false);
    await writeFile(path.join(root, 'large-index'), 'x'.repeat(200));
    await git(root, 'add', '--', 'large-index');
    await writeFile(path.join(root, 'large-index'), 'small');
    const service = new GitService({ maxFileBytes: 20, maxPreviewBytes: 20 });
    const snapshot = await service.registerRepository(root);
    for (const group of ['staged', 'unstaged'] as const) {
      const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'large-index', group).id);
      expect(comparison.state).toBe('oversized');
      expect(comparison.message).toContain('200 bytes');
      expect(comparison.original).toBeUndefined();
      expect(comparison.modified).toBeUndefined();
    }
  });

  it('rejects a file that disappears after listing and recovers on refresh', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'temporary'), 'will disappear');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const selected = change(snapshot, 'temporary', 'untracked');
    await rm(path.join(root, 'temporary'));
    const comparison = await service.readComparison(snapshot.repository.id, selected.id);
    expect(['stale', 'unavailable']).toContain(comparison.state);
    expect(comparison.original).toBeUndefined();
    expect((await service.refreshRepository(snapshot.repository.id)).changes).toEqual([]);
  });

  it('represents staged gitlink pointers and regular-file-to-symlink changes explicitly', async () => {
    const root = await repository();
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},dependency`);
    await rm(path.join(root, 'sample.ts'));
    await symlink('nonexistent-target', path.join(root, 'sample.ts'));
    await git(root, 'add', '--', 'sample.ts');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const submodule = await service.readComparison(snapshot.repository.id, change(snapshot, 'dependency', 'staged').id);
    expect(submodule.state).toBe('submodule');
    const typeChange = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'staged').id);
    expect(change(snapshot, 'sample.ts', 'staged').status).toBe('T');
    expect(typeChange.state).toBe('symlink');
    expect(typeChange.original).toBeUndefined();
  });

  it('does not follow symlinks, including a swapped ancestor directory', async () => {
    const root = await repository();
    const external = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-outside-'));
    roots.push(external);
    await writeFile(path.join(external, 'secret'), 'SECRET');
    await symlink(path.join(external, 'secret'), path.join(root, 'link'));
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, 'folder', 'secret'), 'safe');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    expect((await service.readComparison(snapshot.repository.id, change(snapshot, 'link', 'untracked').id)).state).toBe('symlink');
    await rm(path.join(root, 'folder'), { recursive: true });
    await symlink(external, path.join(root, 'folder'));
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'folder/secret', 'untracked').id);
    expect(comparison.state).not.toBe('text');
    expect(JSON.stringify(comparison)).not.toContain('SECRET');
  });

  it('does not execute configured clean filters, fsmonitor, or external diff helpers', async () => {
    const root = await repository();
    await writeFile(path.join(root, '.gitattributes'), '*.ts filter=dangerous\n');
    const marker = path.join(root, 'helper-executed');
    // This is test repository configuration, never an application shell command.
    const helper = `touch '${marker}'; cat`;
    await git(root, 'config', 'filter.dangerous.clean', helper);
    await git(root, 'config', 'filter.dangerous.required', 'true');
    await git(root, 'config', 'core.fsmonitor', helper);
    await git(root, 'config', 'diff.external', helper);
    await writeFile(path.join(root, 'sample.ts'), 'modified safely\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(comparison.state).toBe('text');
    expect(comparison.modified?.text).toBe('modified safely\n');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('isolates status from a new filter introduced after metadata inspection', async () => {
    const root = await repository();
    const marker = path.join(root, 'late-filter-executed');
    await writeFile(path.join(root, 'sample.ts'), 'changed\n');
    const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    let inserted = false;
    const spy = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (!inserted && Array.isArray(args[1]) && args[1].includes('status')) {
        inserted = true;
        appendFileSync(path.join(root, '.git', 'config'), `\n[filter "late"]\nclean = "touch '${marker}'; cat"\nrequired = true\n`);
        writeFileSync(path.join(root, '.gitattributes'), '*.ts filter=late\n');
      }
      return originalSpawn(...args);
    });
    try {
      const service = new GitService();
      const snapshot = await service.registerRepository(root);
      const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
      expect(inserted).toBe(true);
      expect(comparison.state).toBe('text');
      await expect(readFile(marker)).rejects.toThrow();
    } finally { spy.mockImplementation(originalSpawn); }
  });

  it('preserves ignore rules and split-index contents without changing the index', async () => {
    const root = await repository();
    await git(root, 'update-index', '--split-index');
    await writeFile(path.join(root, '.git', 'info', 'exclude'), 'ignored-local\n');
    await writeFile(path.join(root, '.gitignore'), 'ignored-worktree\n');
    await writeFile(path.join(root, 'ignored-local'), 'hidden');
    await writeFile(path.join(root, 'ignored-worktree'), 'hidden');
    await writeFile(path.join(root, 'sample.ts'), 'split-index change\n');
    const indexBefore = await readFile(path.join(root, '.git', 'index'));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    expect(snapshot.changes.map(item => item.path).sort()).toEqual(['.gitignore', 'sample.ts']);
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(comparison.modified?.text).toBe('split-index change\n');
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(indexBefore);
  });

  it('preserves info attributes and sparse-index checkout rules', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'shown'));
    await mkdir(path.join(root, 'hidden'));
    await writeFile(path.join(root, 'shown', 'file.txt'), 'base\n');
    await writeFile(path.join(root, 'hidden', 'file.txt'), 'hidden\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'Sparse fixture');
    await git(root, 'sparse-checkout', 'init', '--cone', '--sparse-index');
    await git(root, 'sparse-checkout', 'set', 'shown');
    await writeFile(path.join(root, '.git', 'info', 'attributes'), '*.txt text eol=crlf\n');
    await writeFile(path.join(root, 'shown', 'file.txt'), 'base\r\n');
    const expectedPaths = parsePorcelainV2(await git(root, 'status', '--porcelain=v2', '-z')).map(item => item.path);
    const service = new GitService();
    let snapshot = await service.registerRepository(root);
    expect(snapshot.changes.map(item => item.path)).toEqual(expectedPaths);
    await writeFile(path.join(root, 'shown', 'file.txt'), 'modified\r\n');
    const indexBefore = await readFile(path.join(root, '.git', 'index'));
    snapshot = await service.refreshRepository(snapshot.repository.id);
    expect(snapshot.changes.map(item => item.path)).toEqual(['shown/file.txt']);
    const comparison = await service.readComparison(snapshot.repository.id, snapshot.changes[0].id);
    expect(comparison.modified?.text).toBe('modified\r\n');
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(indexBefore);
  });

  it('supports SHA-256 repositories and their immutable blob identifiers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-sha256-'));
    roots.push(root);
    await git(root, 'init', '-b', 'main', '--object-format=sha256');
    await writeFile(path.join(root, 'sample.ts'), 'SHA256 index\n');
    await git(root, 'add', '--', 'sample.ts');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'staged').id);
    expect(comparison.state).toBe('text');
    expect(comparison.modified?.text).toBe('SHA256 index\n');
  });

  it('supports linked worktrees where .git is a file', async () => {
    const root = await repository();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-linked-'));
    roots.push(parent);
    const linked = path.join(parent, 'worktree');
    await git(root, 'worktree', 'add', '-b', 'linked-test', linked);
    await writeFile(path.join(linked, 'sample.ts'), 'linked change\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(linked);
    const comparison = await service.readComparison(snapshot.repository.id, change(snapshot, 'sample.ts', 'unstaged').id);
    expect(comparison.modified?.text).toBe('linked change\n');
    expect(service.getRepositoryWatchPaths(snapshot.repository.id).some(directory => directory.endsWith('worktrees/worktree'))).toBe(true);
  });

  it('makes merge conflicts explicit rather than selecting an arbitrary index stage', async () => {
    const root = await repository();
    await git(root, 'checkout', '-b', 'other');
    await writeFile(path.join(root, 'sample.ts'), 'other branch\n');
    await git(root, 'commit', '-am', 'Other fixture');
    await git(root, 'checkout', 'main');
    await writeFile(path.join(root, 'sample.ts'), 'main branch\n');
    await git(root, 'commit', '-am', 'Main fixture');
    await expect(git(root, 'merge', 'other')).rejects.toThrow();
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    expect(snapshot.changes).toHaveLength(1);
    const comparison = await service.readComparison(snapshot.repository.id, snapshot.changes[0].id);
    expect(comparison.state).toBe('conflicted');
    expect(comparison.original).toBeUndefined();
  });
});
