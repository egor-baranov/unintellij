import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService, parsePorcelainV2 } from './git';
import { nodeGitFacts, parseIgnoreFacts, projectGitSnapshot } from './project-facts';
import type { ProjectDirectory } from '../src/bridge';
import { FileSearchService } from './file-search';
import type { FileSearchBatch } from '../../shared/search/types';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), opendir: vi.fn((await original<typeof import('node:fs/promises')>()).opendir) }));
const exec = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout;
async function fixture(files: Record<string, string>, versioned = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-semantics-')); roots.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  if (versioned) { await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture'); }
  return root;
}
const entry = (directory: ProjectDirectory, name: string) => { const found = directory.entries.find(item => item.name === name); if (!found) throw new Error(`Missing ${name}`); return found; };
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('semantic project metadata from real repositories', () => {
  it('keeps dot folders ordinary and computes direct/deep summaries before expanding children', async () => {
    const root = await fixture({ '.github/config.yml': 'before', '.github/deep/workflow.yml': 'before', '.idea/tracked.xml': 'before', 'ordinary.txt': 'same' });
    await writeFile(path.join(root, '.github/config.yml'), 'after'); await writeFile(path.join(root, '.github/deep/workflow.yml'), 'after');
    await writeFile(path.join(root, '.idea/tracked.xml'), 'after'); await writeFile(path.join(root, '.idea/ignored.xml'), 'private');
    await writeFile(path.join(root, '.gitignore'), '.idea/ignored.xml\n');
    const service = new GitService(); const { repository } = await service.registerRepository(root);
    const listing = await service.listProjectDirectory(repository.id, null);
    expect(entry(listing, '.github').facts).toMatchObject({ identity: { dotPrefixed: true }, role: { kind: 'ordinary' }, git: { state: 'clean', tracked: true }, changes: { immediate: { modified: 1, total: 1 }, descendants: { modified: 2, total: 2 } } });
    expect(entry(listing, '.idea').facts?.changes.descendants.total).toBe(1);
    const idea = await service.listProjectDirectory(repository.id, entry(listing, '.idea').id);
    expect(entry(idea, 'tracked.xml').facts?.git.state).toBe('modified');
    expect(entry(idea, 'ignored.xml').facts).toMatchObject({ git: { state: 'ignored', ignored: true }, inclusion: { state: 'included' } });
    expect(idea.entries.every(item => item.facts?.generation === idea.generation)).toBe(true);
  });

  it('reads nested, global, repository and negated ignore rules while tracked files stay tracked', async () => {
    const root = await fixture({ 'nested/keep.log': 'tracked', 'nested/plain.txt': 'plain' });
    const global = path.join(root, '.global-excludes'); await writeFile(global, 'global.txt\n'); await git(root, 'config', 'core.excludesFile', global);
    await writeFile(path.join(root, '.git/info/exclude'), 'local.txt\n');
    await writeFile(path.join(root, '.gitignore'), '*.log\n'); await writeFile(path.join(root, 'nested/.gitignore'), '!allowed.log\n');
    for (const file of ['nested/allowed.log', 'nested/hidden.log', 'global.txt', 'local.txt']) await writeFile(path.join(root, file), 'new');
    const service = new GitService(); const { repository } = await service.registerRepository(root); const listing = await service.listProjectDirectory(repository.id, null);
    expect(entry(listing, 'global.txt').facts?.git).toMatchObject({ ignored: true, ignoreRule: { source: global, pattern: 'global.txt' } });
    expect(entry(listing, 'local.txt').facts?.git.ignoreRule?.source).toBe('.git/info/exclude');
    const nested = await service.listProjectDirectory(repository.id, entry(listing, 'nested').id);
    expect(entry(nested, 'keep.log').facts?.git).toMatchObject({ tracked: true, ignored: false, state: 'clean' });
    expect(entry(nested, 'allowed.log').facts?.git).toMatchObject({ state: 'untracked', ignored: false, ignoreRule: { source: 'nested/.gitignore', pattern: '!allowed.log' } });
    expect(entry(nested, 'hidden.log').facts?.git).toMatchObject({ state: 'ignored', ignoreRule: { source: '.gitignore', pattern: '*.log' } });
    expect(parseIgnoreFacts(Buffer.from('nested/.gitignore\0' + '1\0!allowed.log\0nested/allowed.log\0')).get('nested/allowed.log')).toMatchObject({ ignored: false, rule: { pattern: '!allowed.log' } });
  });

  it('retains staged and working states, untracked identity, and mixed summary counts', async () => {
    const root = await fixture({ 'folder/existing.ts': 'old' });
    await writeFile(path.join(root, 'folder/existing.ts'), 'staged'); await git(root, 'add', '.'); await writeFile(path.join(root, 'folder/existing.ts'), 'working');
    await writeFile(path.join(root, 'folder/added.ts'), 'added'); await git(root, 'add', 'folder/added.ts'); await writeFile(path.join(root, 'folder/untracked.ts'), 'new');
    const service = new GitService(); const { repository } = await service.registerRepository(root); const listing = await service.listProjectDirectory(repository.id, null); const folder = await service.listProjectDirectory(repository.id, entry(listing, 'folder').id);
    expect(entry(folder, 'existing.ts').facts?.git).toMatchObject({ index: 'modified', workingTree: 'modified', tracked: true });
    expect(entry(folder, 'added.ts').facts?.git).toMatchObject({ index: 'added', workingTree: 'clean', state: 'added', tracked: true });
    expect(entry(folder, 'untracked.ts').facts?.git).toMatchObject({ index: 'not-applicable', workingTree: 'untracked', tracked: false });
    expect(folder.facts?.changes.immediate).toMatchObject({ total: 3, modified: 1, added: 1, untracked: 1 });
  });

  it.each([
    { name: 'cross-directory', from: 'shared/source/deep/file.ts', to: 'shared/destination/nested/file.ts', keep: 'shared/destination/nested/keep.txt', immediate: ['shared/source/deep', 'shared/destination/nested'], descendants: ['', 'shared', 'shared/source', 'shared/source/deep', 'shared/destination', 'shared/destination/nested'] },
    { name: 'same-directory', from: 'shared/file.ts', to: 'shared/renamed.ts', keep: 'shared/keep.txt', immediate: ['shared'], descendants: ['', 'shared'] },
  ])('counts a $name rename once at common ancestors and at each affected parent', async ({ from, to, keep, immediate, descendants }) => {
    const root = await fixture({ [from]: 'export const renamed = true;\n', [keep]: 'unchanged' });
    await git(root, 'mv', from, to);
    const records = parsePorcelainV2(await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'rename', xy: 'R.', path: to, oldPath: from });
    const facts = projectGitSnapshot(records, new Set((await git(root, 'ls-files', '-z')).split('\0').filter(Boolean)));
    expect(facts.states.get(to)?.state).toBe('renamed');
    expect([...facts.summaries.keys()].sort()).toEqual([...descendants].sort());
    for (const directory of descendants) {
      expect(facts.summaries.get(directory)?.descendants).toMatchObject({ total: 1, renamed: 1 });
      expect(facts.summaries.get(directory)?.immediate).toMatchObject({ total: immediate.includes(directory) ? 1 : 0, renamed: immediate.includes(directory) ? 1 : 0 });
    }
    const service = new GitService(); const { repository } = await service.registerRepository(root);
    const listing = await service.listProjectDirectory(repository.id, null);
    expect(listing.facts?.changes.descendants).toMatchObject({ total: 1, renamed: 1 });
    expect(entry(listing, 'shared').facts?.changes).toMatchObject({ immediate: { total: immediate.includes('shared') ? 1 : 0 }, descendants: { total: 1, renamed: 1 } });
    if (from.includes('/source/')) {
      const shared = await service.listProjectDirectory(repository.id, entry(listing, 'shared').id);
      // Both remain collapsed: source aggregation cannot depend on loading its
      // now-empty deep directory, or only on the renamed file's destination.
      for (const name of ['source', 'destination']) expect(entry(shared, name).facts?.changes).toMatchObject({ immediate: { total: 0 }, descendants: { total: 1, renamed: 1 } });
    }
  });

  it('identifies conflicts without turning their parent folder into a conflicted file', async () => {
    const root = await fixture({ 'folder/conflict.txt': 'base\n' }); await git(root, 'checkout', '-b', 'other'); await writeFile(path.join(root, 'folder/conflict.txt'), 'other\n'); await git(root, 'commit', '-am', 'Other');
    await git(root, 'checkout', 'main'); await writeFile(path.join(root, 'folder/conflict.txt'), 'main\n'); await git(root, 'commit', '-am', 'Main'); await git(root, 'merge', 'other').catch(() => {});
    const service = new GitService(); const { repository } = await service.registerRepository(root); const listing = await service.listProjectDirectory(repository.id, null); const folder = await service.listProjectDirectory(repository.id, entry(listing, 'folder').id);
    expect(folder.facts).toMatchObject({ git: { state: 'clean' }, changes: { descendants: { conflicted: 1 } } }); expect(entry(folder, 'conflict.txt').facts?.git.state).toBe('conflicted');
  });

  it('decorates a large ignored dependency root without descending into its files', async () => {
    const root = await fixture({ 'package.json': '{}', '.gitignore': 'node_modules/\n.vite/\n', 'build/authored.ts': 'authored' });
    await mkdir(path.join(root, 'node_modules/package'), { recursive: true }); await mkdir(path.join(root, '.vite'));
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(root, `node_modules/package/file-${i}.js`), 'dependency'))); await writeFile(path.join(root, '.vite/cache'), 'generated');
    const service = new GitService(); const { repository } = await service.registerRepository(root); vi.mocked(fs.opendir).mockClear();
    const listing = await service.listProjectDirectory(repository.id, null);
    expect(entry(listing, 'node_modules').facts).toMatchObject({ role: { kind: 'library', declared: true }, library: { rootPath: 'node_modules' }, inclusion: { state: 'excluded' }, git: { state: 'ignored' } });
    expect(entry(listing, '.vite').facts).toMatchObject({ role: { kind: 'ordinary' }, inclusion: { state: 'included' }, git: { state: 'ignored' } });
    expect(entry(listing, 'build').facts).toMatchObject({ role: { kind: 'ordinary' }, generated: { value: false }, inclusion: { state: 'included' } });
    expect(vi.mocked(fs.opendir).mock.calls.map(call => String(call[0]))).toEqual([repository.path]);
    const dependencies = await service.listProjectDirectory(repository.id, entry(listing, 'node_modules').id);
    expect(entry(dependencies, 'package').facts).toMatchObject({ role: { declared: false }, library: { rootPath: 'node_modules' }, inclusion: { state: 'inherited-exclusion' } });
  });

  it('persists manual roles/preferences, invalidates generations, and resets to metadata without altering Git files', async () => {
    const root = await fixture({ 'tsconfig.json': '{"compilerOptions":{"rootDir":"source","outDir":"generated"}}', 'source/file.ts': 'authored', 'generated/file.ts': 'needle', 'checks/test.ts': 'test' });
    const settings = await fixture({}, false); const service = new GitService({ projectSettingsDirectory: settings }); const { repository } = await service.registerRepository(root); const original = await readFile(path.join(root, '.git/index'));
    let listing = await service.listProjectDirectory(repository.id, null); const generated = entry(listing, 'generated'), checks = entry(listing, 'checks');
    expect(generated.facts).toMatchObject({ generated: { value: true }, inclusion: { state: 'excluded' } }); expect(await service.readSearchFile(repository.id, 'generated/file.ts')).toBeNull();
    await service.markProjectDirectory(repository.id, generated.id, 'included'); await service.markProjectDirectory(repository.id, checks.id, 'generated-test-sources'); await service.setProjectTreePreferences(repository.id, { showHidden: false });
    listing = await service.listProjectDirectory(repository.id, null); expect(listing.generation).toBeGreaterThan(generated.facts!.generation); expect(await service.readSearchFile(repository.id, 'generated/file.ts')).toMatchObject({ text: 'needle' });
    expect(entry(listing, 'checks').facts).toMatchObject({ role: { kind: 'test-sources', declared: true }, generated: { value: true }, scopes: [{ kind: 'test' }] });
    const restored = new GitService({ projectSettingsDirectory: settings }); const next = await restored.registerRepository(root); expect(restored.getProjectTreePreferences(next.repository.id).showHidden).toBe(false);
    expect(entry(await restored.listProjectDirectory(next.repository.id, null), 'checks').facts?.role.kind).toBe('test-sources');
    await service.markProjectDirectory(repository.id, generated.id, null); expect(await service.readSearchFile(repository.id, 'generated/file.ts')).toBeNull();
    await service.markProjectDirectory(repository.id, checks.id, 'excluded'); const child = await service.listProjectDirectory(repository.id, checks.id); const file = await service.readProjectFile(repository.id, entry(child, 'test.ts').id);
    expect(file.facts).toMatchObject({ inclusion: { state: 'inherited-exclusion', reason: { source: 'user' } }, git: { tracked: true, state: 'clean' } });
    expect(await readFile(path.join(root, '.git/index'))).toEqual(original);
    await expect(service.markProjectDirectory(next.repository.id, generated.id, 'sources')).rejects.toThrow('Unknown repository');
  });

  it('reports symlinks, broken links, submodules and nested repositories without entering their namespace', async () => {
    const root = await fixture({ 'file.ts': 'source' }); await symlink('file.ts', path.join(root, 'link')); await symlink('missing', path.join(root, 'broken')); await mkdir(path.join(root, 'nested')); await git(path.join(root, 'nested'), 'init');
    const oid = (await git(root, 'rev-parse', 'HEAD')).trim(); await git(root, 'update-index', '--add', '--cacheinfo', `160000,${oid},module`); await mkdir(path.join(root, 'module')); await writeFile(path.join(root, 'module/file.ts'), 'nested');
    const service = new GitService(); const { repository } = await service.registerRepository(root); const listing = await service.listProjectDirectory(repository.id, null);
    expect(entry(listing, 'link').facts?.identity.symlink).toBe('file'); expect(entry(listing, 'broken').facts?.identity.symlink).toBe('broken'); expect(entry(listing, 'module').facts?.identity.kind).toBe('submodule');
    expect(entry(listing, 'nested').facts).toMatchObject({ identity: { nestedRepository: true }, git: { state: 'not-applicable' } });
    await expect(service.listProjectDirectory(repository.id, entry(listing, 'nested').id)).rejects.toThrow('separate project'); expect(await service.readSearchFile(repository.id, 'module/file.ts')).toBeNull();
  });

  it('supports non-Git browse/edit/search while preserving exclusions and Git-internal boundaries', async () => {
    const root = await fixture({ 'package.json': '{}', 'plain.txt': 'needle', 'node_modules/pkg/a.txt': 'needle', 'authored/build.txt': 'needle', 'nested/.git/config': 'needle', 'nested/file.txt': 'needle' }, false);
    const service = new GitService(); const { repository } = await service.registerRepository(root); expect(repository.gitAvailable).toBe(false); const listing = await service.listProjectDirectory(repository.id, null);
    const plain = entry(listing, 'plain.txt'); expect(plain.facts?.git.state).toBe('not-applicable'); const opened = await service.readProjectFile(repository.id, plain.id); expect(opened.content?.editable).toBeDefined();
    const search = new FileSearchService(service); const batches: FileSearchBatch[] = [];
    await new Promise<void>((resolve, reject) => { search.start('owner', repository.id, { requestId: 'no-git', query: 'needle' }, batch => { batches.push(batch); if (batch.done) resolve(); }).catch(reject); });
    expect(batches.at(-1)?.error).toBeUndefined(); expect(batches.flatMap(batch => batch.results.map(row => row.entry.path)).sort()).toEqual(['authored/build.txt', 'plain.txt']);
    const before = await service.getRepositoryWatchState(repository.id); await writeFile(path.join(root, 'plain.txt'), 'changed'); expect((await service.getRepositoryWatchState(repository.id)).signature).not.toBe(before.signature);
  });

  it('invalidates ignore-only and metadata-only changes even when Git status stays unchanged', async () => {
    const root = await fixture({ 'package.json': '{}', '.gitignore': 'ignored/\n', 'ignored/kept.txt': 'before' });
    await mkdir(path.join(root, 'ignored'), { recursive: true }); await writeFile(path.join(root, 'ignored/cache.txt'), 'ignored');
    const excludes = path.join(root, '.custom-excludes'); await writeFile(excludes, '*.hidden\n'); await git(root, 'config', 'core.excludesFile', excludes); await writeFile(path.join(root, 'test.hidden'), 'ignored');
    const service = new GitService(); const { repository } = await service.registerRepository(root); await service.listProjectDirectory(repository.id, null);
    const first = await service.getRepositoryWatchState(repository.id); const statusBefore = await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all');
    await writeFile(excludes, '# changed provenance\n*.hidden\n');
    expect(await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all')).toBe(statusBefore);
    expect((await service.getRepositoryWatchState(repository.id)).signature).not.toBe(first.signature);
    await service.refreshRepository(repository.id); const second = await service.getRepositoryWatchState(repository.id);
    await writeFile(path.join(root, 'package.json'), '{"name":"changed"}'); expect((await service.getRepositoryWatchState(repository.id)).signature).not.toBe(second.signature);
  });

  it('rejects a stale listing and propagates a newly-created nested repository boundary to old capabilities', async () => {
    const root = await fixture({ 'nested/child/file.ts': 'source' }); const service = new GitService(); const { repository } = await service.registerRepository(root); const listing = await service.listProjectDirectory(repository.id, null); const nested = entry(listing, 'nested');
    const childListing = await service.listProjectDirectory(repository.id, nested.id); const child = entry(childListing, 'child'); const files = await service.listProjectDirectory(repository.id, child.id); const file = entry(files, 'file.ts');
    await git(path.join(root, 'nested'), 'init'); await service.refreshRepository(repository.id);
    const result = await service.readProjectFile(repository.id, file.id);
    expect(result).toMatchObject({ state: 'unavailable', facts: { identity: { repositoryRoot: 'nested' }, git: { state: 'not-applicable' }, changes: { descendants: { total: 0 } } } });
    await expect(service.listProjectDirectory(repository.id, child.id)).rejects.toThrow('separate project');
    // Pause decoration after enumeration, advance the project generation, and
    // ensure the older root response cannot replace newer renderer metadata.
    const original = vi.mocked(fs.opendir).getMockImplementation()!; let release!: () => void; let opened!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { opened = resolve; });
    vi.mocked(fs.opendir).mockImplementationOnce(async (...args) => { const handle = await original(...args); opened(); await pause; return handle; });
    const pending = service.listProjectDirectory(repository.id, null); await reached; await service.markProjectDirectory(repository.id, null, 'sources'); release(); await expect(pending).rejects.toThrow('Project state changed');
  });

  it('never converts unavailable ignore facts into an untracked assertion', () => {
    expect(nodeGitFacts(projectGitSnapshot([], new Set()), 'unknown.txt', false, { unavailable: true }, true)).toMatchObject({ state: 'unavailable', ignored: 'unknown', tracked: false });
  });
});
