import { describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../../desktop/src/bridge';
import { displayProjectName, isCurrentProjectDirectory, projectAncestors, projectEntryFacts, projectRows, type DirectoryState } from './tree';
import { defaultNodeFacts, defaultTreePreferences } from './semantics';
import { isTreeNodeVisible } from './presentation';

const entries: ProjectEntry[] = [
  { id: 'opaque-folder', name: 'src', path: 'src', kind: 'directory' },
  { id: 'opaque-link', name: 'external', path: 'external', kind: 'symlink' },
  { id: 'opaque-file', name: 'README.md', path: 'README.md', kind: 'file' },
];
const directories = new Map<string, DirectoryState>([
  ['', { state: 'ready', directory: { repositoryId: 'repo', directoryId: null, path: '', entries, truncated: false } }],
  ['src', { state: 'ready', directory: { repositoryId: 'repo', directoryId: 'opaque-folder', path: 'src', entries: [{ id: 'child', name: 'hello\n世界.ts', path: 'src/hello\n世界.ts', kind: 'file' }], truncated: false } }],
]);

describe('project tree correspondence', () => {
  it('shows only expanded branches and retains opaque entry identifiers', () => {
    expect(projectRows(directories, new Set()).map(row => row.path)).toEqual(['']);
    const rows = projectRows(directories, new Set(['']));
    expect(rows.map(row => row.path)).toEqual(['', 'src', 'external', 'README.md']);
    expect(rows[1]).toMatchObject({ entry: { id: 'opaque-folder' }, depth: 1, position: 1, siblings: 3 });
  });
  it('finds parents for keyboard traversal without treating a symlink as an expandable directory', () => {
    const rows = projectRows(directories, new Set(['', 'src', 'external']));
    expect(rows.map(row => row.path)).toEqual(['', 'src', 'src/hello\n世界.ts', 'external', 'README.md']);
    expect(rows[2]).toMatchObject({ parentPath: 'src', depth: 2, position: 1, siblings: 1 });
    expect(rows[3].entry?.kind).toBe('symlink');
  });
  it('reveals ancestors without splitting or altering unusual filenames', () => {
    expect(projectAncestors('apps/hello\n世界/a\tb.ts')).toEqual(['', 'apps', 'apps/hello\n世界']);
    expect(projectAncestors('readme.md')).toEqual(['']);
    expect(displayProjectName('hello\n世界\t.ts')).toBe('hello↵世界⇥.ts');
  });
  it('keeps the root accessible during loading or errors', () => {
    expect(projectRows(new Map([['', { state: 'error', error: 'Gone' }]]), new Set(['']))).toEqual([{ path: '', depth: 0, position: 1, siblings: 1 }]);
  });
  it('filters branches without changing expansion state, order, or visible sibling positions', () => {
    const expanded = new Set(['', 'src']);
    const rows = projectRows(directories, expanded, entry => entry.kind !== 'symlink');
    expect(rows.map(row => row.path)).toEqual(['', 'src', 'src/hello\n世界.ts', 'README.md']);
    expect(rows[1]).toMatchObject({ position: 1, siblings: 2 });
    expect(rows[3]).toMatchObject({ position: 2, siblings: 2 });
    expect(projectRows(directories, expanded, entry => entry.path !== 'src').map(row => row.path)).toEqual(['', 'external', 'README.md']);
    expect([...expanded]).toEqual(['', 'src']);
    expect(projectRows(directories, expanded).map(row => row.path)).toEqual(['', 'src', 'src/hello\n世界.ts', 'external', 'README.md']);
  });
  it('keeps hidden, excluded and ignored visibility independent', () => {
    const hidden = defaultNodeFacts('repo', '.idea', 'directory');
    const ignored = defaultNodeFacts('repo', 'cache', 'directory');
    ignored.git.ignored = true;
    const excluded = defaultNodeFacts('repo', 'generated', 'directory');
    excluded.inclusion.state = 'excluded';
    expect(isTreeNodeVisible(hidden, { ...defaultTreePreferences, showIgnored: false })).toBe(true);
    expect(isTreeNodeVisible(hidden, { ...defaultTreePreferences, showHidden: false })).toBe(false);
    expect(isTreeNodeVisible(ignored, { ...defaultTreePreferences, showExcluded: false })).toBe(true);
    expect(isTreeNodeVisible(ignored, { ...defaultTreePreferences, showIgnored: false })).toBe(false);
    expect(isTreeNodeVisible(excluded, { ...defaultTreePreferences, showIgnored: false })).toBe(true);
    expect(isTreeNodeVisible(excluded, { ...defaultTreePreferences, showExcluded: false })).toBe(false);
  });
  it('uses backend facts and neutral directory fallbacks without pathname roles', () => {
    const facts = defaultNodeFacts('repo', 'src', 'directory');
    facts.role = { kind: 'sources', declared: true, rootPath: 'src', reason: { source: 'user', description: 'Marked sources' } };
    expect(projectEntryFacts('repo', { ...entries[0], facts })).toBe(facts);
    expect(projectEntryFacts('repo', { ...entries[0], status: '??' })).toMatchObject({ role: { kind: 'ordinary' }, git: { state: 'not-applicable' } });
    expect(projectEntryFacts('other-repo', { ...entries[0], facts })).toMatchObject({ repositoryId: 'other-repo', role: { kind: 'ordinary' } });
    expect(projectEntryFacts('repo', { ...entries[2], status: 'AM' }).git).toMatchObject({ state: 'modified', index: 'added', workingTree: 'modified', tracked: true });
  });
  it('rejects cross-repository or stale directory decorations as one snapshot', () => {
    const listing = { ...directories.get('')!.directory!, generation: 5, facts: defaultNodeFacts('repo', '', 'directory', 5), entries: entries.map(entry => ({ ...entry, facts: defaultNodeFacts('repo', entry.path, entry.kind, 5) })) };
    expect(isCurrentProjectDirectory(listing, 'repo', '', 5)).toBe(true);
    expect(isCurrentProjectDirectory(listing, 'repo', '', 6)).toBe(false);
    expect(isCurrentProjectDirectory(listing, 'other', '', 0)).toBe(false);
    expect(isCurrentProjectDirectory(listing, 'repo', 'src', 0)).toBe(false);
    expect(isCurrentProjectDirectory({ ...listing, entries: [{ ...listing.entries[0], facts: { ...listing.entries[0].facts, generation: 4 } }] }, 'repo', '', 0)).toBe(false);
    expect(isCurrentProjectDirectory(directories.get('')!.directory!, 'repo', '', 0)).toBe(true);
  });
});
