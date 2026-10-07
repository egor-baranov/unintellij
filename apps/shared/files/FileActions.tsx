import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { FileActionsInfo, ProjectEntry, TreeAction, TreeActionsInfo } from '../../desktop/src/bridge';
import { ContextMenu, UiIcon, type ContextMenuEntry } from '../ui';
import { TreeActionDialog, type DialogTreeAction } from './TreeActionDialog';
import './file-actions.css';

/** UI identity only; each host resolves this into its own current file capability. */
export interface FileActionItem {
  kind: 'file' | 'comparison' | 'directory' | 'change-group';
  path: string;
  documentId?: string;
  entryId?: string | null;
  changeId?: string;
  /** A synthetic change group captures exact members, never a directory root. */
  changeIds?: string[];
  paths?: string[];
  label?: string;
}
type Invocation = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;
type ShowFileActions = (event: Invocation, item: FileActionItem, extra?: ContextMenuEntry[]) => boolean;
const FileActionsContext = createContext<ShowFileActions | null>(null);
export function useFileActions() { return useContext(FileActionsContext); }

interface OpenMenu {
  request: number;
  item: FileActionItem;
  position: { x: number; y: number };
  returnFocus: HTMLElement;
  extra: ContextMenuEntry[];
  info?: FileActionsInfo;
  treeInfo?: TreeActionsInfo;
  treeError?: string;
  error?: string;
}
export function FileActionsProvider({ repositoryPath, getInfo, openIn, copyPath, onSource, getTreeInfo, performAction, preview = false, children }: {
  repositoryPath: string;
  getInfo: (item: FileActionItem) => Promise<FileActionsInfo>;
  openIn: (item: FileActionItem, applicationId: string) => Promise<void>;
  copyPath?: (item: FileActionItem, format: 'absolute' | 'relative') => Promise<void>;
  onSource: (entry: ProjectEntry) => void;
  /** Fast filesystem/Git capabilities, independent of application discovery. */
  getTreeInfo?: (item: FileActionItem) => Promise<TreeActionsInfo>;
  performAction?: (item: FileActionItem, action: TreeAction) => Promise<void>;
  preview?: boolean;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<{ item: FileActionItem; info: TreeActionsInfo; kind: DialogTreeAction }>();
  const [acting, setActing] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const close = () => { request.current++; setMenu(undefined); };
  const show: ShowFileActions = (event, item, extra = []) => {
    if ('key' in event && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const position = 'key' in event || event.clientX === 0 && event.clientY === 0
      ? { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom } : { x: event.clientX, y: event.clientY };
    const current = ++request.current;
    setMenu({ request: current, item, extra, position, returnFocus: target });
    setError(undefined);
    // Native application discovery may take longer. It must not hold up tree
    // operations, or add a loading/status row that moves the menu under a pointer.
    if (getTreeInfo && performAction) void getTreeInfo(item).then(treeInfo => {
      if (mounted.current && request.current === current) setMenu(value => value?.request === current ? { ...value, treeInfo } : value);
    }).catch(cause => {
      if (mounted.current && request.current === current) setMenu(value => value?.request === current ? { ...value, treeError: message(cause) } : value);
    });
    if (item.kind !== 'directory' && item.kind !== 'change-group') void getInfo(item).then(info => {
      if (mounted.current && request.current === current) setMenu(value => value?.request === current ? { ...value, info } : value);
    }).catch(cause => {
      if (mounted.current && request.current === current) setMenu(value => value?.request === current ? { ...value, error: message(cause) } : value);
    });
    return true;
  };
  const safely = (action: () => void | Promise<void>) => async () => {
    try { await action(); }
    catch (cause) { if (mounted.current) setError(message(cause)); }
  };
  async function perform(item: FileActionItem, action: TreeAction) {
    if (!performAction) return;
    setActing(true);
    try { await performAction(item, action); }
    finally { if (mounted.current) setActing(false); }
  }
  const items: ContextMenuEntry[] = [];
  if (menu) {
    const { item, info } = menu;
    if (item.kind === 'comparison') {
      items.push({ id: 'source', label: 'Jump to Source', icon: <UiIcon name="file" />, disabled: !info?.source,
        description: !info?.source ? menu.error ?? info?.unavailableReason : undefined,
        onSelect: safely(() => { if (info?.source) onSource(info.source); }) });
      items.push({ id: 'source-separator', kind: 'separator' });
    }
    if (getTreeInfo && performAction || item.kind === 'change-group') {
      const treeInfo = menu.treeInfo;
      const reason = (specific?: string) => menu.treeError ?? specific ?? (preview ? 'Available in desktop app' : undefined);
      const prompt = (kind: DialogTreeAction) => { if (treeInfo) setAction({ item, info: treeInfo, kind }); };
      items.push(
        { id: 'add-to-git', label: 'Add to Git', className: 'tree-action-menu-item', disabled: acting || !treeInfo?.canAdd, description: reason(treeInfo?.addReason), onSelect: safely(() => perform(item, { kind: 'add' })) },
        { id: 'remove-from-git', label: 'Remove from Git…', className: 'tree-action-menu-item', disabled: acting || !treeInfo?.canRemove, description: reason(treeInfo?.removeReason), onSelect: () => prompt('remove') },
      );
      if (item.kind !== 'change-group') items.push(
        { id: 'rename', label: 'Rename…', className: 'tree-action-menu-item', disabled: acting || !treeInfo?.canRename, description: reason(treeInfo?.renameReason), onSelect: () => prompt('rename') },
        { id: 'new', label: 'New', className: 'tree-action-menu-item', disabled: acting || !treeInfo?.canCreate, description: reason(treeInfo?.createReason), items: [
          { id: 'new-file', label: 'File…', onSelect: () => prompt('create-file') },
          { id: 'new-folder', label: 'Folder…', onSelect: () => prompt('create-directory') },
        ] },
        { id: 'tree-actions-separator', kind: 'separator' },
      );
    }
    const separator = repositoryPath.includes('\\') ? '\\' : '/';
    const absolutePath = info?.absolutePath ?? `${repositoryPath.replace(/[\\/]$/, '')}${separator}${item.path.split('/').join(separator)}`;
    if (item.kind !== 'change-group') items.push(
      { id: 'copy-path', label: 'Copy Path', icon: <UiIcon name="copy" />, onSelect: safely(() => copyPath ? copyPath(item, 'absolute') : navigator.clipboard.writeText(absolutePath)) },
      { id: 'copy-relative-path', label: 'Copy Relative Path', onSelect: safely(() => copyPath ? copyPath(item, 'relative') : navigator.clipboard.writeText(info?.path ?? item.path)) },
    );
    if (item.kind !== 'directory' && item.kind !== 'change-group') items.push({ id: 'open-in', label: 'Open In', icon: <UiIcon name="folder" />, items: info?.applications.length ? info.applications.map(application => ({
        id: application.id, label: application.name,
        icon: application.icon ? <img className="file-action-app-icon" src={application.icon} alt="" /> : <UiIcon name="file" />,
        onSelect: safely(() => openIn(item, application.id)),
      })) : [{ id: 'open-unavailable', label: preview ? 'Available in desktop app' : menu.error ?? info?.unavailableReason ?? 'Loading applications…', disabled: true, onSelect: () => {} }] });
    if (menu.extra.length) items.push({ id: 'tabs-separator', kind: 'separator' }, ...menu.extra);
  }
  return <FileActionsContext.Provider value={show}>
    {children}
    {menu && <ContextMenu key={menu.request} label={menu.item.kind === 'change-group' ? `${menu.item.label} actions` : menu.item.kind === 'directory' ? 'Directory actions' : 'File actions'} position={menu.position} items={items} onClose={close} returnFocus={menu.returnFocus} />}
    {action && <TreeActionDialog kind={action.kind} info={action.info} onPerform={request => perform(action.item, request)} onClose={() => setAction(undefined)} />}
    {error && <div className="file-action-error" role="alert"><span>{error}</span><button type="button" className="chrome-icon-button" aria-label="Dismiss file action error" onClick={() => setError(undefined)}><UiIcon name="close" /></button></div>}
  </FileActionsContext.Provider>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
