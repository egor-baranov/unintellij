import { describe, expect, it } from 'vitest';
import { ancestorIds, buildChangeTree, checkState, flattenTree, isReviewed, reviewKey, reviewSummary, toggleSelection, type ChangeFile } from './tree';

const files: ChangeFile[] = [
  { id: 'work', path: 'apps/playground/src/main.tsx', status: 'M', group: 'working' },
  { id: 'add', path: 'apps/playground/src/new.ts', status: 'A', group: 'working' },
  { id: 'other', path: 'docs/hello\n世界\t.md', status: '?', group: 'untracked' },
];

describe('commit review tree', () => {
  it('places tracked paths directly under Changes with unique file counts', () => {
    const roots = buildChangeTree(files);
    expect(roots.map(node => [node.label, node.fileIds.length])).toEqual([['Changes', 2], ['Unversioned Files', 1]]);
    expect(roots[0].children.map(node => node.label)).toEqual(['apps']);
    const leaves = flattenTree(roots).filter(row => row.node.file).map(row => row.node.file?.id);
    expect(new Set(leaves)).toEqual(new Set(['work', 'add', 'other']));
    expect(flattenTree(roots).find(row => row.node.file?.id === 'other')?.node.label).toBe('hello\n世界\t.md');
  });

  it('merges tracked directories into one folder hierarchy', () => {
    const rows = flattenTree(buildChangeTree(files));
    const ids = rows.map(row => row.node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter(row => row.node.label === 'src').map(row => row.node.fileIds.length)).toEqual([2]);
  });

  it('coordinates group checkboxes using three states without affecting other groups', () => {
    const tree = buildChangeTree(files);
    let selection = toggleSelection(['work'], new Set());
    expect(checkState(tree[0].fileIds, selection)).toBe('mixed');
    expect(checkState(['add'], selection)).toBe('false');
    selection = toggleSelection(tree[0].fileIds, selection);
    expect([...selection]).toEqual(['work', 'add']);
    expect(checkState(tree[0].fileIds, selection)).toBe('true');
    selection = toggleSelection(tree[0].fileIds, selection);
    expect(selection.size).toBe(0);
  });

  it('expands only selected ancestors and reports positions for keyboard navigation', () => {
    const roots = buildChangeTree(files);
    const ancestors = ancestorIds(roots, 'file:work');
    expect(ancestors).toEqual(['group:changes', 'group:changes:directory:/apps', 'group:changes:directory:/apps/playground', 'group:changes:directory:/apps/playground/src']);
    const visible = flattenTree(roots, new Set(ancestors));
    expect(visible.filter(row => row.node.file).map(row => row.node.file?.id)).toEqual(['work', 'add']);
    expect(visible.find(row => row.node.file?.id === 'work')).toMatchObject({ depth: 4, position: 1, siblings: 2 });
    expect(flattenTree(roots, new Set()).map(row => row.node.id)).toEqual(['group:changes', 'group:untracked']);
  });

  it('copies only selected comparisons with an honest draft and escaped unusual paths', () => {
    const summary = reviewSummary(files, new Set(['work', 'other']), ' Refine view  ');
    expect(summary).toContain('Refine view\n\nChanges (1)');
    expect(summary).toContain('"docs/hello\\n世界\\t.md"');
    expect(summary).not.toContain('Unstaged');
    expect(summary).not.toContain('new.ts');
  });

  it('preserves a checked tracked path when migrating from staging groups', () => {
    const file = files[0];
    expect(isReviewed(file, new Set([reviewKey({ ...file, group: 'staged' })]))).toBe(true);
    expect(isReviewed(file, new Set([reviewKey({ ...file, group: 'unstaged' })]))).toBe(true);
    expect(isReviewed(file, new Set())).toBe(false);
    expect(isReviewed(files[1], new Set([reviewKey(file)]))).toBe(false);
  });

  it('does not invent empty groups and sorts folders before root files', () => {
    expect(buildChangeTree([])).toEqual([]);
    const root = buildChangeTree([
      { id: 'f', path: 'package.json', status: '?', group: 'untracked' },
      { id: 'd', path: 'z/test.ts', status: '?', group: 'untracked' },
    ])[0];
    expect(root.children.map(node => node.kind)).toEqual(['folder', 'file']);
  });

  it('keeps local review selection stable across fresh snapshot IDs and distinguishes comparison groups', () => {
    const before = files[0];
    const refreshed = { ...before, id: 'fresh-opaque-ipc-id' };
    expect(reviewKey(before)).toBe(reviewKey(refreshed));
    expect(reviewKey(before)).not.toBe(reviewKey({ ...before, group: 'untracked' }));
    expect(reviewKey({ group: 'staged', path: 'odd:\n"path' })).toBe('["staged","odd:\\n\\"path"]');
  });
});
