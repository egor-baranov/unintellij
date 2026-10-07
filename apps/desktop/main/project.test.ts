import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from './git';
import type { ProjectDirectory } from '../src/bridge';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, opendir: vi.fn(original.opendir), open: vi.fn(original.open), lstat: vi.fn(original.lstat) };
});

const exec = promisify(execFile);
const roots: string[] = [];
async function git(root: string, ...args: string[]) {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout;
}
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-project-'));
  roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'clean.ts'), 'export const value = 1;\n');
  await git(root, 'add', '--', 'clean.ts');
  await git(root, 'commit', '-m', 'Fixture');
  return root;
}
function entry(directory: ProjectDirectory, name: string) {
  const result = directory.entries.find(candidate => candidate.name === name);
  if (!result) throw new Error(`Missing project entry ${name}`);
  return result;
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('read-only Project capabilities', () => {
  it('lazily lists and opens clean, untracked, ignored, and dotfiles with unusual names', async () => {
    const root = await repository();
    const name = 'space 名\ttab\nline.ts';
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, '.config'));
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored content\n');
    await writeFile(path.join(root, 'src', name), '\ufeffUnicode ✓\r\n');
    const indexBefore = await readFile(path.join(root, '.git', 'index'));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    expect(directory.entries.map(item => item.name)).toEqual(['.config', 'src', '.gitignore', 'clean.ts', 'ignored.txt']);
    expect(directory.truncated).toBe(false);
    expect(directory.entries.some(item => item.path.includes(name))).toBe(false);
    expect(entry(directory, 'src').status).toBe('?');
    const clean = await service.readProjectFile(snapshot.repository.id, entry(directory, 'clean.ts').id);
    expect(clean).toMatchObject({ state: 'text', content: { label: 'Working tree', text: 'export const value = 1;\n' } });
    const ignored = await service.readProjectFile(snapshot.repository.id, entry(directory, 'ignored.txt').id);
    expect(ignored.content?.text).toBe('ignored content\n');
    const nested = await service.listProjectDirectory(snapshot.repository.id, entry(directory, 'src').id);
    expect(nested.path).toBe('src');
    expect(entry(nested, name).path).toBe(`src/${name}`);
    const unicode = await service.readProjectFile(snapshot.repository.id, entry(nested, name).id);
    expect(unicode.content).toMatchObject({ text: 'Unicode ✓\r\n', metadata: { encoding: 'utf-8-bom', lineEnding: 'CRLF', finalNewline: true } });
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(indexBefore);
  });

  it('rejects raw paths, traversal, foreign capabilities, and incorrect kinds', async () => {
    const firstRoot = await repository();
    const secondRoot = await repository();
    const service = new GitService();
    const first = await service.registerRepository(firstRoot);
    const second = await service.registerRepository(secondRoot);
    const directory = await service.listProjectDirectory(first.repository.id, null);
    const selected = entry(directory, 'clean.ts');
    for (const value of ['../secret', '.git', '/tmp/secret', 'clean.ts', '../clean.ts']) {
      await expect(service.listProjectDirectory(first.repository.id, value)).rejects.toThrow('Unknown project entry');
      await expect(service.readProjectFile(first.repository.id, value)).rejects.toThrow('Unknown project entry');
    }
    await expect(service.listProjectDirectory(first.repository.id, selected.id)).rejects.toThrow('not a browsable directory');
    await expect(service.readProjectFile(second.repository.id, selected.id)).rejects.toThrow('Unknown project entry');
    await expect(service.listProjectDirectory('../repo', null)).rejects.toThrow('Unknown repository');
    service.dispose();
    await expect(service.readProjectFile(first.repository.id, selected.id)).rejects.toThrow('Unknown repository');
  });

  it('opens current working contents after edits, preserving IDs across refresh and reporting disappearance', async () => {
    const root = await repository();
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    const selected = entry(directory, 'clean.ts');
    await writeFile(path.join(root, 'clean.ts'), 'new content\n');
    expect((await service.readProjectFile(snapshot.repository.id, selected.id)).content?.text).toBe('new content\n');
    await service.refreshRepository(snapshot.repository.id);
    const refreshed = await service.listProjectDirectory(snapshot.repository.id, null);
    expect(entry(refreshed, 'clean.ts').id).toBe(selected.id);
    expect(entry(refreshed, 'clean.ts').status).toBe('M');
    expect((await service.readProjectFile(snapshot.repository.id, selected.id)).content?.text).toBe('new content\n');
    await rm(path.join(root, 'clean.ts'));
    const missing = await service.readProjectFile(snapshot.repository.id, selected.id);
    expect(missing.state).toBe('unavailable');
    expect(missing.content).toBeUndefined();
  });

  it('rejects replacement between inspection and opening instead of releasing raced contents', async () => {
    const root = await repository();
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await writeFile(path.join(root, 'clean.ts'), 'raced replacement content');
      return original(...args);
    });
    const file = await service.readProjectFile(snapshot.repository.id, entry(directory, 'clean.ts').id);
    expect(file.state).toBe('stale');
    expect(file.content).toBeUndefined();
  });

  it('does not follow symlinks or directory capabilities whose ancestors were swapped', async () => {
    const root = await repository();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-project-outside-'));
    roots.push(outside);
    await mkdir(path.join(root, 'folder'));
    await mkdir(path.join(root, 'folder', 'nested'));
    await writeFile(path.join(root, 'folder', 'secret'), 'safe');
    await writeFile(path.join(outside, 'secret'), 'SECRET OUTSIDE');
    await symlink(path.join(outside, 'secret'), path.join(root, 'link'));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    expect(entry(directory, 'link').kind).toBe('symlink');
    expect((await service.readProjectFile(snapshot.repository.id, entry(directory, 'link').id)).state).toBe('symlink');
    await expect(service.listProjectDirectory(snapshot.repository.id, entry(directory, 'link').id)).rejects.toThrow();
    const nested = await service.listProjectDirectory(snapshot.repository.id, entry(directory, 'folder').id);
    await rename(path.join(root, 'folder'), path.join(root, 'original-folder'));
    await symlink(outside, path.join(root, 'folder'));
    await expect(service.listProjectDirectory(snapshot.repository.id, entry(directory, 'folder').id)).rejects.toThrow('Symbolic links');
    await expect(service.listProjectDirectory(snapshot.repository.id, entry(nested, 'nested').id)).rejects.toThrow('Symbolic links');
    const rejected = await service.readProjectFile(snapshot.repository.id, entry(nested, 'secret').id);
    expect(rejected.state).toBe('symlink');
    expect(JSON.stringify(rejected)).not.toContain('SECRET OUTSIDE');
  });

  it('rejects a directory swapped while opening, without issuing its entries', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, 'folder', 'safe'), 'safe');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).opendir;
    vi.mocked(fs.opendir).mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      await rename(path.join(root, 'folder'), path.join(root, 'old-folder'));
      await mkdir(path.join(root, 'folder'));
      return handle;
    });
    await expect(service.listProjectDirectory(snapshot.repository.id, entry(directory, 'folder').id)).rejects.toThrow('changed while opening');
  });

  it('checks child identities concurrently with bounded I/O and preserves unavailable entries', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'many'));
    await Promise.all(Array.from({ length: 48 }, (_, index) => writeFile(path.join(root, 'many', `file${index}.ts`), 'content')));
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat;
    let active = 0;
    let peak = 0;
    let checked = 0;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      const name = String(args[0]);
      if (path.dirname(name) !== path.join(snapshot.repository.path, 'many') || !/^file\d+\.ts$/.test(path.basename(name))) return original(...args);
      checked++;
      peak = Math.max(peak, ++active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        // A disappearing/unreadable child must not cancel the other inspections.
        if (path.basename(name) === 'file0.ts') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        if (path.basename(name) === 'file1.ts') throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
        return await original(...args);
      } finally { active--; }
    });
    try {
      const listing = await service.listProjectDirectory(snapshot.repository.id, entry(directory, 'many').id);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(16);
      expect(checked).toBe(48);
      expect(listing.entries).toHaveLength(47);
      expect(listing.entries.some(item => item.name === 'file0.ts')).toBe(false);
      expect(entry(listing, 'file1.ts').facts?.identity.kind).toBe('unavailable');
      expect(entry(listing, 'file47.ts').kind).toBe('file');
      expect(listing.truncated).toBe(false);
    } finally {
      vi.mocked(fs.lstat).mockImplementation(original);
      service.dispose();
    }
  });

  it('bounds listing and file contents, exposing binary and encoding limitations', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'large'));
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(path.join(root, 'large', `file${index}`), 'content')));
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, 'utf16'), Buffer.from([0xff, 0xfe, 0x61, 0]));
    await writeFile(path.join(root, 'invalid'), Buffer.from([0xff, 0xab]));
    await writeFile(path.join(root, 'large-text'), 'x'.repeat(40));
    const service = new GitService({ maxFileBytes: 20 });
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    for (const [name, state] of [['binary', 'binary'], ['utf16', 'encoding'], ['invalid', 'encoding'], ['large-text', 'oversized']]) {
      const file = await service.readProjectFile(snapshot.repository.id, entry(directory, name).id);
      expect(file.state).toBe(state);
      expect(file.content).toBeUndefined();
    }
    const limited = new GitService({ maxDirectoryEntries: 3 });
    const limitedSnapshot = await limited.registerRepository(root);
    const limitedDirectory = await limited.listProjectDirectory(limitedSnapshot.repository.id, null);
    expect(limitedDirectory.entries).toHaveLength(3);
    expect(limitedDirectory.truncated).toBe(true);
    expect(limitedDirectory.entries.some(item => item.name === '.git')).toBe(false);
    expect(() => new GitService({ maxDirectoryEntries: 0 })).toThrow();
    expect(await readFile(path.join(root, 'large-text'), 'utf8')).toHaveLength(40);
  });

  it('recognizes clean gitlinks without traversing their contents or opening .git', async () => {
    const root = await repository();
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();
    await mkdir(path.join(root, 'dependency'));
    await writeFile(path.join(root, 'dependency', 'file'), 'nested repository content');
    await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},dependency`);
    await git(root, 'commit', '-m', 'Gitlink fixture');
    const service = new GitService();
    const snapshot = await service.registerRepository(root);
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    expect(entry(directory, 'dependency').kind).toBe('submodule');
    await expect(service.listProjectDirectory(snapshot.repository.id, entry(directory, 'dependency').id)).rejects.toThrow('not a browsable directory');
    expect((await service.readProjectFile(snapshot.repository.id, entry(directory, 'dependency').id)).state).toBe('submodule');
  });
});
