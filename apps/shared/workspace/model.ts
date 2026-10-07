export type GroupId = 'primary' | 'secondary';
export type SplitDirection = 'right' | 'down';
export type DockEdge = 'left' | 'right' | 'up' | 'down';
/** Group identities describe physical placement: primary is left/top, secondary is right/bottom. */
export function dockPlacement(edge: DockEdge): { direction: SplitDirection; destination: GroupId } {
  return { direction: edge === 'left' || edge === 'right' ? 'right' : 'down', destination: edge === 'left' || edge === 'up' ? 'primary' : 'secondary' };
}
export interface WorkspaceDocument { id: string; path: string; kind: 'file' | 'comparison'; description?: string; editKey?: string; comparisonGroup?: 'working' | 'staged' | 'unstaged' | 'untracked' }
export interface WorkspaceTab extends WorkspaceDocument { instanceId: string; sourceInstanceId?: string }
export interface WorkspaceGroup { id: GroupId; tabs: WorkspaceTab[]; activeId: string | null }
export interface WorkspaceState { groups: WorkspaceGroup[]; activeGroupId: GroupId; direction: SplitDirection; splitRatio: number }
export type WorkspaceAction =
  | { type: 'open'; document: WorkspaceDocument; instanceId: string; groupId?: GroupId }
  | { type: 'activate'; groupId: GroupId; id: string }
  | { type: 'close'; groupId: GroupId; id: string }
  | { type: 'split'; groupId: GroupId; direction: SplitDirection; instanceId: string }
  | { type: 'dock'; sourceGroup: GroupId; id: string; edge: DockEdge; instanceId: string }
  | { type: 'move'; sourceGroup: GroupId; id: string; targetGroup: GroupId; index?: number }
  | { type: 'join' }
  | { type: 'ratio'; ratio: number }
  | { type: 'focus'; groupId: GroupId }
  | { type: 'replace-documents'; replacements: { id: string; document: WorkspaceDocument }[] };

export function createWorkspace(documents: WorkspaceDocument[] = [], instanceId: () => string = () => crypto.randomUUID()): WorkspaceState {
  const unique = [...new Map(documents.map(document => [document.id, document])).values()];
  return { groups: [{ id: 'primary', tabs: unique.map(document => ({ ...document, instanceId: instanceId() })), activeId: unique.at(-1)?.id ?? null }], activeGroupId: 'primary', direction: 'right', splitRatio: .5 };
}

function withoutTab(group: WorkspaceGroup, id: string): WorkspaceGroup {
  const index = group.tabs.findIndex(tab => tab.id === id);
  const tabs = group.tabs.filter(tab => tab.id !== id);
  return { ...group, tabs, activeId: group.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : group.activeId };
}
function normalize(state: WorkspaceState): WorkspaceState {
  const nonempty = state.groups.filter(group => group.tabs.length);
  if (nonempty.length < 2) {
    const group = nonempty[0] ?? { id: 'primary' as const, tabs: [], activeId: null };
    return { ...state, groups: [{ ...group, id: 'primary' }], activeGroupId: 'primary' };
  }
  return state;
}
const otherGroup = (id: GroupId): GroupId => id === 'primary' ? 'secondary' : 'primary';

