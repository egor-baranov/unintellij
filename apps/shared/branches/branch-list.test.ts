import { describe, expect, it } from 'vitest';
import type { GitBranch } from './types';
import { buildBranchEntries, branchRowPositions, visibleBranchRange } from './branch-list';
const preferences = { favorites: [], groupPrefixes: true, showTags: true, showRecent: true };
const branch = (name: string, current = false): GitBranch => ({ ref: `refs/remotes/${name}`, name, kind: 'remote', current, ahead: 0, behind: 0, oid: 'a'.repeat(40) });

describe('large branch popup list', () => {
  it('keeps all 22,000 remote refs searchable without dropping distant names', () => {
    const branches = Array.from({ length: 22000 }, (_, i) => branch(`origin/team${i % 100}/branch-${i}`));
    const all = buildBranchEntries({ branches, recent: [] }, preferences, new Set(), '');
    expect(all.filter(entry => entry.kind === 'branch')).toHaveLength(22000);
    const filtered = buildBranchEntries({ branches, recent: [] }, preferences, new Set(['Remote']), 'branch-21999');
    expect(filtered.filter(entry => entry.kind === 'branch').map(entry => entry.label)).toEqual(['origin/team99/branch-21999']);
  });
  it('retains favorite/current/natural ordering and exact prefix boundaries', () => {
    const branches = [branch('origin/abc/one'), branch('origin/a/item10'), branch('origin/a/item2'), branch('origin/z/favorite'), branch('origin/current', true)];
    const entries = buildBranchEntries({ branches, recent: [] }, { ...preferences, favorites: [branches[3].ref] }, new Set(['Remote:origin/a/']), '');
    expect(entries.map(entry => entry.label)).toEqual(['Remote', 'origin', 'z', 'favorite', 'current', 'a', 'abc', 'one']);
    const expanded = buildBranchEntries({ branches, recent: [] }, preferences, new Set(), '');
    expect(expanded.filter(entry => entry.kind === 'branch').map(entry => entry.label)).toEqual(['current', 'item2', 'item10', 'one', 'favorite']);
  });
  it('retains recent duplicates as independent row identities and tag visibility', () => {
    const local = { ...branch('main', true), ref: 'refs/heads/main', kind: 'local' as const };
    const tag = { ...branch('v1'), ref: 'refs/tags/v1', kind: 'tag' as const };
    const entries = buildBranchEntries({ branches: [local, tag], recent: [local.ref] }, preferences, new Set(['Tags']), '');
    expect(entries.filter(entry => entry.kind === 'branch').map(entry => entry.id)).toEqual(['Recent:refs/heads/main', 'Local:refs/heads/main']);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(buildBranchEntries({ branches: [tag], recent: [] }, { ...preferences, showTags: false }, new Set(), '')).toEqual([]);
  });
  it('includes section and prefix gaps in the same measured row geometry', () => {
    const positions = branchRowPositions([{ kind: 'action' }, { kind: 'action', separator: true }, { kind: 'group', depth: 0 }, { kind: 'group', depth: 1 }, { kind: 'branch' }], 29, 15, 1);
    expect(positions).toEqual([{ top: 0, height: 29, gap: 0 }, { top: 29, height: 44, gap: 15 }, { top: 73, height: 44, gap: 15 }, { top: 117, height: 30, gap: 1 }, { top: 147, height: 29, gap: 0 }]);
  });
  it('bounds visible rows near either end and across scaled separator gaps', () => {
    const positions = branchRowPositions(Array.from({ length: 30000 }, () => ({ kind: 'branch' })), 44, 22.5, 1.5);
    expect(visibleBranchRange(positions, 0, 600)).toEqual({ start: 0, end: 19 });
    const nearEnd = visibleBranchRange(positions, 29980 * 44, 600);
    expect(nearEnd.end - nearEnd.start).toBeLessThan(30);
    expect(visibleBranchRange(positions, 30000 * 44 - 600, 600).end).toBe(30000);
    expect(visibleBranchRange([], 0, 600)).toEqual({ start: 0, end: 0 });
  });
});
