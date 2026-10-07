import type { BranchSnapshot, GitBranch } from './types';

export interface BranchListPreferences { favorites: readonly string[]; groupPrefixes: boolean; showTags: boolean; showRecent: boolean }
export type BranchListEntry = { id: string; label: string; depth: number } & (
  | { kind: 'branch'; branch: GitBranch }
  | { kind: 'group'; expanded: boolean }
);
const collator = new Intl.Collator(undefined, { numeric: true });

/** Sort once per section, then partition each prefix in one pass. Every ref stays searchable. */
export function buildBranchEntries(snapshot: Pick<BranchSnapshot, 'branches' | 'recent'> | undefined, preferences: BranchListPreferences, collapsed: ReadonlySet<string>, query: string): BranchListEntry[] {
  const all = snapshot?.branches ?? [];
  const favorites = new Set(preferences.favorites);
  const byRef = new Map(all.map(branch => [branch.ref, branch]));
  const byName = new Map(all.map(branch => [branch.name, branch]));
  const recent = (snapshot?.recent ?? []).map(ref => byRef.get(ref) ?? byName.get(ref)).filter((branch): branch is GitBranch => Boolean(branch));
  const groups = [
    ...(preferences.showRecent && recent.length ? [{ label: 'Recent', branches: recent }] : []),
    { label: 'Local', branches: all.filter(branch => branch.kind === 'local') },
    { label: 'Remote', branches: all.filter(branch => branch.kind === 'remote') },
    ...(preferences.showTags ? [{ label: 'Tags', branches: all.filter(branch => branch.kind === 'tag') }] : []),
  ];
  const entries: BranchListEntry[] = [];
  function append(branches: GitBranch[], group: string, depth: number, prefix = '') {
    const children = new Map<string, { label: string; prefix: string; branches: GitBranch[] } | GitBranch>();
    for (const branch of branches) {
      const suffix = branch.name.slice(prefix.length), slash = suffix.indexOf('/');
      if (preferences.groupPrefixes && !query && slash > 0) {
        const label = suffix.slice(0, slash), nextPrefix = `${prefix}${label}/`, key = `group:${nextPrefix}`;
        const existing = children.get(key);
        if (existing && 'branches' in existing) existing.branches.push(branch);
        else children.set(key, { label, prefix: nextPrefix, branches: [branch] });
      } else children.set(`branch:${branch.ref}`, branch);
    }
    for (const child of children.values()) {
      if ('branches' in child) {
        const id = `${group}:${child.prefix}`, expanded = !collapsed.has(id);
        entries.push({ kind: 'group', id, label: child.label, depth, expanded });
        if (expanded) append(child.branches, group, depth + 1, child.prefix);
      } else entries.push({ kind: 'branch', id: `${group}:${child.ref}`, label: child.name.slice(prefix.length), depth, branch: child });
    }
  }
  for (const group of groups) {
    const branches = group.branches.filter(branch => !query || branch.name.toLocaleLowerCase().includes(query));
    if (!branches.length) continue;
    const expanded = Boolean(query) || !collapsed.has(group.label);
    entries.push({ kind: 'group', id: group.label, label: group.label, depth: 0, expanded });
    if (!expanded) continue;
    branches.sort((a, b) => Number(favorites.has(b.ref)) - Number(favorites.has(a.ref)) || Number(b.current) - Number(a.current) || collator.compare(a.name, b.name));
    append(branches, group.label, 1);
  }
  return entries;
}

export interface BranchRowPosition { top: number; height: number; gap: number }
export function branchRowPositions(entries: readonly { kind: string; depth?: number; separator?: boolean }[], rowHeight: number, sectionGap: number, groupGap: number): BranchRowPosition[] {
  let top = 0;
  return entries.map(entry => {
    const gap = entry.separator || (entry.kind === 'group' && !entry.depth) ? sectionGap : entry.kind === 'group' ? groupGap : 0;
    const position = { top, height: rowHeight + gap, gap };
    top += position.height;
    return position;
  });
}

/** Binary-search the measured geometry; no scan of all rows on scrolling/hover. */
export function visibleBranchRange(positions: readonly BranchRowPosition[], scrollTop: number, height: number, overscan = 5): { start: number; end: number } {
  function firstAfter(y: number) {
    let lo = 0, hi = positions.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (positions[mid].top + positions[mid].height <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }
  return { start: Math.max(0, firstAfter(scrollTop) - overscan), end: Math.min(positions.length, firstAfter(scrollTop + height) + overscan + 1) };
}
