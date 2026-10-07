import type { GroupId, WorkspaceDocument, WorkspaceState, WorkspaceTab } from '../../shared/workspace/model';
import { decodeWorkspaceViews, type SavedTab } from '../../shared/workspace/viewState';
import type { ProjectDirectory, ProjectEntry } from './bridge';

export interface SessionTab {
  instanceId: string;
  path: string;
  kind: 'file' | 'comparison';
  comparisonGroup?: WorkspaceDocument['comparisonGroup'];
}
export interface WorkspaceChrome { mode: 'project' | 'commit'; sidebarVisible: boolean; sidebarWidth: number }
export interface WorkspaceSession {
  version: 1;
  groups: { id: GroupId; tabs: SessionTab[]; activeInstanceId: string | null }[];
  activeGroupId: GroupId;
  direction: 'right' | 'down';
  splitRatio: number;
  views: Record<string, SavedTab>;
  chrome: WorkspaceChrome;
}
const maxTabs = 200;
const maxSerializedLength = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const instanceId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const group = (value: unknown) => value === 'untracked' || value === 'staged' || value === 'unstaged' || value === 'working' ? value : undefined;
const bound = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Persist semantic paths and editor positions, never process-local Git/edit capabilities. */
export function decodeWorkspaceSession(value: unknown): WorkspaceSession | undefined {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.groups) || !value.groups.length) return;
  const seen = new Set<string>();
  const groups: WorkspaceSession['groups'] = [];
  let count = 0;
  for (const candidate of value.groups.slice(0, 2)) {
    if (!object(candidate) || (candidate.id !== 'primary' && candidate.id !== 'secondary') || !Array.isArray(candidate.tabs) || groups.some(item => item.id === candidate.id)) continue;
    const tabs: SessionTab[] = [];
    const documents = new Set<string>();
    for (const tab of candidate.tabs) {
      if (count >= maxTabs) break;
      if (!object(tab) || !instanceId(tab.instanceId) || seen.has(tab.instanceId) || !path(tab.path) || (tab.kind !== 'file' && tab.kind !== 'comparison')) continue;
      const identity = JSON.stringify([tab.kind, tab.path]);
      if (documents.has(identity)) continue;
      seen.add(tab.instanceId); documents.add(identity); count++;
      tabs.push({ instanceId: tab.instanceId, path: tab.path, kind: tab.kind, ...(tab.kind === 'comparison' ? { comparisonGroup: group(tab.comparisonGroup) ?? 'working' } : {}) });
    }
    groups.push({ id: candidate.id, tabs, activeInstanceId: tabs.find(tab => tab.instanceId === candidate.activeInstanceId)?.instanceId ?? tabs[0]?.instanceId ?? null });
  }
  if (!groups.length) return;
  const views = decodeWorkspaceViews(value.views);
  const chrome = object(value.chrome) ? value.chrome : {};
  return { version: 1, groups, activeGroupId: groups.find(item => item.id === value.activeGroupId)?.id ?? groups[0].id,
    direction: value.direction === 'down' ? 'down' : 'right', splitRatio: bound(value.splitRatio, .15, .85, .5),
    views: Object.fromEntries(Object.entries(views).filter(([id]) => seen.has(id))),
    chrome: { mode: chrome.mode === 'project' ? 'project' : 'commit', sidebarVisible: chrome.sidebarVisible !== false, sidebarWidth: bound(chrome.sidebarWidth, 280, 560, 340) } };
}

export const workspaceSessionKey = (repositoryPath: string, windowId?: string) => `smart-diff:editor-session:v1:${JSON.stringify([repositoryPath, windowId ?? 'latest'])}`;
export function readWorkspaceSession(repositoryPath: string, windowId: string): WorkspaceSession | undefined {
  for (const key of [workspaceSessionKey(repositoryPath, windowId), workspaceSessionKey(repositoryPath)]) {
    try {
      const raw = localStorage.getItem(key);
      if (raw && raw.length <= maxSerializedLength) { const saved = decodeWorkspaceSession(JSON.parse(raw)); if (saved) return saved; }
    } catch { /* A malformed or unavailable store must not prevent opening a repository. */ }
  }
}
export function saveWorkspaceSession(repositoryPath: string, windowId: string, state: WorkspaceState, views: Record<string, SavedTab>, chrome: WorkspaceChrome): void {
  const session: WorkspaceSession = { version: 1, groups: state.groups.map(item => ({ id: item.id,
    tabs: item.tabs.map(tab => ({ instanceId: tab.instanceId, path: tab.path, kind: tab.kind, comparisonGroup: tab.comparisonGroup })),
    activeInstanceId: item.tabs.find(tab => tab.id === item.activeId)?.instanceId ?? null })),
    activeGroupId: state.activeGroupId, direction: state.direction, splitRatio: state.splitRatio, views, chrome };
  try {
    const raw = JSON.stringify(session);
    if (raw.length > maxSerializedLength) return;
    localStorage.setItem(workspaceSessionKey(repositoryPath, windowId), raw);
    // Newly opened windows inherit the repository's most recently used layout.
    localStorage.setItem(workspaceSessionKey(repositoryPath), raw);
  } catch { /* Keep editing available if the browser store is full or disabled. */ }
}

/** Recreate identities using this process's repository; old capability IDs are never reused. */
export function restoreWorkspace(session: WorkspaceSession, document: (tab: SessionTab) => WorkspaceDocument): WorkspaceState {
  return { groups: session.groups.map(item => {
    const tabs: WorkspaceTab[] = item.tabs.map(tab => ({ ...document(tab), instanceId: tab.instanceId }));
    return { id: item.id, tabs, activeId: tabs.find(tab => tab.instanceId === item.activeInstanceId)?.id ?? tabs[0]?.id ?? null };
  }), activeGroupId: session.activeGroupId, direction: session.direction, splitRatio: session.splitRatio };
}

/** Reissue project capabilities by walking allowed directory listings, never by opening a stored path. */
export async function resolveProjectPaths(paths: string[], load: (id: string | null) => Promise<ProjectDirectory>): Promise<Map<string, ProjectEntry>> {
  const directories = new Map<string | null, Promise<ProjectDirectory>>();
  const list = (id: string | null) => { let result = directories.get(id); if (!result) { result = load(id); directories.set(id, result); } return result; };
  const entries = new Map<string, ProjectEntry>();
  await Promise.all(paths.map(async filePath => {
    if (!path(filePath)) return;
    try {
      let directoryId: string | null = null;
      const parts = filePath.split('/');
      for (let index = 0; index < parts.length; index++) {
        const directory = await list(directoryId);
        const entry = directory.entries.find(item => item.path === parts.slice(0, index + 1).join('/'));
        if (!entry) return;
        if (index === parts.length - 1) { if (entry.kind !== 'directory') entries.set(filePath, entry); }
        else { if (entry.kind !== 'directory') return; directoryId = entry.id; }
      }
    } catch { /* Missing/deleted files stay as unavailable tabs and can recover after refresh. */ }
  }));
  return entries;
}
