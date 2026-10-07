import { useCallback, useReducer } from 'react';
import { createWorkspace, workspaceReducer, type DockEdge, type GroupId, type SplitDirection, type WorkspaceDocument, type WorkspaceState } from './model';

export function useEditorWorkspace(initialDocuments: WorkspaceDocument[] = [], initialState?: WorkspaceState) {
  const [state, dispatch] = useReducer(workspaceReducer, { initialDocuments, initialState }, value => value.initialState ?? createWorkspace(value.initialDocuments));
  const open = useCallback((document: WorkspaceDocument, groupId?: GroupId) => dispatch({ type: 'open', document, groupId, instanceId: crypto.randomUUID() }), []);
  const activate = useCallback((groupId: GroupId, id: string) => dispatch({ type: 'activate', groupId, id }), []);
  const close = useCallback((groupId: GroupId, id: string) => dispatch({ type: 'close', groupId, id }), []);
  const split = useCallback((groupId: GroupId, direction: SplitDirection) => dispatch({ type: 'split', groupId, direction, instanceId: crypto.randomUUID() }), []);
  const dock = useCallback((sourceGroup: GroupId, id: string, edge: DockEdge) => dispatch({ type: 'dock', sourceGroup, id, edge, instanceId: crypto.randomUUID() }), []);
  const move = useCallback((sourceGroup: GroupId, id: string, targetGroup: GroupId, index?: number) => dispatch({ type: 'move', sourceGroup, id, targetGroup, index }), []);
  const join = useCallback(() => dispatch({ type: 'join' }), []);
  const setRatio = useCallback((ratio: number) => dispatch({ type: 'ratio', ratio }), []);
  const focusGroup = useCallback((groupId: GroupId) => dispatch({ type: 'focus', groupId }), []);
  const replaceDocuments = useCallback((replacements: { id: string; document: WorkspaceDocument }[]) => dispatch({ type: 'replace-documents', replacements }), []);
  return { state, open, activate, close, split, dock, move, join, setRatio, focusGroup, replaceDocuments };
}
export type EditorWorkspaceController = ReturnType<typeof useEditorWorkspace>;
