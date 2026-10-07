import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSearchBatch, FileSearchRequest } from '../../shared/search/types';
import { FileSearchService, FILE_SEARCH_RESULT_LIMIT } from './file-search';
import { GitService, runGit } from './git';

const execute = promisify(execFile);
const roots: string[] = [];
const services: FileSearchService[] = [];
async function git(root: string, ...args: string[]) { return (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout; }
async function repository(files: Record<string, string | Buffer> = { 'base.txt': 'base\n' }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'smart-diff-search-')));
  roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Search Fixture');
  await git(root, 'config', 'user.email', 'search@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
  await git(root, 'add', '-f', '--', ...Object.keys(files));
  await git(root, 'commit', '-m', 'Search fixture');
  return root;
}
async function setup(root: string, options: ConstructorParameters<typeof GitService>[0] = {}) {
  const files = new GitService(options);
  const snapshot = await files.registerRepository(root);
  const search = new FileSearchService(files);
  services.push(search);
  return { files, search, id: snapshot.repository.id };
}
async function find(search: FileSearchService, repositoryId: string, query: string, directoryId?: string, owner = 'window') {
  const batches: FileSearchBatch[] = [];
  await new Promise<void>((resolve, reject) => {
    void search.start(owner, repositoryId, { requestId: `request-${Math.random()}`, query, ...(directoryId ? { directoryId } : {}) }, batch => {
      batches.push(batch);
      if (batch.done) resolve();
    }).catch(reject);
  });
  return { batches, last: batches.at(-1)!, results: batches.flatMap(batch => batch.results) };
}
afterEach(async () => {
  for (const service of services.splice(0)) for (const owner of ['window', 'second', 'third', 'fourth', 'fifth']) service.disposeOwner(owner);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Find in Files backend', () => {
  it('searches unchanged and untracked contents and issues normal file capabilities only for matches', async () => {
    const root = await repository({ 'unchanged.ts': 'needle NEEDLE\nno match here\n', 'src/child.ts': 'a needle here\n', 'plain.ts': 'unrelated\n' });
    await writeFile(path.join(root, 'untracked.txt'), 'Needle in a new file\n');
    const { search, files, id } = await setup(root);
    const issue = vi.spyOn(files, 'issueSearchResult');
    const result = await find(search, id, 'needle');
    expect(result.last).toMatchObject({ occurrences: 4, matchingLines: 3, files: 3, done: true, truncated: false });
    expect(result.results.map(row => row.entry.path).sort()).toEqual(['src/child.ts', 'unchanged.ts', 'untracked.txt']);
    expect(issue).toHaveBeenCalledTimes(3);
    const unchanged = result.results.find(row => row.entry.path === 'unchanged.ts')!;
    expect(unchanged.matches).toEqual([{ column: 1, length: 6 }, { column: 8, length: 6 }]);
    expect(await files.readProjectFile(id, unchanged.entry.id)).toMatchObject({ state: 'text', path: 'unchanged.ts', content: { text: 'needle NEEDLE\nno match here\n' } });
  });

  it('uses an authorized directory recursively with scope-relative paths, not filename matching', async () => {
    const root = await repository({ 'outside.ts': 'needle\n', 'src/a.ts': 'Needle\n', 'src/deep/a file.ts': 'needle\n', 'needle-name.txt': 'unrelated\n' });
    const { search, id } = await setup(root);
    const directory = await search.authorizeDirectory('window', id, path.join(root, 'src'));
    const result = await find(search, id, 'needle', directory.id);
    expect(result.last).toMatchObject({ occurrences: 2, files: 2 });
    expect(result.last.error).toBeUndefined();
    expect(result.results.map(row => row.relativePath).sort()).toEqual(['a.ts', 'deep/a file.ts']);
    expect(result.results.map(row => row.entry.path).sort()).toEqual(['src/a.ts', 'src/deep/a file.ts']);
    expect((await find(search, id, 'needle')).last.occurrences).toBe(3);
  });

  it('enumerates a native directory with spaces and pathspec punctuation literally', async () => {
    const name = 'source [v1]+!';
    const root = await repository({ [`${name}/nested/file (1).ts`]: 'needle\n', 'source v+!/different.ts': 'needle\n', 'outside.ts': 'needle\n' });
    await writeFile(path.join(root, name, 'untracked file.ts'), 'needle\n');
    const { search, id } = await setup(root);
    const directory = await search.authorizeDirectory('window', id, path.join(root, name));
    const result = await find(search, id, 'needle', directory.id);
    expect(result.last).toMatchObject({ occurrences: 2, files: 2, truncated: false });
    expect(result.last.error).toBeUndefined();
    expect(result.results.map(row => row.relativePath).sort()).toEqual(['nested/file (1).ts', 'untracked file.ts']);
  });

  it('keeps nested source named build or target searchable while excluding generated roots and node_modules', async () => {
    const root = await repository({
      'package.json': '{}', 'src/package.json': '{}', 'tsconfig.json': '{"compilerOptions":{"outDir":"build"}}',
      'module.iml': '<module><excludeFolder url="file://$PROJECT_DIR$/target"/></module>',
      'src/build/planner.ts': 'needle\n', 'src/target/platform.ts': 'needle\n',
      'build/bundle.js': 'needle\n', 'target/generated.js': 'needle\n',
      'src/node_modules/dependency/index.js': 'needle\n', 'node_modules/pkg/index.js': 'needle\n',
    });
    const { search, id } = await setup(root);
    const project = await find(search, id, 'needle');
    expect(project.results.map(row => row.entry.path).sort()).toEqual(['src/build/planner.ts', 'src/target/platform.ts']);
    for (const [scope, name] of [['src/build', 'planner.ts'], ['src/target', 'platform.ts']]) {
      const directory = await search.authorizeDirectory('window', id, path.join(root, scope));
      expect((await find(search, id, 'needle', directory.id)).results.map(row => row.relativePath)).toEqual([name]);
    }
    for (const scope of ['build', 'target', 'src/node_modules', 'node_modules/pkg']) {
      await expect(search.authorizeDirectory('window', id, path.join(root, scope))).rejects.toThrow('excluded');
    }
  });

  it('respects Git ignores, dependency/build exclusions, submodules and symlinks', async () => {
    const root = await repository({ 'package.json': '{}', 'tsconfig.json': '{"compilerOptions":{"outDir":"dist"}}', '.gitignore': 'ignored/\n', 'good.txt': 'needle\n', 'node_modules/pkg/index.js': 'needle\n', 'dist/bundle.js': 'needle\n' });
    await mkdir(path.join(root, 'ignored'));
    await writeFile(path.join(root, 'ignored/private.txt'), 'needle\n');
    await writeFile(path.join(root, '.git/info/exclude'), 'local-ignore.txt\n');
    await writeFile(path.join(root, 'local-ignore.txt'), 'needle\n');
    await writeFile(path.join(root, '.git/private.txt'), 'needle\n');
    await symlink('good.txt', path.join(root, 'link.txt'));
    const external = await realpath(await mkdtemp(path.join(os.tmpdir(), 'smart-diff-search-outside-')));
    roots.push(external);
    await writeFile(path.join(external, 'secret.txt'), 'needle\n');
    await symlink(external, path.join(root, 'linked-directory'));
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},dependency`);
    await mkdir(path.join(root, 'dependency'));
    await writeFile(path.join(root, 'dependency/file.txt'), 'needle\n');
    const { search, files, id } = await setup(root);
    const result = await find(search, id, 'needle');
    expect(result.results.map(row => row.entry.path)).toEqual(['good.txt']);
    expect(await files.readSearchFile(id, 'linked-directory/secret.txt')).toBeNull();
    expect(await files.readSearchFile(id, 'dependency/file.txt')).toBeNull();
    expect(await files.readSearchFile(id, '.git/private.txt')).toBeNull();
  });

  it('skips binary, invalid UTF-8, oversized and concurrently missing files', async () => {
    const root = await repository({ 'good.txt': 'needle\n', 'binary.bin': Buffer.from('needle\0binary'), 'invalid.txt': Buffer.from([110, 101, 101, 100, 108, 101, 0xff]), 'huge.txt': 'needle'.repeat(40), 'removed.txt': 'needle\n' });
    const { search, files, id } = await setup(root, { maxFileBytes: 64 });
    await rm(path.join(root, 'removed.txt'));
    const result = await find(search, id, 'needle');
    expect(result.last.error).toBeUndefined();
    expect(result.results.map(row => row.entry.path)).toEqual(['good.txt']);
    await rm(path.join(root, 'good.txt'));
    expect(await files.readProjectFile(id, result.results[0].entry.id)).toMatchObject({ state: 'unavailable' });
  });

  it('preserves UTF-16 positions, Unicode case matching, CRLF, BOM and filenames containing spaces', async () => {
    const root = await repository({ 'a 名 file.ts': '\ufefffirst\r\n😀İ ſ K NEEDLE needle\r\n😀Ää\rlast\n' });
    const { search, id } = await setup(root);
    const result = await find(search, id, 'needle');
    expect(result.results[0]).toMatchObject({ relativePath: 'a 名 file.ts', lineNumber: 2, snippetStartColumn: 1, snippet: '😀İ ſ K NEEDLE needle', matches: [{ column: 9, length: 6 }, { column: 16, length: 6 }] });
    expect((await find(search, id, 'ä')).results[0]).toMatchObject({ lineNumber: 3, matches: [{ column: 3, length: 1 }, { column: 4, length: 1 }] });
    expect((await find(search, id, 'k')).results[0].matches).toEqual([{ column: 7, length: 1 }]);
    expect((await find(search, id, 's')).results.find(row => row.lineNumber === 2)?.matches).toEqual([{ column: 5, length: 1 }]);
  });

  it('treats regular expression punctuation literally and produces useful bounded snippets', async () => {
    const punctuation = '[a-z]+.*?(x){2}^$|\\';
    const root = await repository({ 'code.txt': `${'x'.repeat(700)} ${punctuation} ${punctuation.toUpperCase()} ${'z'.repeat(700)}\nnot regex\n` });
    const { search, id } = await setup(root);
    const result = await find(search, id, punctuation);
    expect(result.last).toMatchObject({ occurrences: 2, matchingLines: 1, files: 1 });
    expect(result.results[0].matches.map(match => match.column)).toEqual([702, 703 + punctuation.length]);
    expect(result.results[0].snippet.length).toBeLessThanOrEqual(361);
    expect(result.results[0].snippetStartColumn).toBe(622);
    expect(result.results[0].snippet).toContain(punctuation);
  });

  it('does not scan for an empty query and completes no-match searches quietly', async () => {
    const root = await repository();
    const { search, files, id } = await setup(root);
    const inspect = vi.spyOn(files, 'inspectSearchDirectory');
    const read = vi.spyOn(files, 'readSearchFile');
    const empty = await find(search, id, '');
    expect(empty.last).toMatchObject({ occurrences: 0, matchingLines: 0, files: 0, done: true, truncated: false });
    expect(inspect).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const none = await find(search, id, 'not found');
    expect(none.last).toMatchObject({ occurrences: 0, done: true, truncated: false });
    expect(none.results).toEqual([]);
    expect(read).toHaveBeenCalled();
  });

  it('reports incomplete rather than complete zero results when the scan time budget expires', async () => {
    const root = await repository({ 'a.txt': 'unrelated\n', 'b.txt': 'needle\n' });
    const { search, files, id } = await setup(root);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const originalRead = files.readSearchFile.bind(files);
    const read = vi.spyOn(files, 'readSearchFile').mockImplementationOnce(async (...args) => {
      const content = await originalRead(...args);
      now = 30001;
      return content;
    });
    const result = await find(search, id, 'needle');
    expect(result.last).toMatchObject({ occurrences: 0, matchingLines: 0, files: 0, done: true, truncated: true });
    expect(result.results).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('streams delta rows with cumulative counts and honestly caps occurrences', async () => {
    const root = await repository({ 'large.txt': ('needle needle\n').repeat(400) });
    const { search, id } = await setup(root);
    const result = await find(search, id, 'needle');
    expect(result.last).toMatchObject({ occurrences: FILE_SEARCH_RESULT_LIMIT, matchingLines: 250, files: 1, done: true, truncated: true });
    expect(result.batches.length).toBeGreaterThan(2);
    expect(new Set(result.results.map(row => row.id)).size).toBe(250);
    expect(result.results.reduce((count, row) => count + row.matches.length, 0)).toBe(FILE_SEARCH_RESULT_LIMIT);
    expect(result.batches.slice(0, -1).every(batch => !batch.done)).toBe(true);
    expect(result.batches.map(batch => batch.occurrences)).toEqual([...result.batches.map(batch => batch.occurrences)].sort((a, b) => a - b));
  });

  it('rejects arbitrary, foreign, stale and outside-project scope handles', async () => {
    const root = await repository({ 'src/code.ts': 'needle\n' });
    const other = await repository();
    const { search, files, id } = await setup(root);
    const second = await files.registerRepository(other);
    const request: FileSearchRequest = { requestId: 'request', query: 'needle', directoryId: '../src' };
    await expect(search.start('window', id, request, () => {})).rejects.toThrow('Unknown search directory');
    const directory = await search.authorizeDirectory('window', id, path.join(root, 'src'));
    await expect(search.start('second', id, { ...request, directoryId: directory.id }, () => {})).rejects.toThrow('Unknown search directory');
    await expect(search.start('window', second.repository.id, { ...request, directoryId: directory.id }, () => {})).rejects.toThrow('Unknown search directory');
    await expect(search.authorizeDirectory('window', id, other)).rejects.toThrow('inside the current project');
    await expect(search.authorizeDirectory('window', id, path.join(root, '.git'))).rejects.toThrow('excluded');
    search.disposeOwner('window');
    await expect(search.start('window', id, { ...request, directoryId: directory.id }, () => {})).rejects.toThrow('Unknown search directory');
    const pending = search.authorizeDirectory('window', id, path.join(root, 'src'));
    search.disposeOwner('window');
    await expect(pending).rejects.toThrow('no longer available');
  });

  it('revalidates a directory replaced by an escaping symlink before scanning', async () => {
    const root = await repository({ 'src/code.ts': 'needle\n' });
    const other = await repository({ 'secret.ts': 'needle\n' });
    const { search, id } = await setup(root);
    const directory = await search.authorizeDirectory('window', id, path.join(root, 'src'));
    await rm(path.join(root, 'src'), { recursive: true });
    await symlink(other, path.join(root, 'src'));
    const result = await find(search, id, 'needle', directory.id);
    expect(result.results).toEqual([]);
    expect(result.last.error).toMatch(/symbolic/i);
    expect(result.last.done).toBe(true);
  });

  it('rejects malformed and oversized queries without starting work', async () => {
    const root = await repository();
    const { search, id } = await setup(root);
    for (const query of ['a\nb', 'a\rb', 'a\0b', 'x'.repeat(513)]) await expect(search.start('window', id, { requestId: 'request', query }, () => {})).rejects.toThrow('single-line query');
  });

  it('cancels old work on rapid typing and scope switching, without stale batches', async () => {
    const root = await repository({ 'outside.ts': 'old needle\n', 'src/new.ts': 'new needle\n' });
    const { search, files, id } = await setup(root);
    const directory = await search.authorizeDirectory('window', id, path.join(root, 'src'));
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const originalRead = files.readSearchFile.bind(files);
    vi.spyOn(files, 'readSearchFile').mockImplementationOnce(async (...args) => { entered(); await blocked; return originalRead(...args); });
    const old: FileSearchBatch[] = [];
    await search.start('window', id, { requestId: 'old', query: 'old' }, batch => old.push(batch));
    await reading;
    const latest = find(search, id, 'new', directory.id);
    search.cancel('window', 'old');
    release();
    const result = await latest;
    expect(old).toEqual([]);
    expect(result.results.map(row => row.entry.path)).toEqual(['src/new.ts']);
    expect(result.last).toMatchObject({ occurrences: 1, done: true });
  });

  it('stops when the dialog closes and keeps other owners independent', async () => {
    const root = await repository({ 'code.ts': 'needle\n' });
    const { search, id } = await setup(root);
    const closed: FileSearchBatch[] = [];
    await search.start('window', id, { requestId: 'closed', query: 'needle' }, batch => closed.push(batch));
    search.cancel('window', 'closed');
    const second = await find(search, id, 'needle', undefined, 'second');
    expect(second.last.occurrences).toBe(1);
    expect(closed).toEqual([]);
    search.disposeOwner('window');
    expect((await find(search, id, 'needle')).last.occurrences).toBe(1);
  });

  it('bounds concurrent scans across windows and cancels queued work', async () => {
    const root = await repository({ 'code.ts': 'needle\n' });
    const { search, files, id } = await setup(root);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const originalRead = files.readSearchFile.bind(files);
    let concurrent = 0;
    let maximum = 0;
    const read = vi.spyOn(files, 'readSearchFile').mockImplementation(async (...args) => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try { await blocked; return await originalRead(...args); }
      finally { concurrent--; }
    });
    const first = ['window', 'second', 'third', 'fourth'].map(owner => find(search, id, 'needle', undefined, owner));
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(4); });
    const queued: FileSearchBatch[] = [];
    await search.start('fifth', id, { requestId: 'queued', query: 'needle' }, batch => queued.push(batch));
    await yieldToEventLoop();
    expect(read).toHaveBeenCalledTimes(4);
    search.cancel('fifth', 'queued');
    release();
    expect((await Promise.all(first)).every(result => result.last.occurrences === 1)).toBe(true);
    expect(maximum).toBe(4);
    expect(queued).toEqual([]);
    expect((await find(search, id, 'needle', undefined, 'fifth')).last.occurrences).toBe(1);
  });

  it('closes a canceled Git process before its promise settles and rejects pre-aborted scans', async () => {
    const root = await repository();
    const controller = new AbortController();
    const pending = runGit(root, ['ls-files', '-z'], 1024, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(runGit(root, ['ls-files', '-z'], 1024, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await yieldToEventLoop();
  });
});
