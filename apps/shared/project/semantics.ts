/** Serializable application metadata. Paths are normalized project-relative display paths, never capabilities. */
export type ProjectRole = 'ordinary' | 'content' | 'sources' | 'test-sources' | 'resources' | 'test-resources' | 'library';
export type FactSource = 'user' | 'project-metadata' | 'detection' | 'git' | 'default';
export interface FactReason { source: FactSource; description: string; path?: string; line?: number }
export type TreeGitState = 'clean' | 'modified' | 'added' | 'renamed' | 'copied' | 'deleted' | 'untracked' | 'ignored' | 'conflicted' | 'unavailable' | 'not-applicable';
export interface ChangeSummary { total: number; modified: number; added: number; renamed: number; deleted: number; untracked: number; conflicted: number }
export interface TreeDiagnostics { errors: number; warnings: number; descendantErrors: number; descendantWarnings: number; coverage: 'unknown' | 'open-files' | 'complete' }
export interface TreeScope { id: string; kind: 'non-project' | 'test' | 'custom'; rootPath: string; priority?: number; color?: string; reason: FactReason }
export interface TreeNodeFacts {
  repositoryId: string;
  path: string;
  generation: number;
  identity: { kind: 'file' | 'directory' | 'symlink' | 'submodule' | 'unavailable'; dotPrefixed: boolean; symlink?: 'file' | 'directory' | 'broken' | 'unknown'; nestedRepository?: boolean; repositoryRoot?: string };
  role: { kind: ProjectRole; declared: boolean; rootPath?: string; reason: FactReason };
  library?: { rootPath: string; reason: FactReason };
  generated: { value: boolean; reason?: FactReason };
  inclusion: { state: 'included' | 'excluded' | 'inherited-exclusion' | 'outside'; rootPath?: string; reason: FactReason };
  git: { state: TreeGitState; index: TreeGitState; workingTree: TreeGitState; tracked: boolean | 'unknown'; ignored: boolean | 'unknown'; ignoreRule?: { source: string; line: number; pattern: string }; reason?: FactReason };
  changes: { immediate: ChangeSummary; descendants: ChangeSummary };
  diagnostics: TreeDiagnostics;
  scopes: TreeScope[];
}
export type DirectoryMarking = 'sources' | 'test-sources' | 'resources' | 'test-resources' | 'generated-sources' | 'generated-test-sources' | 'excluded' | 'included' | 'ordinary';
export interface ProjectTreePreferences {
  showExcluded: boolean; showIgnored: boolean; showHidden: boolean;
  highlightChangedDirectories: boolean; scopeBackgrounds: boolean;
  showRepositoryPath: boolean; showStatusColors: boolean;
}
export const defaultTreePreferences: ProjectTreePreferences = {
  showExcluded: true, showIgnored: true, showHidden: true,
  highlightChangedDirectories: false, scopeBackgrounds: true,
  showRepositoryPath: true, showStatusColors: true,
};
export interface ProjectDecorationClient {
  getProjectTreePreferences(repositoryId: string): Promise<ProjectTreePreferences>;
  setProjectTreePreferences(repositoryId: string, patch: Partial<ProjectTreePreferences>): Promise<ProjectTreePreferences>;
  markProjectDirectory(repositoryId: string, directoryId: string | null, marking: DirectoryMarking | null): Promise<void>;
}
export const emptyChangeSummary = (): ChangeSummary => ({ total: 0, modified: 0, added: 0, renamed: 0, deleted: 0, untracked: 0, conflicted: 0 });
export function defaultNodeFacts(repositoryId: string, path: string, kind: TreeNodeFacts['identity']['kind'], generation = 0): TreeNodeFacts {
  return {
    repositoryId, path, generation, identity: { kind, dotPrefixed: (path.split('/').at(-1) ?? '').startsWith('.') },
    role: { kind: path ? 'ordinary' : 'content', declared: !path, rootPath: '', reason: { source: 'default', description: path ? 'Ordinary project content' : 'Project content root' } },
    generated: { value: false }, inclusion: { state: 'included', rootPath: '', reason: { source: 'default', description: 'Included in the project' } },
    git: { state: 'unavailable', index: 'unavailable', workingTree: 'unavailable', tracked: 'unknown', ignored: 'unknown' },
    changes: { immediate: emptyChangeSummary(), descendants: emptyChangeSummary() },
    diagnostics: { errors: 0, warnings: 0, descendantErrors: 0, descendantWarnings: 0, coverage: 'unknown' }, scopes: [],
  };
}
/** Slash-boundary comparisons, never ambiguous raw string-prefix membership. */
export const withinProjectPath = (path: string, root: string) => root === '' || path === root || path.startsWith(`${root}/`);
