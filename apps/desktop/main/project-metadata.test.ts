import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectMetadata, type ProjectMetadataIO } from './project-metadata';
import { defaultNodeFacts, defaultTreePreferences } from '../../shared/project/semantics';
import { resolveTreePresentation } from '../../shared/project/presentation';
import { referenceTreeTheme } from '../../shared/project/theme';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string> = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-project-metadata-'));
  roots.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const reads: string[] = [];
  const listings: string[] = [];
  const io: ProjectMetadataIO = {
    async readText(file) { reads.push(file); try { return await readFile(path.join(root, file), 'utf8'); } catch { return null; } },
    async listDirectory(directory) {
      listings.push(directory);
      try { return (await readdir(path.join(root, directory), { withFileTypes: true })).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' as const : entry.isSymbolicLink() ? 'symlink' as const : 'file' as const })); }
      catch { return []; }
    },
  };
  const settings = path.join(parent, 'user-data');
  const metadata = new ProjectMetadata(root, settings);
  await metadata.refresh(io);
  return { parent, root, settings, metadata, io, reads, listings };
}

describe('project metadata', () => {
  it('recognizes Go test files without inventing roots or changing their Git foreground', async () => {
    const { metadata, reads, listings } = await fixture();
    const readCount = reads.length, listingCount = listings.length;
    const classification = metadata.classify('api/execution_http_test.go', 'file');
    expect(classification).toMatchObject({ role: { kind: 'ordinary', declared: false }, inclusion: { state: 'included' }, scopes: [{ kind: 'test', rootPath: 'api/execution_http_test.go' }] });
    expect(metadata.classify('api', 'directory').scopes).toEqual([]);
    expect(metadata.classify('api/runtime.go', 'file').scopes).toEqual([]);
    expect(metadata.classify('api/runtime_test.go', 'directory').scopes).toEqual([]);
    expect(metadata.classify('api/runtime_test.go', 'symlink').scopes).toEqual([]);
    const facts = { ...defaultNodeFacts('repo', 'api/execution_http_test.go', 'file'), ...classification };
    facts.git.state = 'modified'; facts.git.workingTree = 'modified';
    const present = (selected = false, hovered = false) => resolveTreePresentation(facts, referenceTreeTheme, defaultTreePreferences, { selected, focused: true, hovered });
    expect(present()).toMatchObject({ foreground: referenceTreeTheme.modified, background: referenceTreeTheme.testBackground, icon: 'file' });
    expect(present().tooltip).toContain('Go test source (_test.go)');
    expect(present(true)).toMatchObject({ foreground: referenceTreeTheme.modified, background: referenceTreeTheme.selection });
    expect(present(false, true).background).toBe(referenceTreeTheme.hover);
    expect(resolveTreePresentation(facts, referenceTreeTheme, { ...defaultTreePreferences, scopeBackgrounds: false }).background).toBeUndefined();
    expect(reads).toHaveLength(readCount); expect(listings).toHaveLength(listingCount);
  });

  it('keeps Go test scopes independent from source roots, exclusions, and library scopes', async () => {
    const { metadata } = await fixture({ 'package.json': '{}' });
    await metadata.mark('api', 'sources');
    expect(metadata.classify('api/runtime_test.go', 'file')).toMatchObject({ role: { kind: 'sources', declared: false }, scopes: [{ kind: 'test' }] });
    await metadata.mark('api', 'excluded');
    const classification = metadata.classify('api/runtime_test.go', 'file');
    expect(classification.inclusion.state).toBe('inherited-exclusion');
    expect(classification.scopes.map(scope => scope.kind)).toEqual(['non-project', 'test']);
    const facts = { ...defaultNodeFacts('repo', 'api/runtime_test.go', 'file'), ...classification };
    expect(resolveTreePresentation(facts, referenceTreeTheme, defaultTreePreferences).background).toBe(referenceTreeTheme.dependencyBackground);
    expect(metadata.classify('node_modules/native/runtime_test.go', 'file').scopes.map(scope => scope.kind)).toEqual(['non-project', 'test']);
    await metadata.mark('api', 'test-sources');
    expect(metadata.classify('api/runtime_test.go', 'file').scopes).toHaveLength(1);
  });

  it('does not infer semantic roles, exclusion, or generated status from names', async () => {
    const { metadata } = await fixture();
    for (const name of ['src', 'test', 'resources', 'build', 'dist', 'out', 'coverage', 'target', 'vendor', 'node_modules', '.idea', '.cache', '.next', '.gradle', '.venv']) {
      const facts = metadata.classify(name, 'directory');
      expect(facts.role.kind, name).toBe('ordinary');
      expect(facts.inclusion.state, name).toBe('included');
      expect(facts.generated.value, name).toBe(false);
      expect(facts.scopes, name).toEqual([]);
    }
    expect(metadata.classify('', 'directory').role.kind).toBe('content');
  });

  it('classifies dependencies only in observed package contexts, with inherited library scope', async () => {
    const { metadata, io, reads, listings } = await fixture({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/one/package.json': '{"name":"one"}',
      'packages/two/package.json': 'not JSON',
      'node_modules/a/package.json': '{"name":"should-not-read"}',
    });
    expect(metadata.classify('node_modules', 'directory').library?.rootPath).toBe('node_modules');
    expect(metadata.classify('node_modules', 'directory').role.declared).toBe(true);
    expect(metadata.classify('node_modules/a/index.js', 'file').role.declared).toBe(false);
    expect(metadata.classify('node_modules/a/index.js', 'file').inclusion.state).toBe('inherited-exclusion');
    await metadata.mark('node_modules/a', 'sources');
    expect(metadata.classify('node_modules/a/index.js', 'file')).toMatchObject({ role: { kind: 'sources', declared: false }, library: { rootPath: 'node_modules' }, inclusion: { state: 'included' } });
    await metadata.mark('node_modules/a', null);
    expect(metadata.classify('unrelated/node_modules', 'directory').library).toBeUndefined();
    await metadata.observeDirectory('packages/one', io);
    await metadata.observeDirectory('packages/two', io);
    expect(metadata.classify('packages/one/node_modules/a', 'directory').library?.rootPath).toBe('packages/one/node_modules');
    expect(metadata.classify('packages/two/node_modules', 'directory').library).toBeUndefined();
    await metadata.observeDirectory('node_modules/a', io);
    expect(reads).not.toContain('node_modules/a/package.json');
    expect(listings).toEqual(['', '.idea']);
  });

  it('requires a directory at a declared root rather than annotating a same-named file or symlink', async () => {
    const { metadata } = await fixture({ 'package.json': '{}', 'tsconfig.json': '{"compilerOptions":{"rootDir":"source","outDir":"output"}}' });
    for (const kind of ['file', 'symlink'] as const) {
      expect(metadata.classify('node_modules', kind)).toMatchObject({ role: { kind: 'ordinary', declared: false }, inclusion: { state: 'included' } });
      expect(metadata.classify('node_modules', kind).library).toBeUndefined();
      expect(metadata.classify('source', kind).role.kind).toBe('ordinary');
      expect(metadata.classify('output', kind)).toMatchObject({ generated: { value: false }, inclusion: { state: 'included' } });
    }
    expect(metadata.classify('source/file.ts', 'file').role).toMatchObject({ kind: 'sources', declared: false });
  });

  it('uses explicit TypeScript rootDir/outDir, including JSONC, without guessing other directories', async () => {
    const { metadata } = await fixture({
      'tsconfig.json': '{ // safe JSONC\n "compilerOptions": { "rootDir": "authored", "outDir": "build/output", }, }',
    });
    expect(metadata.classify('authored/feature.ts', 'file').role).toMatchObject({ kind: 'sources', rootPath: 'authored', reason: { source: 'project-metadata', path: 'tsconfig.json' } });
    expect(metadata.classify('build', 'directory').inclusion.state).toBe('included');
    expect(metadata.classify('build/output', 'directory')).toMatchObject({ generated: { value: true }, inclusion: { state: 'excluded' } });
    expect(metadata.classify('build/output/index.js', 'file').inclusion.state).toBe('inherited-exclusion');
    expect(metadata.classify('build/author.ts', 'file').generated.value).toBe(false);
    expect(metadata.classify('build/output-other', 'directory').generated.value).toBe(false);
  });

  it('does not evaluate configuration or follow unsafe and unsupported paths', async () => {
    const { metadata } = await fixture({
      'tsconfig.json': '{"compilerOptions":{"rootDir":"../../outside","outDir":"."}}',
      'vite.config.ts': 'throw new Error("do not execute")',
      'webpack.config.js': 'throw new Error("do not execute")',
    });
    expect(metadata.classify('', 'directory').inclusion.state).toBe('included');
    expect(metadata.classify('dist', 'directory').generated.value).toBe(false);
    expect(metadata.getMetadataPaths()).not.toContain('vite.config.ts');
  });

  it('imports direct IntelliJ module declarations with reasons and independent generated/test state', async () => {
    const { metadata, listings } = await fixture({
      'package.json': '{}',
      '.idea/project.iml': '<module><component><content url="file://$PROJECT_DIR$"><sourceFolder url="file://$PROJECT_DIR$/checks" isTestSource="true" generated="true"/><sourceFolder url="file://$PROJECT_DIR$/assets" type="java-resource"/><sourceFolder url="file://$PROJECT_DIR$/fixtures" type="java-test-resource"/><excludeFolder url="file://$PROJECT_DIR$/temporary"/></content></component></module>',
    });
    expect(metadata.classify('checks/a.ts', 'file')).toMatchObject({ role: { kind: 'test-sources', reason: { source: 'project-metadata', path: '.idea/project.iml' } }, generated: { value: true }, inclusion: { state: 'included' }, scopes: [{ kind: 'test', rootPath: 'checks' }] });
    expect(metadata.classify('assets', 'directory').role.kind).toBe('resources');
    expect(metadata.classify('fixtures', 'directory').role.kind).toBe('test-resources');
    expect(metadata.classify('temporary/file', 'file').inclusion.state).toBe('inherited-exclusion');
    expect(metadata.classify('.idea', 'directory').inclusion.state).toBe('included');
    expect(metadata.classify('.idea', 'directory').role.kind).toBe('ordinary');
    expect(metadata.classify('node_modules/a/index.js', 'file').role.kind).toBe('library');
    expect(listings).toEqual(['', '.idea']);
  });

  it('ignores malformed, external and entity-bearing XML declarations', async () => {
    const { metadata } = await fixture({
      'bad.iml': '<module><sourceFolder url="file://$PROJECT_DIR$/bad"></module>',
      '.idea/entity.iml': '<!DOCTYPE module [<!ENTITY secret SYSTEM "file:///etc/passwd">]><module><sourceFolder url="file://$PROJECT_DIR$/evil"/></module>',
      '.idea/outside.iml': '<module><sourceFolder url="file://$PROJECT_DIR$/../../outside"/><sourceFolder url="jar://$PROJECT_DIR$/archive.jar!/"/></module>',
    });
    for (const name of ['bad', 'evil', 'outside', 'archive.jar']) expect(metadata.classify(name, 'directory').role.kind).toBe('ordinary');
  });

  it('prioritizes imported declarations over detection and reapplies them after reset', async () => {
    const { metadata } = await fixture({
      'tsconfig.json': '{"compilerOptions":{"outDir":"checks"}}',
      'module.iml': '<module><sourceFolder url="file://$MODULE_DIR$/checks" isTestSource="true"/></module>',
    });
    expect(metadata.classify('checks/example.ts', 'file')).toMatchObject({ role: { kind: 'test-sources' }, generated: { value: false }, inclusion: { state: 'included' } });
    await metadata.mark('checks', 'excluded');
    expect(metadata.classify('checks/example.ts', 'file').inclusion.reason.source).toBe('user');
    await metadata.mark('checks', null);
    expect(metadata.classify('checks/example.ts', 'file')).toMatchObject({ role: { kind: 'test-sources' }, inclusion: { state: 'included', reason: { source: 'project-metadata' } } });
  });

  it('does not apply incomplete JSONC configuration', async () => {
    const { metadata } = await fixture({ 'tsconfig.json': '{"compilerOptions":{"outDir":"output"}} /* incomplete comment' });
    expect(metadata.classify('output', 'directory').generated.value).toBe(false);
  });

  it('gives user markings precedence and reset restores detected metadata', async () => {
    const { metadata } = await fixture({ 'tsconfig.json': '{"compilerOptions":{"outDir":"generated"}}' });
    await metadata.mark('generated', 'included');
    expect(metadata.classify('generated/a.ts', 'file')).toMatchObject({ inclusion: { state: 'included', reason: { source: 'user' } }, generated: { value: true } });
    await metadata.mark('generated', null);
    expect(metadata.classify('generated/a.ts', 'file').inclusion.state).toBe('inherited-exclusion');
    await metadata.mark('generated', 'sources');
    expect(metadata.classify('generated/a.ts', 'file')).toMatchObject({ role: { kind: 'sources' }, inclusion: { state: 'included' }, generated: { value: false } });
    await metadata.mark('generated', 'generated-test-sources');
    expect(metadata.classify('generated/a.ts', 'file')).toMatchObject({ role: { kind: 'test-sources' }, inclusion: { state: 'included' }, generated: { value: true } });
  });

  it('allows an explicitly included child within inherited user exclusion', async () => {
    const { metadata } = await fixture();
    await metadata.mark('folder', 'excluded');
    await metadata.mark('folder/source', 'included');
    expect(metadata.classify('folder/source/a.ts', 'file').inclusion.state).toBe('included');
    expect(metadata.classify('folder/other/a.ts', 'file').inclusion.state).toBe('inherited-exclusion');
    await metadata.mark('folder/source', null);
    expect(metadata.classify('folder/source/a.ts', 'file').inclusion.state).toBe('inherited-exclusion');
  });

  it('persists independent preferences and markings across instances and project roots', async () => {
    const { metadata, root, settings } = await fixture();
    await Promise.all([metadata.setPreferences({ showIgnored: false }), metadata.setPreferences({ scopeBackgrounds: false }), metadata.mark('spec', 'test-sources')]);
    const restored = new ProjectMetadata(root, settings);
    await restored.load();
    expect(restored.getPreferences()).toMatchObject({ showIgnored: false, scopeBackgrounds: false, highlightChangedDirectories: false });
    expect(restored.classify('spec/example.ts', 'file').role.kind).toBe('test-sources');
    const other = new ProjectMetadata(path.join(root, 'different-project'), settings);
    await other.load();
    await restored.setPreferences({ showIgnored: undefined });
    expect(restored.getPreferences().showIgnored).toBe(false);
    expect(other.getPreferences().showIgnored).toBe(true);
    expect(other.classify('spec', 'directory').role.kind).toBe('ordinary');
    expect((await readdir(path.join(settings, 'project-trees'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refreshes previously observed nested metadata without scanning children', async () => {
    const { root, metadata, io, listings } = await fixture({ 'packages/app/package.json': '{}', 'packages/app/tsconfig.json': '{"compilerOptions":{"outDir":"output"}}' });
    await metadata.observeDirectory('packages/app', io);
    expect(metadata.classify('packages/app/output/a.js', 'file').generated.value).toBe(true);
    await writeFile(path.join(root, 'packages/app/tsconfig.json'), '{"compilerOptions":{"outDir":"new-output"}}');
    await metadata.refresh(io);
    expect(metadata.classify('packages/app/output/a.js', 'file').generated.value).toBe(false);
    expect(metadata.classify('packages/app/new-output/a.js', 'file').generated.value).toBe(true);
    expect(metadata.getMetadataPaths()).toContain('packages/app/package.json');
    expect(listings).toEqual(['', '.idea', '', '.idea']);
  });

  it('rejects traversal markings and safely handles object-prototype directory names', async () => {
    const { metadata, root, settings } = await fixture();
    for (const relative of ['../outside', '/absolute', 'a/../b', '.git', 'a//b', 'a\\b']) await expect(metadata.mark(relative, 'sources')).rejects.toThrow();
    await metadata.mark('__proto__', 'resources');
    const restored = new ProjectMetadata(root, settings);
    await restored.load();
    expect(restored.classify('__proto__/file', 'file').role.kind).toBe('resources');
    expect(restored.classify('constructor', 'directory').role.kind).toBe('ordinary');
  });

  it('ignores oversized metadata and malformed preferences', async () => {
    const { root, settings, metadata } = await fixture({ 'package.json': `{"name":"${'x'.repeat(256 * 1024)}"}` });
    expect(metadata.classify('node_modules', 'directory').library).toBeUndefined();
    await metadata.mark('source', 'sources');
    const file = (await readdir(path.join(settings, 'project-trees')))[0];
    await writeFile(path.join(settings, 'project-trees', file), 'not valid json');
    const restored = new ProjectMetadata(root, settings);
    await restored.load();
    expect(restored.classify('source', 'directory').role.kind).toBe('ordinary');
  });
});
