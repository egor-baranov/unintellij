import type { ProjectDirectory, ProjectEntry } from '../../desktop/src/bridge';
import { defaultNodeFacts, type TreeGitState, type TreeNodeFacts } from './semantics';

export interface DirectoryState {
  state: 'loading' | 'ready' | 'error';
  directory?: ProjectDirectory;
  error?: string;
}
export interface ProjectRow {
  path: string;
  entry?: ProjectEntry;
  parentPath?: string;
  depth: number;
  position: number;
  siblings: number;
}

/** All UI state uses display paths, while directory reads always use opaque backend IDs. */
export function projectRows(directories: ReadonlyMap<string, DirectoryState>, expanded: ReadonlySet<string>, includeEntry: (entry: ProjectEntry) => boolean = () => true): ProjectRow[] {
  const rows: ProjectRow[] = [{ path: '', depth: 0, position: 1, siblings: 1 }];
  const append = (path: string, depth: number) => {
    if (!expanded.has(path)) return;
    const entries = (directories.get(path)?.directory?.entries ?? []).filter(includeEntry);
    entries.forEach((entry, index) => {
      rows.push({ path: entry.path, entry, parentPath: path, depth, position: index + 1, siblings: entries.length });
      if (entry.kind === 'directory') append(entry.path, depth + 1);
    });
  };
  append('', 1);
  return rows;
}

export function projectAncestors(path: string): string[] {
  const result = [''];
  let separator = path.indexOf('/');
  while (separator !== -1) {
    result.push(path.slice(0, separator));
    separator = path.indexOf('/', separator + 1);
  }
  return result;
}

export function displayProjectName(name: string): string {
  return name.replaceAll('\n', '↵').replaceAll('\r', '␍').replaceAll('\t', '⇥');
}

/** Older hosts and browser fixtures can omit facts. Keep their compatibility
 * conversion here instead of mixing VCS inference into rendering. */
export function projectEntryFacts(repositoryId: string, entry: ProjectEntry): TreeNodeFacts {
  if (entry.facts?.repositoryId === repositoryId && entry.facts.path === entry.path) return entry.facts;
  const facts = defaultNodeFacts(repositoryId, entry.path, entry.kind);
  if (entry.kind === 'directory') {
    facts.git = { state: 'not-applicable', index: 'not-applicable', workingTree: 'not-applicable', tracked: 'unknown', ignored: 'unknown' };
    return facts;
  }
  if (!entry.status) return facts;
  const statuses: Record<string, TreeGitState> = { M: 'modified', A: 'added', R: 'renamed', C: 'copied', D: 'deleted', U: 'conflicted', '?': 'untracked', '!': 'ignored', '.': 'clean', ' ': 'clean' };
  const index = statuses[entry.status[0]] ?? 'unavailable';
  const workingTree = statuses[entry.status[1] ?? ' '] ?? 'unavailable';
  const state = index === 'conflicted' || workingTree === 'conflicted' ? 'conflicted' : workingTree !== 'clean' ? workingTree : index;
  facts.git = { state, index, workingTree, tracked: !['untracked', 'ignored', 'unavailable'].includes(state), ignored: state === 'ignored' };
  return facts;
}

/** A directory listing is one repository snapshot, including every decoration.
 * Hosts without decoration support omit generations and remain compatible. */
export function isCurrentProjectDirectory(directory: ProjectDirectory, repositoryId: string, path: string, minimumGeneration: number): boolean {
  if (directory.repositoryId !== repositoryId || directory.path !== path) return false;
  if (directory.generation !== undefined && (!Number.isSafeInteger(directory.generation) || directory.generation < minimumGeneration)) return false;
  const validFacts = (facts: TreeNodeFacts | undefined, expectedPath: string) => !facts || facts.repositoryId === repositoryId && facts.path === expectedPath
    && (directory.generation === undefined || facts.generation === directory.generation);
  return validFacts(directory.facts, path) && directory.entries.every(entry => validFacts(entry.facts, entry.path));
}
