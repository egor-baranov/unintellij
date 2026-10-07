import type { ProjectTreePreferences, TreeGitState, TreeNodeFacts } from './semantics';
import type { TreeTheme } from './theme';

export type TreeIcon = 'file' | 'folder' | 'content' | 'sources' | 'test-sources' | 'resources' | 'test-resources' | 'excluded' | 'library' | 'repository' | 'unavailable';
export interface TreeInteraction { selected?: boolean; focused?: boolean; hovered?: boolean; expanded?: boolean; loading?: boolean; dropTarget?: boolean }
export interface TreePresentation {
  icon: TreeIcon;
  overlays: Array<'generated' | 'link' | 'broken-link' | 'repository'>;
  foreground: string;
  scopeBackground?: string;
  background?: string;
  annotation?: string;
  annotationForeground: string;
  diagnosticUnderline?: { severity: 'error' | 'warning'; color: string };
  tooltip: string;
  accessibilityDescription: string;
  reasons: string[];
}

const stateLabel: Record<TreeGitState, string> = {
  clean: 'Clean', modified: 'Modified', added: 'Added', renamed: 'Renamed', copied: 'Copied', deleted: 'Deleted', untracked: 'Untracked', ignored: 'Ignored',
  conflicted: 'Conflicted', unavailable: 'Git state unavailable', 'not-applicable': 'No Git state',
};
const roleLabel = { ordinary: 'Ordinary directory', content: 'Content root', sources: 'Sources root', 'test-sources': 'Test sources root', resources: 'Resources root', 'test-resources': 'Test resources root', library: 'Library root' };
const isExcluded = (facts: TreeNodeFacts) => facts.inclusion.state !== 'included';

export function isTreeNodeVisible(facts: TreeNodeFacts, preferences: ProjectTreePreferences): boolean {
  if (!facts.path) return true;
  return (preferences.showExcluded || !isExcluded(facts)) && (preferences.showIgnored || facts.git.ignored !== true)
    && (preferences.showHidden || !facts.identity.dotPrefixed);
}

/** Independent layers. Custom scope (priority, then id) > non-project > test.
 * Selection > drop target > hover > scope. Git foreground and diagnostics never
 * derive from role, inclusion, dot-prefix, or an interaction background. */
