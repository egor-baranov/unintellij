import { describe, expect, it } from 'vitest';
import { defaultNodeFacts, defaultTreePreferences, type TreeGitState, type TreeNodeFacts } from './semantics';
import { referenceTreeTheme as theme } from './theme';
import { isTreeNodeVisible, resolveTreePresentation as resolve } from './presentation';
const prefs = { ...defaultTreePreferences };
const node = (path = 'src', kind: TreeNodeFacts['identity']['kind'] = 'directory') => {
  const facts = defaultNodeFacts('repo', path, kind);
  facts.git = { state: 'clean', index: 'clean', workingTree: 'clean', tracked: true, ignored: false };
  return facts;
};
const scope = (kind: 'test' | 'non-project' | 'custom', id: string = kind, priority = 0, color?: string) => ({ id, kind, rootPath: 'src', priority, color, reason: { source: 'user' as const, description: `${id} scope` } });
describe('semantic Project tree presentation', () => {
  it('never derives color from a dot-prefix or candidate basename', () => {
    for (const name of ['.github', '.gitlab', '.devcontainer', '.husky', '.vscode', '.idea', '.vite', '.cache', '.env', 'build', 'vendor', 'src', 'tests']) {
      const facts = node(name);
      expect(resolve(facts, theme, prefs).foreground, name).toBe(theme.foreground);
      expect(resolve(facts, theme, prefs).background, name).toBeUndefined();
      expect(resolve(facts, theme, prefs).icon, name).toBe('folder');
    }
  });
  it('maps actual file states independently, retaining staged and working facts', () => {
    for (const state of ['modified', 'added', 'renamed', 'copied', 'deleted', 'untracked', 'ignored', 'conflicted', 'unavailable'] as TreeGitState[]) {
      const facts = node('file.ts', 'file'); facts.git.state = state;
      expect(resolve(facts, theme, prefs).foreground).toBe(theme[state as keyof typeof theme]);
    }
    const facts = node('file.ts', 'file'); facts.git.index = 'added'; facts.git.workingTree = 'modified'; facts.git.state = 'modified';
    expect(resolve(facts, theme, prefs).tooltip).toContain('Index: added; working tree: modified');
    facts.git.index = 'conflicted';
    expect(resolve(facts, theme, prefs).foreground).toBe(theme.conflicted);
  });
  it('keeps inclusion, role, generated status, Git foreground, and diagnostics separate', () => {
    const facts = node('src'); facts.role = { kind: 'sources', declared: true, rootPath: 'src', reason: { source: 'user', description: 'Marked as Sources' } };
    facts.generated.value = true; facts.changes.descendants.modified = facts.changes.descendants.total = 1;
    facts.diagnostics.descendantErrors = 1;
    const result = resolve(facts, theme, { ...prefs, highlightChangedDirectories: true });
    expect(result).toMatchObject({ icon: 'sources', foreground: theme.modified, overlays: ['generated'], diagnosticUnderline: { severity: 'error' } });
    facts.inclusion = { state: 'excluded', rootPath: 'src', reason: { source: 'user', description: 'Excluded by project setting' } };
    facts.changes.descendants.modified = facts.changes.descendants.total = 0;
    expect(resolve(facts, theme, prefs)).toMatchObject({ icon: 'excluded', foreground: theme.foreground });
    facts.diagnostics.descendantErrors = 0;
    expect(resolve(facts, theme, prefs).diagnosticUnderline).toBeUndefined();
  });
  it('annotates only an actual library root and preserves a child Git state', () => {
    const facts = node('node_modules'); facts.library = { rootPath: 'node_modules', reason: { source: 'detection', description: 'Library root: project dependencies' } };
    facts.role = { kind: 'library', declared: true, rootPath: 'node_modules', reason: facts.library.reason };
    facts.scopes = [scope('non-project')]; facts.git.state = 'ignored'; facts.git.ignored = true;
    expect(resolve(facts, theme, prefs)).toMatchObject({ icon: 'library', foreground: theme.ignored, annotation: 'library root', background: theme.dependencyBackground });
    const child = { ...facts, path: 'node_modules/pkg', role: { ...facts.role, declared: false }, git: { ...facts.git, ignored: false, state: 'modified' as const } };
    expect(resolve(child, theme, prefs).annotation).toBeUndefined();
    expect(resolve(child, theme, prefs).icon).toBe('folder');
  });
  it('gives ignored/untracked names no automatic scope background or exclusion', () => {
    const facts = node('.idea'); facts.git.state = 'ignored'; facts.git.ignored = true;
    const colors = { ...theme, ignored: '#ccaa88', untracked: '#ddbb99' };
    expect(resolve(facts, colors, prefs)).toMatchObject({ icon: 'folder', foreground: '#ccaa88', background: undefined });
    expect(isTreeNodeVisible(facts, { ...prefs, showExcluded: false })).toBe(true);
    expect(isTreeNodeVisible(facts, { ...prefs, showIgnored: false })).toBe(false);
    facts.git.state = 'untracked'; facts.git.ignored = false;
    expect(resolve(facts, colors, prefs).foreground).toBe(colors.foreground);
    expect(isTreeNodeVisible(facts, { ...prefs, showIgnored: false })).toBe(true);
    facts.identity.kind = 'file';
    expect(resolve(facts, colors, prefs).foreground).toBe('#ddbb99');
  });
  it('resolves scope overlaps deterministically and restores them after selection', () => {
    const facts = node(); facts.scopes = [scope('test'), scope('non-project'), scope('custom', 'z', 3, '#334455'), scope('custom', 'a', 3, '#112233')];
    expect(resolve(facts, theme, prefs).background).toBe('#112233');
    expect(resolve(facts, theme, prefs, { selected: true, focused: true }).background).toBe(theme.selection);
    expect(resolve(facts, theme, prefs, { selected: true, hovered: true }).background).toBe(theme.unfocusedSelection);
    expect(resolve(facts, theme, prefs, { hovered: true }).background).toBe(theme.hover);
    expect(resolve(facts, theme, prefs).background).toBe('#112233');
    expect(resolve(facts, theme, { ...prefs, scopeBackgrounds: false }).background).toBeUndefined();
    facts.scopes = [scope('test'), scope('non-project')];
    expect(resolve(facts, theme, prefs).background).toBe(theme.dependencyBackground);
  });
  it('keeps selected filename VCS color and raises annotation contrast', () => {
    const facts = node(); facts.git.state = 'ignored'; facts.scopes = [scope('non-project')];
    const selected = resolve(facts, theme, prefs, { selected: true, focused: true });
    expect(selected.foreground).toBe(theme.ignored);
    expect(selected.annotationForeground).toBe(theme.selectedAnnotation);
    const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    for (const color of [selected.foreground, selected.annotationForeground]) expect((luminance(color) + .05) / (luminance(theme.selection) + .05)).toBeGreaterThan(4.5);
  });
  it('does not promote one added descendant to added ancestors', () => {
    const facts = node(); facts.changes.descendants.added = facts.changes.descendants.total = 1;
    expect(resolve(facts, theme, prefs).foreground).toBe(theme.foreground);
    expect(resolve(facts, theme, { ...prefs, highlightChangedDirectories: true }).foreground).toBe(theme.modified);
    expect(resolve(facts, theme, prefs).tooltip).toContain('0 immediate, 1 deeper');
    facts.changes.immediate.total = 1;
    expect(resolve(facts, theme, prefs).tooltip).toContain('1 immediate, 0 deeper');
  });
  it('preserves source/symlink overlays and honest unknown/no-Git states', () => {
    const facts = node(); facts.identity = { kind: 'symlink', dotPrefixed: false, symlink: 'directory' };
    facts.role = { kind: 'sources', declared: true, rootPath: 'src', reason: { source: 'project-metadata', description: 'Configured source root' } };
    expect(resolve(facts, theme, prefs)).toMatchObject({ icon: 'sources', overlays: ['link'] });
    facts.git.state = 'not-applicable';
    expect(resolve(facts, theme, prefs).foreground).toBe(theme.foreground);
    expect(resolve(facts, theme, prefs).tooltip).toContain('Diagnostics not analyzed');
  });
});
