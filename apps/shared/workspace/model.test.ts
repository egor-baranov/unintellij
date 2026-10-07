import { describe, expect, it } from 'vitest';
import { createWorkspace, dockPlacement, workspaceReducer as reduce, type DockEdge, type GroupId, type WorkspaceDocument, type WorkspaceState } from './model';

const a: WorkspaceDocument = { id: 'a', path: 'src/a.ts', kind: 'file' };
const b: WorkspaceDocument = { id: 'b', path: 'src/b.ts', kind: 'comparison', description: 'Index → Working tree' };
const c: WorkspaceDocument = { id: 'c', path: 'src/c.ts', kind: 'file' };
function initial(documents = [a, b, c]) { let id = 0; return createWorkspace(documents, () => `instance-${++id}`); }
function split(state: WorkspaceState) { return reduce(state, { type: 'split', groupId: 'primary', direction: 'right', instanceId: 'cloned' }); }

describe('editor workspace model', () => {
  it('renames documents across split groups without losing order, focus, or view-state identity', () => {
    const state = split(initial());
    const renamed = { ...c, id: 'renamed', path: 'src/renamed.ts', editKey: 'new-key' };
    const next = reduce(state, { type: 'replace-documents', replacements: [{ id: 'c', document: renamed }] });
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'renamed']);
    expect(next.groups[0].tabs[2]).toMatchObject({ ...renamed, instanceId: 'instance-3' });
    expect(next.groups[1].tabs[0]).toMatchObject({ ...renamed, instanceId: 'cloned', sourceInstanceId: 'instance-3' });
    expect(next.groups.map(group => group.activeId)).toEqual(['renamed', 'renamed']);
    expect(next.activeGroupId).toBe('secondary');
    expect(state.groups[0].tabs[2].id).toBe('c');
  });
  it('prefers the renamed editor over an existing unavailable destination tab', () => {
    const state = initial([{ ...c, id: 'destination' }, a, b]);
    const next = reduce(state, { type: 'replace-documents', replacements: [{ id: 'a', document: { ...a, id: 'destination', path: c.path } }] });
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(['destination', 'b']);
    expect(next.groups[0].tabs[0].instanceId).toBe('instance-2');
    expect(next.groups[0].activeId).toBe('b');
  });
  it('updates a renamed comparison when a later Git refresh changes its group', () => {
    const document: WorkspaceDocument = { ...b, comparisonGroup: 'working', description: 'working' };
    const state = split(initial([document]));
    const next = reduce(state, { type: 'replace-documents', replacements: [{ id: b.id, document: { ...document, comparisonGroup: 'untracked', description: 'untracked' } }] });
    expect(next.groups.flatMap(group => group.tabs).map(tab => [tab.instanceId, tab.comparisonGroup, tab.description])).toEqual([
      ['instance-1', 'untracked', 'untracked'], ['cloned', 'untracked', 'untracked'],
    ]);
    expect(next.groups.map(group => group.activeId)).toEqual(['b', 'b']);
  });
  it('deduplicates documents per group and updates existing tabs without replacing their instance', () => {
    const state = initial([a, a, b]);
    expect(state.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b']);
    const instance = state.groups[0].tabs[0].instanceId;
    const opened = reduce(state, { type: 'open', document: { ...a, path: 'src/renamed.ts' }, instanceId: 'unused' });
    expect(opened.groups[0].tabs).toHaveLength(2);
    expect(opened.groups[0].tabs[0]).toMatchObject({ instanceId: instance, path: 'src/renamed.ts' });
    expect(opened.groups[0].activeId).toBe('a');
    expect(state.groups[0].tabs[0].path).toBe('src/a.ts');
  });
  it('split copies carry a source instance and remain distinct across groups', () => {
    const state = initial();
    const next = split(state);
    expect(next.groups).toHaveLength(2);
    expect(next.activeGroupId).toBe('secondary');
    expect(next.groups[1].tabs[0]).toMatchObject({ ...c, instanceId: 'cloned', sourceInstanceId: 'instance-3' });
    const again = reduce(next, { type: 'split', groupId: 'primary', direction: 'down', instanceId: 'unused' });
    expect(again.groups[1].tabs).toEqual(next.groups[1].tabs);
    expect(again.direction).toBe('down');
    expect(again.groups).toHaveLength(2);
  });
  it('reorders tabs without changing instances or losing selection', () => {
    const state = initial();
    const next = reduce(state, { type: 'move', sourceGroup: 'primary', targetGroup: 'primary', id: 'c', index: 0 });
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(['c', 'a', 'b']);
    expect(next.groups[0].tabs[0].instanceId).toBe('instance-3');
    expect(next.groups[0].activeId).toBe('c');
    expect(state.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
  });
  it('moving into a duplicate replaces it with the moved instance', () => {
    const state = split(initial());
    const next = reduce(state, { type: 'move', sourceGroup: 'primary', targetGroup: 'secondary', id: 'c' });
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b']);
    expect(next.groups[1].tabs).toHaveLength(1);
    expect(next.groups[1].tabs[0].instanceId).toBe('instance-3');
    expect(next.activeGroupId).toBe('secondary');
  });
  it('closing active tabs chooses a neighbor and closing inactive tabs retains selection', () => {
    let state = initial();
    state = reduce(state, { type: 'activate', groupId: 'primary', id: 'b' });
    state = reduce(state, { type: 'close', groupId: 'primary', id: 'a' });
    expect(state.groups[0].activeId).toBe('b');
    state = reduce(state, { type: 'close', groupId: 'primary', id: 'b' });
    expect(state.groups[0].activeId).toBe('c');
    state = reduce(state, { type: 'close', groupId: 'primary', id: 'c' });
    expect(state.groups).toEqual([{ id: 'primary', tabs: [], activeId: null }]);
  });
  it('normalizes empty split groups while preserving the remaining instance', () => {
    const state = split(initial([a]));
    const promoted = reduce(state, { type: 'close', groupId: 'primary', id: 'a' });
    expect(promoted.groups).toHaveLength(1);
    expect(promoted.groups[0]).toMatchObject({ id: 'primary', activeId: 'a' });
    expect(promoted.groups[0].tabs[0].instanceId).toBe('cloned');
    const removed = reduce(state, { type: 'close', groupId: 'secondary', id: 'a' });
    expect(removed.groups).toHaveLength(1);
    expect(removed.groups[0].tabs[0].instanceId).toBe('instance-1');
  });
  it('joining groups deduplicates documents and retains the focused copy and distinct files', () => {
    let state = split(initial([a, b]));
    state = reduce(state, { type: 'open', document: c, instanceId: 'new-c', groupId: 'secondary' });
    state = reduce(state, { type: 'activate', groupId: 'secondary', id: 'b' });
    const joined = reduce(state, { type: 'join' });
    expect(joined.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
    expect(joined.groups[0].tabs.find(tab => tab.id === 'b')!.instanceId).toBe('cloned');
    expect(joined.groups[0].activeId).toBe('b');
    expect(joined.activeGroupId).toBe('primary');
  });
  it('opens into the focused group and rejects obsolete group/tab references', () => {
    const state = split(initial([a]));
    const opened = reduce(state, { type: 'open', document: b, instanceId: 'new-b' });
    expect(opened.groups[1].tabs.map(tab => tab.id)).toEqual(['a', 'b']);
    expect(reduce(state, { type: 'activate', groupId: 'primary', id: 'missing' })).toBe(state);
    expect(reduce(state, { type: 'move', sourceGroup: 'primary', targetGroup: 'secondary', id: 'missing' })).toBe(state);
    expect(reduce(state, { type: 'close', groupId: 'secondary', id: 'missing' })).toBe(state);
    expect(reduce(initial([]), { type: 'split', groupId: 'primary', direction: 'down', instanceId: 'unused' }).groups).toHaveLength(1);
  });
  it('clamps split ratios and ignores nonfinite values', () => {
    expect(reduce(initial(), { type: 'ratio', ratio: -10 }).splitRatio).toBe(.15);
    expect(reduce(initial(), { type: 'ratio', ratio: 10 }).splitRatio).toBe(.85);
    const state = initial();
    expect(reduce(state, { type: 'ratio', ratio: NaN })).toBe(state);
  });
});

describe('directional tab docking', () => {
  const edges: DockEdge[] = ['left', 'right', 'up', 'down'];
  const groups: GroupId[] = ['primary', 'secondary'];
  const dock = (state: WorkspaceState, sourceGroup: GroupId, id: string, edge: DockEdge) => reduce(state, { type: 'dock', sourceGroup, id, edge, instanceId: 'dock-copy' });

  it.each(edges)('docks the original instance on the %s of a single group', edge => {
    const state = reduce(initial([a, { ...b, editKey: 'shared-buffer' }, c]), { type: 'activate', groupId: 'primary', id: 'b' });
    const { direction, destination } = dockPlacement(edge);
    const next = dock(state, 'primary', 'b', edge);
    expect(next.groups.map(group => group.id)).toEqual(['primary', 'secondary']);
    expect(next.direction).toBe(direction);
    expect(next.activeGroupId).toBe(destination);
    expect(next.groups.find(group => group.id === destination)).toEqual({ id: destination, tabs: [state.groups[0].tabs[1]], activeId: 'b' });
    const remaining = next.groups.find(group => group.id !== destination)!;
    expect(remaining.tabs.map(tab => [tab.id, tab.instanceId])).toEqual([['a', 'instance-1'], ['c', 'instance-3']]);
    expect(remaining.activeId).toBe('c');
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
  });

  it.each(edges)('splits a singleton toward %s without replacing its view identity', edge => {
    const state = initial([{ ...b, editKey: 'shared-buffer' }]);
    const { destination } = dockPlacement(edge);
    const next = dock(state, 'primary', 'b', edge);
    expect(next.groups.find(group => group.id === destination)?.tabs).toEqual(state.groups[0].tabs);
    expect(next.groups.find(group => group.id !== destination)?.tabs).toEqual([{ ...b, editKey: 'shared-buffer', instanceId: 'dock-copy', sourceInstanceId: 'instance-1' }]);
    expect(new Set(next.groups.flatMap(group => group.tabs.map(tab => tab.instanceId))).size).toBe(2);
    expect(next.groups.map(group => group.activeId)).toEqual(['b', 'b']);
  });

  it.each(groups.flatMap(source => edges.map(edge => ({ source, edge }))))('docks from $source toward $edge using physical sides rather than the opposite group', ({ source, edge }) => {
    let state = split(initial([a, b, c]));
    state = reduce(state, { type: 'open', groupId: 'secondary', document: { ...a, id: 'd' }, instanceId: 'instance-d' });
    state = reduce(state, { type: 'ratio', ratio: .37 });
    const id = source === 'primary' ? 'b' : 'd';
    const original = state.groups.find(group => group.id === source)!.tabs.find(tab => tab.id === id)!;
    const { direction, destination } = dockPlacement(edge);
    const next = dock(state, source, id, edge);
    expect(next.groups).toHaveLength(2);
    expect(next.direction).toBe(direction);
    expect(next.splitRatio).toBe(.37);
    expect(next.activeGroupId).toBe(destination);
    expect(next.groups.find(group => group.id === destination)?.activeId).toBe(id);
    expect(next.groups.find(group => group.id === destination)?.tabs.find(tab => tab.id === id)).toBe(original);
    if (source === destination) {
      expect(next.groups.map(group => group.tabs)).toEqual(state.groups.map(group => group.tabs));
    } else {
      expect(next.groups.find(group => group.id === source)?.tabs.some(tab => tab.id === id)).toBe(false);
      expect(next.groups.find(group => group.id === source)?.activeId).toBe('c');
    }
  });

  it('deduplicates the destination at its existing position and keeps the dragged edit/view identity', () => {
    const state = reduce(split(initial([a, { ...b, editKey: 'shared-buffer' }])), { type: 'open', groupId: 'secondary', document: c, instanceId: 'secondary-c' });
    const next = dock(state, 'primary', 'b', 'down');
    expect(next.groups[1].tabs.map(tab => tab.id)).toEqual(['b', 'c']);
    expect(next.groups[1].tabs[0]).toBe(state.groups[0].tabs[1]);
    expect(next.groups[1].tabs[0]).toMatchObject({ instanceId: 'instance-2', editKey: 'shared-buffer' });
    expect(next.groups[1].tabs[1]).toBe(state.groups[1].tabs[1]);
    expect(next.groups[0].activeId).toBe('a');
  });

  it.each([{ source: 'primary' as const, edge: 'right' as const }, { source: 'secondary' as const, edge: 'left' as const }])('keeps a linked source view when docking its last tab from $source', ({ source, edge }) => {
    const state = split(initial([{ ...b, editKey: 'shared-buffer' }]));
    const original = state.groups.find(group => group.id === source)!.tabs[0];
    const next = dock(state, source, 'b', edge);
    expect(next.groups.find(group => group.id !== source)?.tabs).toEqual([original]);
    expect(next.groups.find(group => group.id === source)?.tabs).toEqual([{ ...original, instanceId: 'dock-copy', sourceInstanceId: original.instanceId }]);
    expect(next.groups.map(group => group.tabs.length)).toEqual([1, 1]);
  });

  it('retains the remaining active tab when docking an inactive tab', () => {
    const state = initial();
    const next = dock(state, 'primary', 'a', 'left');
    expect(next.groups[1].activeId).toBe('c');
    expect(next.groups[0].activeId).toBe('a');
  });

  it('ignores stale source groups and missing documents without changing layout', () => {
    const state = initial();
    expect(dock(state, 'secondary', 'a', 'left')).toBe(state);
    expect(dock(state, 'primary', 'missing', 'down')).toBe(state);
    const empty = initial([]);
    expect(dock(empty, 'primary', 'a', 'up')).toBe(empty);
  });
});