/** Immutable tab transitions: document IDs dedupe per group, instance IDs own view state. */
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'replace-documents': {
      const replacements = new Map(action.replacements.map(item => [item.id, item.document]));
      if (!state.groups.some(group => group.tabs.some(tab => replacements.has(tab.id)))) return state;
      return { ...state, groups: state.groups.map(group => {
        // A renamed tab retains its position and editor instance, including split copies.
        // If an unavailable destination tab already exists, prefer the renamed instance.
        const destinations = new Set(group.tabs.flatMap(tab => replacements.has(tab.id) ? [replacements.get(tab.id)!.id] : []));
        const tabs = group.tabs.filter(tab => replacements.has(tab.id) || !destinations.has(tab.id)).map(tab => {
          const document = replacements.get(tab.id);
          return document ? { ...document, instanceId: tab.instanceId, sourceInstanceId: tab.sourceInstanceId } : tab;
        });
        return { ...group, tabs, activeId: group.activeId ? replacements.get(group.activeId)?.id ?? group.activeId : null };
      }) };
    }
    case 'open': {
      const group = state.groups.find(group => group.id === (action.groupId ?? state.activeGroupId)) ?? state.groups[0];
      const existing = group.tabs.find(tab => tab.id === action.document.id);
      const tab = existing ? { ...existing, ...action.document } : { ...action.document, instanceId: action.instanceId };
      return { ...state, activeGroupId: group.id, groups: state.groups.map(item => item.id !== group.id ? item : { ...item, activeId: tab.id, tabs: existing ? item.tabs.map(item => item.id === tab.id ? tab : item) : [...item.tabs, tab] }) };
    }
    case 'activate': {
      const group = state.groups.find(group => group.id === action.groupId);
      if (!group?.tabs.some(tab => tab.id === action.id)) return state;
      if (state.activeGroupId === group.id && group.activeId === action.id) return state;
      return { ...state, activeGroupId: group.id, groups: state.groups.map(item => item.id === group.id ? { ...item, activeId: action.id } : item) };
    }
    case 'focus': return state.activeGroupId === action.groupId || !state.groups.some(group => group.id === action.groupId) ? state : { ...state, activeGroupId: action.groupId };
    case 'close': {
      if (!state.groups.some(group => group.id === action.groupId && group.tabs.some(tab => tab.id === action.id))) return state;
      return normalize({ ...state, groups: state.groups.map(group => group.id === action.groupId ? withoutTab(group, action.id) : group) });
    }
    case 'split': {
      const source = state.groups.find(group => group.id === action.groupId);
      const tab = source?.tabs.find(tab => tab.id === source.activeId);
      if (!tab) return state;
      const targetId = otherGroup(action.groupId);
      const target = state.groups.find(group => group.id === targetId) ?? { id: targetId, tabs: [], activeId: null };
      const tabs = target.tabs.some(item => item.id === tab.id) ? target.tabs : [...target.tabs, { ...tab, instanceId: action.instanceId, sourceInstanceId: tab.instanceId }];
      const next = { ...target, tabs, activeId: tab.id };
      return { ...state, activeGroupId: targetId, direction: action.direction, groups: (state.groups.some(group => group.id === targetId) ? state.groups.map(group => group.id === targetId ? next : group) : [...state.groups, next]).sort((a, b) => a.id === b.id ? 0 : a.id === 'primary' ? -1 : 1) };
    }
    case 'dock': {
      const source = state.groups.find(group => group.id === action.sourceGroup);
      const tab = source?.tabs.find(tab => tab.id === action.id);
      if (!source || !tab) return state;
      const { direction, destination } = dockPlacement(action.edge);
      const linkedCopy = (): WorkspaceTab => ({ ...tab, instanceId: action.instanceId, sourceInstanceId: tab.instanceId });
      if (state.groups.length === 1) {
        // A left/top drop moves the remaining group to the opposite physical side.
        // Keep the dragged instance intact so its cursor, scroll and draft follow it.
        const remaining = source.tabs.length > 1 ? withoutTab(source, tab.id) : { ...source, tabs: [linkedCopy()] };
        const destinationGroup: WorkspaceGroup = { id: destination, tabs: [tab], activeId: tab.id };
        const opposite = { ...remaining, id: otherGroup(destination) };
        return { ...state, direction, activeGroupId: destination, groups: destination === 'primary' ? [destinationGroup, opposite] : [opposite, destinationGroup] };
      }
      if (source.id === destination) {
        if (state.direction === direction && state.activeGroupId === source.id && source.activeId === tab.id) return state;
        return { ...state, direction, activeGroupId: destination, groups: state.groups.map(group => group.id === destination ? { ...group, activeId: tab.id } : group) };
      }
      const target = state.groups.find(group => group.id === destination)!;
      const duplicateIndex = target.tabs.findIndex(item => item.id === tab.id);
      const tabs = target.tabs.filter(item => item.id !== tab.id);
      tabs.splice(duplicateIndex < 0 ? tabs.length : duplicateIndex, 0, tab);
      // Edge docking keeps a split even when the dragged tab was its source's last
      // tab. A linked source view shares the document but owns independent view state.
      const remaining = source.tabs.length > 1 ? withoutTab(source, tab.id) : { ...source, tabs: [linkedCopy()] };
      return { ...state, direction, activeGroupId: destination, groups: state.groups.map(group => group.id === source.id ? remaining : { ...target, tabs, activeId: tab.id }) };
    }
    case 'move': {
      const source = state.groups.find(group => group.id === action.sourceGroup);
      const tab = source?.tabs.find(tab => tab.id === action.id);
      if (!source || !tab) return state;
      const target = state.groups.find(group => group.id === action.targetGroup) ?? { id: action.targetGroup, tabs: [], activeId: null };
      const duplicateIndex = target.tabs.findIndex(item => item.id === tab.id);
      const tabs = target.tabs.filter(item => item.id !== tab.id);
      const index = Math.max(0, Math.min(tabs.length, action.index ?? (source.id !== target.id && duplicateIndex >= 0 ? duplicateIndex : tabs.length)));
      tabs.splice(index, 0, tab);
      const next = { ...target, tabs, activeId: tab.id };
      const groups = state.groups.map(group => group.id === target.id ? next : group.id === source.id ? withoutTab(group, tab.id) : group);
      if (!groups.some(group => group.id === target.id)) groups.push(next);
      return normalize({ ...state, activeGroupId: target.id, groups });
    }
    case 'join': {
      if (state.groups.length < 2) return state;
      const active = state.groups.find(group => group.id === state.activeGroupId)!;
      const preferred = active.tabs.find(tab => tab.id === active.activeId);
      const tabs = [...new Map(state.groups.flatMap(group => group.tabs).map(tab => [tab.id, tab])).values()];
      const primaryTabs = new Map(state.groups[0].tabs.map(tab => [tab.id, tab]));
      const merged = tabs.map(tab => tab.id === preferred?.id ? preferred : primaryTabs.get(tab.id) ?? tab);
      return { ...state, groups: [{ id: 'primary', tabs: merged, activeId: preferred?.id ?? merged[0]?.id ?? null }], activeGroupId: 'primary' };
    }
    case 'ratio': {
      const ratio = Number.isFinite(action.ratio) ? Math.max(.15, Math.min(.85, action.ratio)) : state.splitRatio;
      return ratio === state.splitRatio ? state : { ...state, splitRatio: ratio };
    }
  }
}
