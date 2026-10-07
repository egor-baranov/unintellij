import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git';
import type { ComparisonSide, ProjectFile } from '../src/bridge';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const exec = promisify(execFile);
const roots: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout;
}
async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-editing-'));
  roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Editing Fixture');
  await git(root, 'config', 'user.email', 'editing@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'tracked.ts'), 'HEAD\n');
  await git(root, 'add', '--', 'tracked.ts');
  await git(root, 'commit', '-m', 'Fixture');
  return root;
}
async function projectFile(service: GitService, id: string, name: string): Promise<ProjectFile> {
  const directory = await service.listProjectDirectory(id, null);
  const entry = directory.entries.find(item => item.name === name);
  if (!entry) throw new Error(`Missing ${name}`);
  return service.readProjectFile(id, entry.id);
}
function editable(content?: ComparisonSide): NonNullable<ComparisonSide['editable']> {
  if (!content?.editable) throw new Error(`Not editable: ${content?.readOnlyReason}`);
  return content.editable;
}
afterEach(async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(original.open);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('working-tree editing capabilities', () => {
  it('saves a clean project file without modifying the index or historical blob', async () => {
    const root = await repository();
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const id = snapshot.repository.id;
    const index = await readFile(path.join(root, '.git', 'index'));
    const file = await projectFile(service, id, 'tracked.ts');
    const token = editable(file.content);
    const saved = await service.saveText(id, token.id, token.version, 'edited project\n');
    expect(saved.state).toBe('saved');
    expect(saved.content?.text).toBe('edited project\n');
    expect(editable(saved.content).id).toBe(token.id);
    expect(editable(saved.content).version).not.toBe(token.version);
    expect(await readFile(path.join(root, 'tracked.ts'), 'utf8')).toBe('edited project\n');
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(index);
    expect(await git(root, 'show', ':tracked.ts')).toBe('HEAD\n');
    expect(await git(root, 'show', 'HEAD:tracked.ts')).toBe('HEAD\n');
  });

  it('issues edits only for working sides of unstaged and untracked comparisons', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'tracked.ts'), 'Index\n');
    await git(root, 'add', '--', 'tracked.ts');
    await writeFile(path.join(root, 'tracked.ts'), 'Working\n');
    await writeFile(path.join(root, 'untracked.ts'), 'Untracked\n');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const id = snapshot.repository.id;
    const index = await readFile(path.join(root, '.git', 'index'));
    const staged = await service.readComparison(id, snapshot.changes.find(item => item.group === 'staged')!.id);
    expect(staged.original?.editable).toBeUndefined();
    expect(staged.modified?.editable).toBeUndefined();
    const unstaged = await service.readComparison(id, snapshot.changes.find(item => item.group === 'unstaged')!.id);
    const untracked = await service.readComparison(id, snapshot.changes.find(item => item.group === 'untracked')!.id);
    expect(unstaged.original?.editable).toBeUndefined();
    expect(untracked.original?.editable).toBeUndefined();
    for (const [comparison, text] of [[unstaged, 'Saved tracked\n'], [untracked, 'Saved untracked\n']] as const) {
      const token = editable(comparison.modified);
      expect((await service.saveText(id, token.id, token.version, text)).state).toBe('saved');
      expect(await readFile(path.join(root, comparison.path), 'utf8')).toBe(text);
    }
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(index);
    expect(await git(root, 'show', ':tracked.ts')).toBe('Index\n');
  });

  it('rejects raw paths, foreign capabilities, stale versions, and external changes', async () => {
    const root = await repository();
    const otherRoot = await repository();
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    const otherId = (await service.registerRepository(otherRoot)).repository.id;
    const token = editable((await projectFile(service, id, 'tracked.ts')).content);
    for (const raw of ['tracked.ts', '../tracked.ts', '.git/index', path.join(root, 'tracked.ts')]) expect((await service.saveText(id, raw, token.version, 'bad')).state).toBe('stale');
    expect((await service.saveText(otherId, token.id, token.version, 'bad')).state).toBe('stale');
    expect((await service.saveText(id, token.id, '0'.repeat(64), 'bad')).state).toBe('stale');
    const saved = await service.saveText(id, token.id, token.version, 'first edit\n');
    expect(saved.state).toBe('saved');
    expect((await service.saveText(id, token.id, token.version, 'replayed')).state).toBe('stale');
    const current = editable(saved.content);
    await writeFile(path.join(root, 'tracked.ts'), 'External modification\n');
    expect((await service.saveText(id, current.id, current.version, 'overwrite external')).state).toBe('stale');
    expect(await readFile(path.join(root, 'tracked.ts'), 'utf8')).toBe('External modification\n');
  });

  it('preserves UTF-8 BOM and CRLF while respecting deliberate final-newline edits', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'crlf.txt'), '\ufefffirst\r\nsecond');
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    let token = editable((await projectFile(service, id, 'crlf.txt')).content);
    let saved = await service.saveText(id, token.id, token.version, 'edited\nsecond');
    expect(saved.content?.metadata).toMatchObject({ encoding: 'utf-8-bom', lineEnding: 'CRLF', finalNewline: false });
    expect(await readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('\ufeffedited\r\nsecond');
    token = editable(saved.content);
    saved = await service.saveText(id, token.id, token.version, 'edited\nsecond\n');
    expect(saved.content?.metadata.finalNewline).toBe(true);
    expect(await readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('\ufeffedited\r\nsecond\r\n');
    token = editable(saved.content);
    saved = await service.saveText(id, token.id, token.version, '');
    expect(saved.content?.text).toBe('');
    expect(await readFile(path.join(root, 'crlf.txt'))).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    token = editable(saved.content);
    saved = await service.saveText(id, token.id, token.version, 'restored\nlines\n');
    expect(saved.content?.metadata.lineEnding).toBe('CRLF');
    expect(await readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('\ufeffrestored\r\nlines\r\n');
  });

  it('keeps mixed newlines and hardlinked files read-only and bounds encoded bytes', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'mixed'), 'one\r\ntwo\n');
    await link(path.join(root, 'tracked.ts'), path.join(root, 'hardlink'));
    await writeFile(path.join(root, 'small'), 'small');
    const service = new GitService({ maxFileBytes: 30 });
    const id = (await service.registerRepository(root)).repository.id;
    expect((await projectFile(service, id, 'mixed')).content).toMatchObject({ readOnlyReason: expect.stringContaining('Mixed line endings') });
    expect((await projectFile(service, id, 'mixed')).content?.editable).toBeUndefined();
    expect((await projectFile(service, id, 'hardlink')).content?.editable).toBeUndefined();
    const token = editable((await projectFile(service, id, 'small')).content);
    expect((await service.saveText(id, token.id, token.version, '名'.repeat(20))).state).toBe('oversized');
    expect((await service.saveText(id, token.id, token.version, '\ud800')).state).toBe('encoding');
    expect((await service.saveText(id, token.id, token.version, 'a\0b')).state).toBe('encoding');
    expect(await readFile(path.join(root, 'small'), 'utf8')).toBe('small');
  });

  it('rejects disappearance and symlink replacement without recreating or following files', async () => {
    const root = await repository();
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    const token = editable((await projectFile(service, id, 'tracked.ts')).content);
    await rm(path.join(root, 'tracked.ts'));
    expect((await service.saveText(id, token.id, token.version, 'recreate')).state).toBe('unavailable');
    await writeFile(path.join(root, 'target'), 'leave me alone');
    await symlink('target', path.join(root, 'tracked.ts'));
    expect((await service.saveText(id, token.id, token.version, 'follow')).state).toBe('symlink');
    expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('leave me alone');
  });

  it('rejects an ancestor swapped to an outside directory immediately before writable open', async () => {
    const root = await repository();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-edit-outside-'));
    roots.push(outside);
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, 'folder', 'file'), 'Inside\n');
    await writeFile(path.join(outside, 'file'), 'Outside\n');
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    const dir = await service.listProjectDirectory(id, null);
    const nested = await service.listProjectDirectory(id, dir.entries.find(item => item.name === 'folder')!.id);
    const token = editable((await service.readProjectFile(id, nested.entries[0].id)).content);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let swapped = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!swapped && typeof args[1] === 'number' && (args[1] & constants.O_RDWR) === constants.O_RDWR) {
        swapped = true;
        await rename(path.join(root, 'folder'), path.join(root, 'original-folder'));
        await symlink(outside, path.join(root, 'folder'));
      }
      return original.open(...args);
    });
    expect((await service.saveText(id, token.id, token.version, 'attack')).state).toBe('stale');
    expect(swapped).toBe(true);
    expect(await readFile(path.join(outside, 'file'), 'utf8')).toBe('Outside\n');
    expect(await readFile(path.join(root, 'original-folder', 'file'), 'utf8')).toBe('Inside\n');
  });

  it('serializes simultaneous saves to the same capability', async () => {
    const root = await repository();
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    const token = editable((await projectFile(service, id, 'tracked.ts')).content);
    const results = await Promise.all([service.saveText(id, token.id, token.version, 'first'), service.saveText(id, token.id, token.version, 'second')]);
    expect(results.map(result => result.state).sort()).toEqual(['saved', 'stale']);
    expect(await readFile(path.join(root, 'tracked.ts'), 'utf8')).toBe('first');
  });

  it('keeps the saved capability valid when a file read overlaps the save', async () => {
    const root = await repository();
    const service = new GitService();
    const id = (await service.registerRepository(root)).repository.id;
    const directory = await service.listProjectDirectory(id, null);
    const entry = directory.entries.find(item => item.name === 'tracked.ts')!;
    const token = editable((await service.readProjectFile(id, entry.id)).content);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void;
    let signalWritten!: () => void;
    const continueSave = new Promise<void>(resolve => { release = resolve; });
    const written = new Promise<void>(resolve => { signalWritten = resolve; });
    let paused = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await original.open(...args);
      if (!paused && typeof args[1] === 'number' && (args[1] & constants.O_RDWR) === constants.O_RDWR) {
        paused = true;
        const sync = file.sync.bind(file);
        file.sync = async () => {
          await sync();
          signalWritten();
          await continueSave;
        };
      }
      return file;
    });
    const saving = service.saveText(id, token.id, token.version, 'first edit\n');
    await written;
    try {
      const overlappingRead = await service.readProjectFile(id, entry.id);
      expect(overlappingRead.state).toBe('stale');
      expect(overlappingRead.content?.editable).toBeUndefined();
    } finally { release(); }
    const saved = await saving;
    expect(saved.state).toBe('saved');
    const next = editable(saved.content);
    expect((await service.saveText(id, next.id, next.version, 'second edit\n')).state).toBe('saved');
    expect(await readFile(path.join(root, 'tracked.ts'), 'utf8')).toBe('second edit\n');
  });
});
