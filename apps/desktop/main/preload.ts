import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, RepositorySnapshot } from '../src/bridge';
import type { FileSearchBatch } from '../../shared/search/types';
import { isApplicationActionId } from '../../shared/actions/contracts';
const bridge: DesktopBridge = {
  readProfilerSnapshot: () => ipcRenderer.invoke('profiler:read'),
  readProfilerHistory: () => ipcRenderer.invoke('profiler:history'),
  clearProfilerHistory: () => ipcRenderer.invoke('profiler:clear-history'),
  subscribeToApplicationActions(callback) {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => { if (isApplicationActionId(action)) callback(action); };
    ipcRenderer.on('application:action', listener);
    return () => ipcRenderer.removeListener('application:action', listener);
  },
  updateApplicationMenuState: state => ipcRenderer.invoke('application:menu-state', state),
  performNativeEdit: action => ipcRenderer.invoke('application:native-edit', action),
  getTreeActions: (repositoryId, target) => ipcRenderer.invoke('tree-actions:get', repositoryId, target),
  performTreeAction: (repositoryId, target, action) => ipcRenderer.invoke('tree-actions:perform', repositoryId, target, action),
  getProjectTreePreferences: repositoryId => ipcRenderer.invoke('project:preferences', repositoryId),
  setProjectTreePreferences: (repositoryId, patch) => ipcRenderer.invoke('project:set-preferences', repositoryId, patch),
  markProjectDirectory: (repositoryId, directoryId, marking) => ipcRenderer.invoke('project:mark', repositoryId, directoryId, marking),
  chooseSearchDirectory: repositoryId => ipcRenderer.invoke('search:choose-directory', repositoryId),
  startFileSearch: (repositoryId, request) => ipcRenderer.invoke('search:start', repositoryId, request),
  cancelFileSearch: (repositoryId, requestId) => ipcRenderer.invoke('search:cancel', repositoryId, requestId),
  subscribeToFileSearch(callback) {
    const listener = (_event: Electron.IpcRendererEvent, batch: FileSearchBatch) => callback(batch);
    ipcRenderer.on('search:batch', listener);
    return () => ipcRenderer.removeListener('search:batch', listener);
  },
  listBranches: repositoryId => ipcRenderer.invoke('branches:list', repositoryId),
  runBranchOperation: (repositoryId, token, operation) => ipcRenderer.invoke('branches:run', repositoryId, token, operation),
  compareBranches: (repositoryId, ref, target, swap) => ipcRenderer.invoke('branches:compare', repositoryId, ref, target, swap),
  readBranchComparison: (repositoryId, comparisonId, changeId) => ipcRenderer.invoke('branches:read', repositoryId, comparisonId, changeId),
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  createProject: () => ipcRenderer.invoke('repository:create'),
  cloneProject: url => ipcRenderer.invoke('repository:clone', url),
  listRecentProjects: () => ipcRenderer.invoke('repository:recent'),
  openRecentProject: id => ipcRenderer.invoke('repository:open-recent', id),
  getLastRepository: () => ipcRenderer.invoke('repository:last'),
  getWindowProject: () => ipcRenderer.invoke('workspace:project'),
  getWindowSessionId: () => ipcRenderer.invoke('workspace:session'),
  listOpenRepositories: () => ipcRenderer.invoke('repository:open'),
  listChanges: (repositoryId) => ipcRenderer.invoke('repository:list', repositoryId),
  refreshRepository: (repositoryId) => ipcRenderer.invoke('repository:refresh', repositoryId),
  activateRepository: (repositoryId) => ipcRenderer.invoke('repository:activate', repositoryId),
  readComparison: (repositoryId, changeId) => ipcRenderer.invoke('repository:read', repositoryId, changeId),
  listProjectDirectory: (repositoryId, directoryId) => ipcRenderer.invoke('project:list', repositoryId, directoryId),
  readProjectFile: (repositoryId, entryId) => ipcRenderer.invoke('project:read', repositoryId, entryId),
  readMarkdownImage: (repositoryId, entryId, href) => ipcRenderer.invoke('markdown:image', repositoryId, entryId, href),
  resolveMarkdownLink: (repositoryId, entryId, href) => ipcRenderer.invoke('markdown:resolve-link', repositoryId, entryId, href),
  openMarkdownLink: url => ipcRenderer.invoke('markdown:open-link', url),
  saveText: (repositoryId, editId, version, text) => ipcRenderer.invoke('text:save', repositoryId, editId, version, text),
  getFileActions: (repositoryId, target) => ipcRenderer.invoke('file-actions:get', repositoryId, target),
  openFileIn: (repositoryId, target, applicationId) => ipcRenderer.invoke('file-actions:open', repositoryId, target, applicationId),
  copyFilePath: (repositoryId, target, format) => ipcRenderer.invoke('file-actions:copy-path', repositoryId, target, format),
  subscribeToOpenRepositories(callback) {
    const listener = (_event: Electron.IpcRendererEvent, repositories: unknown) => {
      if (Array.isArray(repositories)) callback(repositories);
    };
    ipcRenderer.on('repository:open-changed', listener);
    return () => ipcRenderer.removeListener('repository:open-changed', listener);
  },
  subscribeToRepositorySnapshots(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: RepositorySnapshot) => callback(snapshot);
    ipcRenderer.on('repository:snapshot', listener);
    return () => ipcRenderer.removeListener('repository:snapshot', listener);
  },
  subscribeToRepositoryScanErrors(callback) {
    const listener = (_event: Electron.IpcRendererEvent, repositoryId: string, message: string) => callback(repositoryId, message);
    ipcRenderer.on('repository:scan-error', listener);
    return () => ipcRenderer.removeListener('repository:scan-error', listener);
  },
  subscribeToRepositoryChanges(callback) {
    const listener = (_event: Electron.IpcRendererEvent, repositoryId: unknown) => {
      if (typeof repositoryId === 'string') callback(repositoryId);
    };
    ipcRenderer.on('repository:changed', listener);
    return () => ipcRenderer.removeListener('repository:changed', listener);
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));

// Only the desktop host reserves space for native window controls. No platform
// or window-management IPC is needed in the renderer or browser playground.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.windowChrome = process.platform === 'darwin' ? 'macos' : 'native';
});