export function resolveTreePresentation(facts: TreeNodeFacts, theme: TreeTheme, preferences: ProjectTreePreferences, interaction: TreeInteraction = {}): TreePresentation {
  const folder = facts.identity.kind === 'directory' || facts.identity.kind === 'submodule' || facts.identity.symlink === 'directory';
  const root = facts.role.declared;
  const reasons: string[] = [facts.path || 'Project root'];
  let icon: TreeIcon = folder ? 'folder' : 'file';
  if (facts.identity.kind === 'unavailable') icon = 'unavailable';
  else if (folder) {
    if (facts.identity.kind === 'submodule' || facts.identity.nestedRepository) icon = 'repository';
    else if (root && facts.role.kind === 'library') icon = 'library';
    else if (isExcluded(facts)) icon = 'excluded';
    else if (root && facts.role.kind !== 'ordinary') icon = facts.role.kind;
  }
  const overlays: TreePresentation['overlays'] = [];
  if (facts.generated.value) overlays.push('generated');
  if (facts.identity.kind === 'symlink') overlays.push(facts.identity.symlink === 'broken' ? 'broken-link' : 'link');
  if (facts.identity.nestedRepository && icon !== 'repository') overlays.push('repository');
  if (facts.role.kind !== 'ordinary') reasons.push(`${root ? roleLabel[facts.role.kind] : `Inside ${roleLabel[facts.role.kind].toLowerCase()}`}${facts.role.rootPath ? `: ${facts.role.rootPath}` : ''}`);
  if (facts.role.reason.source !== 'default') reasons.push(facts.role.reason.description);
  if (facts.library) reasons.push(facts.library.reason.description);
  if (facts.generated.value) reasons.push(facts.generated.reason?.description ?? 'Generated content');
  if (facts.inclusion.reason.source !== 'default' || isExcluded(facts)) reasons.push(facts.inclusion.reason.description);
  if (facts.identity.kind === 'symlink') reasons.push(`${facts.identity.symlink === 'broken' ? 'Broken symbolic link' : 'Symbolic link'}; not traversed`);
  if (facts.identity.kind === 'submodule') reasons.push('Git submodule; separate repository boundary');
  else if (facts.identity.nestedRepository) reasons.push('Nested repository; separate Git status namespace');

  let state = facts.git.state;
  if (facts.git.index === 'conflicted' || facts.git.workingTree === 'conflicted') state = 'conflicted';
  // Directories have no Git index record. An opt-in aggregate uses modified,
  // never an added/untracked name color for ordinary directories. Ignored
  // directories keep their independent warm treatment.
  if (folder && !['ignored', 'unavailable', 'not-applicable', 'conflicted'].includes(state)) {
    state = preferences.highlightChangedDirectories && facts.changes.descendants.total > 0
      ? facts.changes.descendants.conflicted ? 'conflicted' : 'modified' : 'clean';
  }
  const foreground = !preferences.showStatusColors || state === 'clean' || state === 'not-applicable'
    ? theme.foreground : theme[state];
  reasons.push(`${stateLabel[facts.git.state]}${facts.git.tracked === true ? '; tracked' : ''}`);
  if (facts.git.tracked === true || !['not-applicable', 'unavailable'].includes(facts.git.index)) {
    reasons.push(`Index: ${stateLabel[facts.git.index].toLowerCase()}; working tree: ${stateLabel[facts.git.workingTree].toLowerCase()}`);
  }
  if (facts.git.ignoreRule && facts.git.ignored === true) reasons.push(`Ignored by ${facts.git.ignoreRule.source}:${facts.git.ignoreRule.line} (${facts.git.ignoreRule.pattern})`);
  if (facts.git.reason) reasons.push(facts.git.reason.description);
  const summary = facts.changes;
  if (summary.descendants.total) reasons.push(`Contains ${summary.descendants.total} changed file${summary.descendants.total === 1 ? '' : 's'} (${summary.immediate.total} immediate, ${Math.max(0, summary.descendants.total - summary.immediate.total)} deeper)`);

  const scopes = [...facts.scopes].sort((a, b) => {
    const rank = { custom: 3, 'non-project': 2, test: 1 };
    return rank[b.kind] - rank[a.kind] || (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id, 'en');
  });
  const scope = scopes[0];
  const customColor = scope?.kind === 'custom' && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(scope.color ?? '') ? scope.color : undefined;
  const scopeBackground = !preferences.scopeBackgrounds || !scope ? undefined
    : scope.kind === 'custom' ? customColor : scope.kind === 'non-project' ? theme.dependencyBackground : theme.testBackground;
  if (scope) reasons.push(scope.reason.description);
  const background = interaction.selected ? interaction.focused ? theme.selection : theme.unfocusedSelection
    : interaction.dropTarget ? theme.selection : interaction.hovered ? theme.hover : scopeBackground;
  const errors = facts.diagnostics.errors + facts.diagnostics.descendantErrors;
  const warnings = facts.diagnostics.warnings + facts.diagnostics.descendantWarnings;
  const diagnosticUnderline = errors ? { severity: 'error' as const, color: theme.diagnosticError }
    : warnings ? { severity: 'warning' as const, color: theme.diagnosticWarning } : undefined;
  if (errors) reasons.push(`${facts.diagnostics.descendantErrors ? 'Contains reported errors' : 'Reported errors'}: ${errors}`);
  if (warnings) reasons.push(`Reported warnings: ${warnings}`);
  reasons.push(facts.diagnostics.coverage === 'unknown' ? 'Diagnostics not analyzed' : facts.diagnostics.coverage === 'open-files' ? 'Diagnostics cover analyzed open files only' : 'Diagnostics cover this entry');
  if (interaction.loading) reasons.push('Loading directory');
  const uniqueReasons = [...new Set(reasons)];
  return { icon, overlays, foreground, scopeBackground, background,
    annotation: facts.library?.rootPath === facts.path ? 'library root' : undefined,
    annotationForeground: interaction.selected ? theme.selectedAnnotation : theme.annotation,
    diagnosticUnderline, tooltip: uniqueReasons.join('\n'), accessibilityDescription: uniqueReasons.slice(1).join('. '), reasons: uniqueReasons };
}
