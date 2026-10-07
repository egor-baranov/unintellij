import path from 'node:path';
import { emptyChangeSummary, type ChangeSummary, type TreeGitState, type TreeNodeFacts } from '../../shared/project/semantics';
import type { StatusRecord } from './git';
import type { TrackedPaths } from './compact-path-set';

type GitFacts = TreeNodeFacts['git'];
export interface IgnoreFact { ignored?: boolean; unavailable?: true; rule?: { source: string; line: number; pattern: string } }
export interface ProjectGitSnapshot {
  tracked: TrackedPaths;
  trackedDirectories: Set<string>;
  states: Map<string, GitFacts>;
  summaries: Map<string, { immediate: ChangeSummary; descendants: ChangeSummary }>;
}

const fromCode = (code: string): TreeGitState => ({ M: 'modified', T: 'modified', A: 'added', R: 'renamed', C: 'copied', D: 'deleted', U: 'conflicted', '?': 'untracked', '!': 'ignored' } as Record<string, TreeGitState>)[code] ?? 'clean';
const priorities: TreeGitState[] = ['conflicted', 'untracked', 'added', 'renamed', 'copied', 'deleted', 'modified', 'clean'];
const combine = (left: TreeGitState, right: TreeGitState) => priorities.find(state => state === left || state === right) ?? 'clean';
const parent = (value: string) => { const directory = path.posix.dirname(value); return directory === '.' ? '' : directory; };

function increment(summary: ChangeSummary, state: TreeGitState) {
  if (state === 'clean' || state === 'ignored' || state === 'unavailable' || state === 'not-applicable') return;
  summary.total++;
  if (state === 'copied') summary.added++;
  else summary[state]++;
}

/** Snapshot aggregates never require expanding or reading descendant directories. */
export function projectGitSnapshot(records: StatusRecord[], tracked: TrackedPaths): ProjectGitSnapshot {
  const trackedDirectories = new Set<string>();
  // A staged deletion is still a versioned change even though absent in index.
  for (const record of records) if (record.kind !== 'untracked') tracked.add(record.path);
  for (const filePath of tracked) {
    let current = parent(filePath);
    while (!trackedDirectories.has(current)) { trackedDirectories.add(current); if (!current) break; current = parent(current); }
  }
  const states = new Map<string, GitFacts>();
  const renameSources = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.kind === 'rename' && record.xy.includes('R') && record.oldPath) {
      const sources = renameSources.get(record.path) ?? new Set<string>();
      sources.add(record.oldPath);
      renameSources.set(record.path, sources);
    }
    const untracked = record.kind === 'untracked';
    const indexState = untracked ? 'not-applicable' : fromCode(record.xy[0]);
    const workingTree = untracked ? 'untracked' : fromCode(record.xy[1]);
    const previous = states.get(record.path);
    const effectiveIndex = previous?.tracked ? previous.index : indexState;
    const state = record.kind === 'conflict' ? 'conflicted' : combine(effectiveIndex, workingTree);
    states.set(record.path, { state, index: effectiveIndex, workingTree, tracked: tracked.has(record.path), ignored: false });
  }
  const summaries: ProjectGitSnapshot['summaries'] = new Map();
  const summary = (directory: string) => {
    let value = summaries.get(directory);
    if (!value) { value = { immediate: emptyChangeSummary(), descendants: emptyChangeSummary() }; summaries.set(directory, value); }
    return value;
  };
  for (const [filePath, facts] of states) {
    // A rename affects both locations, but remains one changed file at their
    // common ancestors. Copies leave the source untouched and use only the new path.
    const immediate = new Set<string>();
    const descendants = new Set<string>();
    for (const location of [filePath, ...renameSources.get(filePath) ?? []]) {
      let current = parent(location);
      immediate.add(current);
      while (true) { descendants.add(current); if (!current) break; current = parent(current); }
    }
    for (const directory of immediate) increment(summary(directory).immediate, facts.state);
    for (const directory of descendants) increment(summary(directory).descendants, facts.state);
  }
  return { tracked, trackedDirectories, states, summaries };
}

/** check-ignore -v -z emits four NUL-delimited fields, including negated rules. */
export function parseIgnoreFacts(output: Buffer): Map<string, IgnoreFact> {
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(output).split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4) throw new Error('Malformed Git ignore result.');
  const result = new Map<string, IgnoreFact>();
  for (let i = 0; i < fields.length; i += 4) {
    const [source, line, pattern, filePath] = fields.slice(i, i + 4);
    const hasRule = !!source && !!pattern && /^[1-9]\d*$/.test(line);
    result.set(filePath.replace(/\/$/, ''), { ignored: hasRule && !pattern.startsWith('!'), ...(hasRule ? { rule: { source, line: Number(line), pattern } } : {}) });
  }
  return result;
}

export function nodeGitFacts(snapshot: ProjectGitSnapshot | undefined, filePath: string, directory: boolean, ignore: IgnoreFact | undefined, gitAvailable: boolean): GitFacts {
  if (!gitAvailable) return { state: 'not-applicable', index: 'not-applicable', workingTree: 'not-applicable', tracked: false, ignored: false, reason: { source: 'default', description: 'This project has no Git repository' } };
  if (!snapshot) return { state: 'unavailable', index: 'unavailable', workingTree: 'unavailable', tracked: 'unknown', ignored: 'unknown' };
  const stored = snapshot.states.get(filePath);
  if (stored) return { ...stored, ...(!stored.tracked && ignore?.rule ? { ignoreRule: ignore.rule, reason: { source: 'git' as const, description: `Included by ${ignore.rule.source}:${ignore.rule.line}`, path: ignore.rule.source, line: ignore.rule.line } } : {}) };
  const tracked = directory ? !filePath || snapshot.trackedDirectories.has(filePath) : snapshot.tracked.has(filePath);
  if (tracked) return { state: 'clean', index: 'clean', workingTree: 'clean', tracked: true, ignored: false };
  if (!ignore || ignore.unavailable) return { state: 'unavailable', index: 'not-applicable', workingTree: 'unavailable', tracked: false, ignored: 'unknown', reason: { source: 'git', description: 'Git ignore status is unavailable' } };
  const ignored = ignore.ignored ?? false;
  const state = ignored ? 'ignored' : 'untracked';
  return {
    state, index: 'not-applicable', workingTree: state, tracked: false, ignored,
    ...(ignore?.rule ? { ignoreRule: ignore.rule, reason: { source: 'git' as const, description: `${ignored ? 'Ignored' : 'Included'} by ${ignore.rule.source}:${ignore.rule.line}`, path: ignore.rule.source, line: ignore.rule.line } } : {}),
  };
}
