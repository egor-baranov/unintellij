import type { ComparisonSide, FileComparison, GitChange } from '../../desktop/src/bridge';
import type { BranchClient, BranchComparison, BranchOperation, BranchSnapshot, GitBranch } from '../../shared/branches/types';
import { commitFiles, previewWorkingChanges } from './commit-fixtures';

export type PreviewBranchScenario = 'normal' | 'detached' | 'unborn' | 'loading' | 'error' | 'stale';
export interface PreviewBranchOptions { scenario?: PreviewBranchScenario; delayMs?: number }
export interface PreviewBranchClient extends BranchClient { getChanges(): typeof commitFiles }

const oid = (value: number) => ((value * 2_654_435_761) >>> 0).toString(16).padStart(8, '0').repeat(5);
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const clone = <T,>(value: T): T => structuredClone(value);
const shortName = (ref: string) => ref.replace(/^refs\/(heads|remotes|tags)\//, '');
function textSide(label: string, text: string): ComparisonSide {
  return { label, text, metadata: { bytes: new TextEncoder().encode(text).byteLength, encoding: 'utf-8',
    lineEnding: text.includes('\r\n') ? 'CRLF' : text.includes('\n') ? 'LF' : 'none', finalNewline: text.endsWith('\n') } };
}
function validateName(name: string) {
  if (!name || name === '@' || name.startsWith('-') || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
    || name.includes('..') || name.includes('@{') || name.endsWith('.')
    || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Enter a valid branch name, such as feature/review-panel.');
  }
}

/** A fully in-memory repository for the explicitly labelled browser preview.
 * Operations alter only this client's sample refs; no Git/network calls occur.
 */
export function createPreviewBranchClient(repositoryId: string, options: PreviewBranchOptions = {}): PreviewBranchClient {
  const scenario = options.scenario ?? 'normal';
  let generation = 1;
  let operationNumber = 20;
  let listCount = 0;
  let stalePending = scenario === 'stale';
  const branches: GitBranch[] = [
    { ref: 'refs/heads/main', name: 'main', kind: 'local', oid: oid(10), current: true, upstream: 'origin/main', ahead: 1, behind: 1 },
    { ref: 'refs/heads/feature/compact-gutter', name: 'feature/compact-gutter', kind: 'local', oid: oid(11), current: false, upstream: 'origin/feature/compact-gutter', ahead: 2, behind: 0 },
    { ref: 'refs/heads/feature/keyboard-navigation', name: 'feature/keyboard-navigation', kind: 'local', oid: oid(12), current: false, ahead: 3, behind: 0 },
    { ref: 'refs/heads/fix/scroll-anchor', name: 'fix/scroll-anchor', kind: 'local', oid: oid(13), current: false, ahead: 1, behind: 0 },
    { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', oid: oid(9), current: false, ahead: 0, behind: 0 },
    { ref: 'refs/remotes/origin/feature/compact-gutter', name: 'origin/feature/compact-gutter', kind: 'remote', oid: oid(8), current: false, ahead: 0, behind: 0 },
    { ref: 'refs/remotes/origin/feature/search', name: 'origin/feature/search', kind: 'remote', oid: oid(14), current: false, ahead: 0, behind: 0 },
    { ref: 'refs/tags/v0.1.0', name: 'v0.1.0', kind: 'tag', oid: oid(7), current: false, ahead: 0, behind: 0 },
  ];
  let current: string | null = scenario === 'detached' ? null : 'main';
  let head: string | null = scenario === 'unborn' ? null : scenario === 'detached' ? oid(7) : oid(10);
  let stagedCount = 5;
  let committedIds = new Set<string>();
  let dirty = true;
  let operation: BranchSnapshot['operation'] = null;
  let recent = ['feature/compact-gutter', 'fix/scroll-anchor'];
  const comparisons = new Map<string, { metadata: BranchComparison; files: Map<string, FileComparison> }>();
  if (scenario === 'unborn') branches.splice(0);

  function ensureRepository(id: string) { if (id !== repositoryId) throw new Error('This preview repository is no longer selected.'); }
  function snapshot(): BranchSnapshot {
    return clone({ repositoryId, token: `preview-refs-${generation}`, current, head, unborn: head === null,
      branches: branches.map(branch => ({ ...branch, current: branch.kind === 'local' && branch.name === current })),
      remotes: ['origin'], recent, operation, dirty, stagedCount, selectedCommitSupported: true });
  }
  function find(ref: string): GitBranch {
    const branch = branches.find(branch => branch.ref === ref);
    if (!branch) throw new Error('This branch is no longer available. Refresh the branch list.');
    return branch;
  }
  function local(ref: string) {
    const branch = find(ref);
    if (branch.kind !== 'local') throw new Error('Select a local branch for this action.');
    return branch;
  }
  function requireCurrent() {
    if (!current) throw new Error('Create or check out a local branch before this action.');
    const branch = branches.find(branch => branch.kind === 'local' && branch.name === current);
    if (!branch) throw new Error('Create the first commit before this action.');
    return branch;
  }
  function checkout(ref: string) {
    let branch = find(ref);
    if (branch.kind === 'remote') {
      const name = branch.name.slice(branch.name.indexOf('/') + 1);
      const existing = branches.find(item => item.ref === `refs/heads/${name}`);
      if (existing) branch = existing;
      else { branch = { ...branch, kind: 'local', name, ref: `refs/heads/${name}`, upstream: branch.name, current: false }; branches.push(branch); }
    }
    const previous = current;
    current = branch.kind === 'tag' ? null : branch.name; head = branch.oid;
    recent = [...new Set([current, previous, ...recent].filter((name): name is string => Boolean(name)))].slice(0, 6);
    return current ?? `detached ${head.slice(0, 7)}`;
  }
  function advance(branch: GitBranch) { branch.oid = oid(++operationNumber); head = branch.oid; branch.ahead++; }
  function update(method: 'merge' | 'rebase' | 'ff-only', ref?: string) {
    if (ref) checkout(ref);
    const branch = requireCurrent();
    if (!branch.upstream) throw new Error('This preview branch has no upstream. Push it with an upstream first.');
    if (method === 'ff-only' && branch.ahead && branch.behind) throw new Error('The sample branches have diverged. Choose Merge or Rebase to update.');
    const upstream = branches.find(item => item.kind === 'remote' && item.name === branch.upstream);
    if (branch.behind) { branch.oid = branch.ahead ? oid(++operationNumber) : upstream?.oid ?? branch.oid; head = branch.oid; }
    branch.behind = 0;
  }
  function execute(action: BranchOperation): string {
    switch (action.kind) {
      case 'checkout': return `Preview: checked out ${checkout(action.ref)}${action.smart ? '; local sample changes preserved' : ''}.`;
      case 'checkout-revision': {
        const revision = action.revision.trim();
        const branch = branches.find(branch => [branch.name, branch.ref, branch.oid].includes(revision));
        if (branch) return `Preview: checked out ${checkout(branch.ref)}.`;
        if (!/^[a-f\d]{7,40}$/i.test(revision)) throw new Error('Use a sample branch, tag, or hexadecimal revision.');
        current = null; head = revision.padEnd(40, '0'); return 'Preview: checked out a detached revision.';
      }
      case 'create': {
        validateName(action.name);
        if (branches.some(branch => branch.ref === `refs/heads/${action.name}`)) throw new Error('A branch with that name already exists.');
        const start = action.startRef ? find(action.startRef).oid : head;
        if (!start) throw new Error('Create the first commit before creating another branch.');
        const ref = `refs/heads/${action.name}`;
        branches.push({ ref, name: action.name, kind: 'local', oid: start, current: false, ahead: 0, behind: 0 });
        if (action.checkout) checkout(ref);
        return `Preview: created ${action.name}${action.checkout ? ' and checked it out' : ''}.`;
      }
      case 'rename': {
        validateName(action.name); const branch = local(action.ref);
        if (branches.some(item => item !== branch && item.ref === `refs/heads/${action.name}`)) throw new Error('A branch with that name already exists.');
        const previous = branch.name; branch.name = action.name; branch.ref = `refs/heads/${action.name}`;
        if (current === previous) current = action.name;
        recent = recent.map(name => name === previous ? action.name : name);
        if (action.unsetUpstream) delete branch.upstream;
        return `Preview: renamed ${previous} to ${action.name}.`;
      }
      case 'delete': {
        const branch = find(action.ref);
        if (branch.kind === 'local' && branch.name === current) throw new Error('The current branch cannot be deleted. Check out another branch first.');
        if (branch.kind === 'local' && branch.ahead && !action.force) throw new Error('This branch contains unmerged sample commits. Force delete is required.');
        branches.splice(branches.indexOf(branch), 1); recent = recent.filter(name => name !== branch.name);
        return `Preview: deleted sample ${branch.kind === 'tag' ? 'tag' : `${branch.kind} branch`} ${branch.name}.`;
      }
      case 'fetch': return 'Preview: sample remote refs refreshed. No network request was made.';
      case 'update': update(action.method, action.ref); return `Preview: updated ${current} using ${action.method}.`;
      case 'checkout-update': checkout(action.ref); update(action.method); return `Preview: checked out and updated ${current}.`;
      case 'push': {
        const branch = action.ref ? find(action.ref) : requireCurrent();
        const remote = action.remote ?? 'origin';
        if (remote !== 'origin') throw new Error('This preview only contains the origin remote.');
        if (branch.kind === 'tag') return `Preview: pushed tag ${branch.name} to sample ${remote}. No network request was made.`;
        if (branch.kind !== 'local') throw new Error('Select a local branch or tag to push.');
        if (branch.behind) throw new Error('This sample branch is behind its upstream. Update before pushing.');
        if (!branch.upstream && !action.setUpstream) throw new Error('Choose Set upstream when pushing this branch for the first time.');
        branch.upstream ??= `${remote}/${branch.name}`;
        let target = branches.find(item => item.kind === 'remote' && item.name === branch.upstream);
        if (!target) { target = { ...branch, name: branch.upstream, ref: `refs/remotes/${branch.upstream}`, kind: 'remote', current: false }; delete target.upstream; branches.push(target); }
        target.oid = branch.oid; target.ahead = target.behind = 0; branch.ahead = branch.behind = 0;
        return `Preview: pushed ${branch.name} to sample ${branch.upstream}. No network request was made.`;
      }
      case 'merge': find(action.ref); advance(requireCurrent()); return `Preview: merged ${shortName(action.ref)} into ${current}.`;
      case 'rebase': {
        const destination = find(action.ref);
        if (action.checkout) { const base = requireCurrent(); checkout(destination.ref); advance(requireCurrent()); return `Preview: rebased ${current} onto ${base.name}.`; }
        advance(requireCurrent()); return `Preview: rebased ${current} onto ${destination.name}.`;
      }
      case 'abort': if (!operation) throw new Error('There is no merge or rebase to abort.'); operation = null; return 'Preview: operation aborted.';
      case 'continue': if (!operation) throw new Error('There is no merge or rebase to continue.'); operation = null; advance(requireCurrent()); return 'Preview: operation completed.';
      case 'commit': {
        if (!action.message.trim()) throw new Error('Enter a commit message.');
        const remaining = commitFiles.filter(file => !committedIds.has(file.id));
        const available = action.changeIds ? previewWorkingChanges(remaining) : remaining;
        const selected = action.changeIds ? available.filter(file => action.changeIds!.includes(file.id)) : available.filter(file => file.group === 'staged');
        if (action.changeIds && (new Set(action.changeIds).size !== action.changeIds.length || selected.length !== action.changeIds.length)) throw new Error('The selected sample changes are no longer available.');
        if (!selected.length && !action.amend) throw new Error('Select sample changes to commit.');
        if (action.options?.author && !/^.+\s+<[^<>\s]+@[^<>\s]+>$/.test(action.options.author.trim())) throw new Error('Enter the author as Name <email>.');
        if (action.options?.checkWhitespace && selected.some(file => file.modified.split('\n').some(line => /[\t ]+$/.test(line)))) throw new Error('Whitespace check failed. Remove trailing whitespace before committing.');
        if (action.options?.checkTodo && selected.some(file => file.modified.split('\n').some(line => /\bTODO\b/.test(line) && !file.original.split('\n').includes(line)))) throw new Error('TODO check failed. Resolve new TODOs before committing.');
        if (!head && action.amend) throw new Error('There is no commit to amend.');
        if (current && !branches.some(branch => branch.name === current && branch.kind === 'local')) {
          branches.push({ ref: `refs/heads/${current}`, name: current, kind: 'local', oid: oid(++operationNumber), current: true, ahead: 0, behind: 0 });
        }
        if (current) advance(requireCurrent()); else head = oid(++operationNumber);
        if (action.changeIds) {
          const selectedPaths = new Set(selected.map(file => file.path));
          remaining.filter(file => selectedPaths.has(file.path)).forEach(file => committedIds.add(file.id));
        } else selected.forEach(file => committedIds.add(file.id));
        stagedCount = commitFiles.filter(file => file.group === 'staged' && !committedIds.has(file.id)).length;
        dirty = committedIds.size < commitFiles.length;
        return `Preview: ${action.amend ? 'amended' : 'created'} a sample commit. Local source files are unchanged.`;
      }
    }
  }

  return {
    getChanges: () => previewWorkingChanges(commitFiles.filter(file => !committedIds.has(file.id))),
    async listBranches(id) {
      ensureRepository(id); const first = listCount++ === 0;
      await wait(options.delayMs ?? (scenario === 'loading' && first ? 1_200 : 80));
      if (scenario === 'error' && first) throw new Error('Sample branch listing failed. Retry to load the preview branches.');
      return snapshot();
    },
    async runBranchOperation(id, token, action) {
      ensureRepository(id); await wait(options.delayMs ?? 140);
      if (stalePending) { generation++; stalePending = false; }
      if (token !== snapshot().token) throw new Error('Branches changed since this menu was opened. Refresh the branch list and retry.');
      // Execute against a saved copy so a failing compound action is atomic.
      const before = { branches: clone(branches), current, head, stagedCount, committedIds: new Set(committedIds), dirty, recent: [...recent], operation, operationNumber };
      try { const message = execute(action); generation++; return { snapshot: snapshot(), message }; }
      catch (error) {
        branches.splice(0, branches.length, ...before.branches); ({ current, head, stagedCount, committedIds, dirty, recent, operation, operationNumber } = before);
        throw error;
      }
    },
    async compareBranches(id, ref, target, swap = false) {
      ensureRepository(id); await wait(options.delayMs ?? 100);
      const source = find(ref);
      const originalLabel = swap ? target === 'working' ? 'Working tree' : current ?? 'Detached HEAD' : source.name;
      const modifiedLabel = swap ? source.name : target === 'working' ? 'Working tree' : current ?? 'Detached HEAD';
      const same = target === 'head' && source.oid === head;
      const ids = source.name.includes('keyboard') ? ['playground-main', 'controls', 'new-test']
        : source.name.includes('scroll') ? ['mapping-staged', 'gutter', 'empty-modified']
        : source.kind === 'tag' ? ['readme-staged', 'theme-staged', 'removed-script'] : ['preferences', 'gutter', 'colors', 'mapping-staged'];
      const comparisonId = `preview-comparison-${generation}-${comparisons.size}-${Date.now()}`;
      const files = new Map<string, FileComparison>();
      const changes: GitChange[] = (same ? [] : ids).map(fixtureId => {
        const fixture = commitFiles.find(file => file.id === fixtureId)!;
        const added = fixture.status === 'A' || fixture.group === 'untracked', deleted = fixture.status === 'D';
        const status = added ? swap ? 'D' : 'A' : deleted ? swap ? 'A' : 'D' : fixture.status;
        const changeId = `${comparisonId}:${fixtureId}`;
        const path = swap && fixture.oldPath ? fixture.oldPath : fixture.path;
        files.set(changeId, { repositoryId, changeId, generation, path, state: 'text', changeType: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
          original: textSide(originalLabel, swap ? fixture.modified : fixture.original), modified: textSide(modifiedLabel, swap ? fixture.original : fixture.modified) });
        return { id: changeId, path, ...(fixture.oldPath ? { oldPath: swap ? fixture.path : fixture.oldPath } : {}), group: 'unstaged', status };
      });
      const metadata: BranchComparison = { id: comparisonId, repositoryId, sourceRef: ref, target, swapped: swap, originalLabel, modifiedLabel, changes, truncated: false,
        commits: same ? [] : [
          { oid: source.oid, subject: 'Refine compact connectors and code highlighting', author: 'Preview Author', date: '2026-10-04T10:30:00Z', side: swap ? 'modified' : 'original' },
          { oid: head ?? oid(15), subject: 'Add keyboard navigation and coordinated file review', author: 'Preview Author', date: '2026-10-05T09:15:00Z', side: swap ? 'original' : 'modified' },
        ] };
      comparisons.set(comparisonId, { metadata, files });
      if (comparisons.size > 24) comparisons.delete(comparisons.keys().next().value!);
      return clone(metadata);
    },
    async readBranchComparison(id, comparisonId, changeId) {
      ensureRepository(id); await wait(options.delayMs ?? 70);
      const value = comparisons.get(comparisonId)?.files.get(changeId);
      if (!value) throw new Error('This preview comparison expired. Compare the branches again.');
      return clone(value);
    },
  };
}
