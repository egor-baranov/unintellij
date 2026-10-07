import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { version as developmentVersion } from '../../../package.json';
import { GitService } from './git';
import { markdownExternalUrl } from './markdown';
import { BranchService } from './branches';
import { createNativeFileActionsPlatform, FileActionsService } from './file-actions';
import { RepositoryWatcher } from './repository-watcher';
import { RepositorySessionStore } from './repository-session';
import { resolveUserDataDirectory } from './user-data-directory';
import { cloneProjectDirectory, createProjectDirectory, projectDisplayPath, validateCloneUrl } from './project-opening';
import { FileSearchService } from './file-search';
import { TreeActionsService, validateTreeAction, validateTreeActionTarget } from './tree-actions';
import { ProfilerService } from './profiler';
import { applicationShortcutReference, createApplicationMenuTemplate } from './application-menu';
import { validateApplicationMenuState, type ApplicationActionId, type ApplicationMenuState } from '../../shared/actions/contracts';
import { defaultTreePreferences, type DirectoryMarking, type ProjectTreePreferences } from '../../shared/project/semantics';
import type { FileSearchRequest } from '../../shared/search/types';
import type { FileActionTarget, Repository, RepositorySnapshot, WindowProject } from '../src/bridge';

const userDataDirectory = resolveUserDataDirectory({
  appDataDirectory: app.getPath('appData'),
  currentName: app.getName(),
  currentDirectory: app.getPath('userData'),
  explicitDirectory: app.commandLine.getSwitchValue('user-data-dir'),
});
app.setName('unintellij');
app.setPath('userData', userDataDirectory);
// Browser local storage holds editor settings; keep it beside the restored
// project session when an existing profile is reused after the rename.
app.setPath('sessionData', userDataDirectory);
const profiler = new ProfilerService({
  roots: [app.getPath('userData'), app.getPath('sessionData')],
  getAppMetrics: () => app.getAppMetrics(),
  getGPUFeatureStatus: () => app.getGPUFeatureStatus(),
  getGPUInfo: () => app.getGPUInfo('basic'),
});
app.once('will-quit', () => profiler.dispose());

const configuredLimit = Number(process.env.SMART_DIFF_MAX_FILE_BYTES);
const configuredPreviewLimit = Number(process.env.SMART_DIFF_MAX_PREVIEW_BYTES);
const git = new GitService({
  projectSettingsDirectory: app.getPath('userData'),
  maxFileBytes: Number.isSafeInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 100 * 1024 * 1024 ? configuredLimit : undefined,
  maxPreviewBytes: Number.isSafeInteger(configuredPreviewLimit) && configuredPreviewLimit > 0 && configuredPreviewLimit <= 100 * 1024 * 1024 ? configuredPreviewLimit : undefined,
});
const branches = new BranchService(git);
const fileSearch = new FileSearchService(git);
const treeActions = new TreeActionsService(git);
const fileActions = new FileActionsService(git, createNativeFileActionsPlatform({
  getFileIcon: async filePath => (await app.getFileIcon(filePath, { size: 'small' })).toDataURL(),
  openDefault: filePath => shell.openPath(filePath),
  reveal: filePath => shell.showItemInFolder(filePath),
}), text => clipboard.writeText(text));
interface WindowContext {
  window: BrowserWindow;
  repository: Repository | null;
  project: WindowProject | null;
  repositoryLoading?: Promise<void>;
  cloneOperation?: AbortController;
  initialSnapshot?: RepositorySnapshot;
  sessionId: string;
  watcher?: RepositoryWatcher;
  refreshTimer?: ReturnType<typeof setTimeout>;
  menuState: ApplicationMenuState;
  ready: boolean;
}
const windows = new Map<number, WindowContext>();
const knownRepositories = new Map<string, Repository>();
const backgroundScans = new Map<string, Promise<RepositorySnapshot>>();
const scanErrors = new Map<string, string>();
let registrationQueue: Promise<unknown> = Promise.resolve();
const releasingRepositories = new Set<string>();
function releaseUnusedRepositories() {
  const unused = (id: string) => ![...windows.values()].some(context =>
    context.repository?.id === id || context.project && !context.repository && !context.window.isDestroyed());
  for (const id of knownRepositories.keys()) {
    if (!unused(id) || releasingRepositories.has(id)) continue;
    releasingRepositories.add(id);
    // A finishing refresh may still own the large index. Drop the service's
    // reference once it completes, without canceling authorized Git work.
    void Promise.resolve(backgroundScans.get(id)).catch(() => undefined)
      .then(() => git.releaseRepository(id, () => unused(id)))
      .then(released => {
        if (!released) return;
        knownRepositories.delete(id);
        scanErrors.delete(id);
        branches.releaseRepository(id);
        fileActions.releaseRepository(id);
      }).catch(error => console.error('Unable to release closed project', error))
      .finally(() => { releasingRepositories.delete(id); });
  }
}
function registerRepository(path: string): Promise<RepositorySnapshot> {
  // Registration includes async canonicalization. Serialize it so simultaneous
  // choices of the same directory share one repository capability namespace.
  const registration = registrationQueue.then(async () => {
    const known = new Set(knownRepositories.keys());
    let snapshot = await git.registerRepository(path, { deferUntracked: true });
    const id = snapshot.repository.id;
    if (known.has(id) && ![...windows.values()].some(context => context.repository?.id === id)) {
      // A closed project may have changed on disk. Keep duplicate live windows
      // on their shared snapshot, but start a fresh tracked scan when reopening.
      snapshot = await git.refreshRepository(id, { deferUntracked: true });
      scanErrors.delete(id);
    }
    knownRepositories.set(id, snapshot.repository);
    return snapshot;
  });
  registrationQueue = registration.catch(() => {});
  return registration;
}
function refreshRepository(id: string): Promise<RepositorySnapshot> {
  const pending = backgroundScans.get(id);
  if (pending) return pending;
  const scan = git.refreshRepository(id);
  backgroundScans.set(id, scan);
  void scan.then(next => {
    scanErrors.delete(id);
    for (const context of windows.values()) {
      if (context.repository?.id !== id || context.window.isDestroyed()) continue;
      context.window.webContents.send('repository:snapshot', next);
    }
    updateWatchInterests(id);
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    scanErrors.set(id, message);
    for (const context of windows.values()) {
      if (context.repository?.id === id && !context.window.isDestroyed()) context.window.webContents.send('repository:scan-error', id, message);
    }
  }).finally(() => { if (backgroundScans.get(id) === scan) backgroundScans.delete(id); });
  return scan;
}
async function finishRepositoryScan(id: string) {
  const snapshot = await git.listChanges(id);
  if (snapshot.untrackedPending && !scanErrors.has(id)) await refreshRepository(id);
}
let sessionStore: RepositorySessionStore;
let restoring = true;
let quitting = false;
let quitFlushed = false;
const rendererDirectory = join(__dirname, 'renderer');
// A distinct web origin keeps the sandboxed renderer away from file:// privileges.
// No CSP bypass, service-worker privilege, or filesystem bridge is granted.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const devUrl = process.env.SMART_DIFF_DEV_URL || undefined;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) throw new Error('Invalid development server URL');
const rendererUrl = devUrl ?? 'app://smart-diff/index.html';
async function registerAssetProtocol() {
  const root = await realpath(rendererDirectory);
  const assets = new Map<string, string>();
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) assets.set('/' + relative(root, file).split('\\').join('/'), file);
      // Symbolic links are intentionally excluded from the bundled-asset allowlist.
    }
  }
  await collect(root);
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'smart-diff' || url.port || url.username || url.password || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Not found', { status: 404 }); }
    const asset = assets.get(pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    try {
      const canonical = await realpath(asset);
      const within = relative(root, canonical);
      if (canonical !== asset || within.startsWith('..') || isAbsolute(within)) return new Response('Not found', { status: 404 });
      return await net.fetch(pathToFileURL(canonical).href, { method: request.method });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
function assertSender(event: IpcMainInvokeEvent): WindowContext {
  const context = windows.get(event.sender.id);
  if (!context || context.window.isDestroyed() || event.sender !== context.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error('Untrusted IPC sender');
  return context;
}
function repositoryForSender(event: IpcMainInvokeEvent, value: unknown): string {
  const context = assertSender(event);
  const id = identifier(value, 'repository');
  if (context.repository?.id !== id) throw new Error('Repository does not belong to this window');
  return id;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function fileActionTarget(value: unknown): FileActionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value) || (value.kind !== 'project' && value.kind !== 'change') || !('id' in value)) throw new Error('Invalid file action target');
  return { kind: value.kind, id: identifier(value.id, 'file action target') };
}
function stopWatching(context: WindowContext) {
  context.watcher?.dispose();
  context.watcher = undefined;
  if (context.refreshTimer) clearTimeout(context.refreshTimer);
  context.refreshTimer = undefined;
}
function notify(id: string, repositoryChanged = true) {
  for (const context of windows.values()) {
    if (context.repository?.id !== id) continue;
    if (repositoryChanged) context.initialSnapshot = undefined;
    if (context.refreshTimer) clearTimeout(context.refreshTimer);
    context.refreshTimer = setTimeout(() => {
      context.refreshTimer = undefined;
      if (!context.window.isDestroyed()) context.window.webContents.send('repository:changed', id);
    }, 180);
  }
}
async function watchRepository(context: WindowContext) {
  const id = context.repository?.id;
  if (!id || context.window.isDestroyed()) return;
  context.watcher ??= new RepositoryWatcher(() => git.getRepositoryWatchState(id), () => notify(id));
  await context.watcher.check();
}
function updateWatchInterests(id: string) {
  for (const context of windows.values()) if (context.repository?.id === id) void context.watcher?.check();
}
function openRepositories(): Repository[] {
  return [...new Map([...windows.values()].flatMap(context => context.repository ? [[context.repository.id, { ...context.repository, displayPath: projectDisplayPath(context.repository.path) }] as const] : [])).values()];
}
function notifyOpenRepositories() {
  const repositories = openRepositories();
  for (const context of windows.values()) if (!context.window.isDestroyed()) context.window.webContents.send('repository:open-changed', repositories);
  rebuildApplicationMenu();
}
function focusedContext(): WindowContext | undefined {
  const window = BrowserWindow.getFocusedWindow();
  return window && !window.isDestroyed() ? windows.get(window.webContents.id) : undefined;
}
function dispatchApplicationAction(action: ApplicationActionId) {
  // Recheck at click time as the focused window may have changed while a menu
  // was open. Never send a stale menu command to a disabled renderer context.
  const context = focusedContext();
  if (context?.menuState[action]?.enabled && !context.window.webContents.isDestroyed()) context.window.webContents.send('application:action', action);
  // Electron toggles native checkboxes before invoking click. The renderer owns
  // their state, including idempotent commands that need not publish an update.
  const item = Menu.getApplicationMenu()?.getMenuItemById(action);
  if (item?.type === 'checkbox') item.checked = context?.menuState[action]?.checked === true;
}
function nativeMenuAction(action: () => void | Promise<unknown>) {
  void Promise.resolve().then(action).catch(error => {
    const options = { type: 'error' as const, title: 'unintellij', message: 'Unable to complete the action', detail: error instanceof Error ? error.message : String(error) };
    const context = focusedContext();
    void (context ? dialog.showMessageBox(context.window, options) : dialog.showMessageBox(options)).catch(failure => console.error('Unable to show menu error', failure));
  });
}
async function chooseRepository(context?: WindowContext): Promise<null> {
  const options = { title: 'Open project', properties: ['openDirectory' as const], buttonLabel: 'Open project' };
  const result = context && !context.window.isDestroyed() ? await dialog.showOpenDialog(context.window, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths[0]) await createWindow(result.filePaths[0]);
  // Choosing a local repository never replaces the originating workspace.
  return null;
}
function closeWelcomeWindows() {
  for (const context of windows.values()) {
    if (!context.project && !context.window.isDestroyed()) context.window.close();
  }
}
async function openRecentProject(value: unknown) {
  const id = identifier(value, 'recent project');
  const project = (await sessionStore.readRecent()).find(item => item.id === id);
  if (!project) throw new Error('Unknown recent project');
  const existing = [...windows.values()].find(context => context.project?.path === project.path && !context.window.isDestroyed());
  if (existing) {
    focusProject(existing.window.webContents.id);
    await sessionStore.remember(project.path).catch(error => console.error('Unable to save recent project', error));
    if (existing.repository) closeWelcomeWindows();
    return;
  }
  // Paths are resolved exclusively from the main-process history. Missing or
  // moved projects remain in history so opening one fails without erasing it.
  await createWindow(project.path);
}
function focusProject(windowId: number) {
  const context = windows.get(windowId);
  if (!context || context.window.isDestroyed()) return;
  if (context.window.isMinimized()) context.window.restore();
  context.window.focus();
  // Focusing the current project is idempotent and emits no focus event, but
  // Electron has still toggled the Open Projects checkbox before this callback.
  rebuildApplicationMenu();
}
function rebuildApplicationMenu() {
  const context = focusedContext();
  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate({
    platform: process.platform, appName: app.getName(), state: context?.menuState ?? {}, focusedWindowId: context?.window.webContents.id,
    projects: [...windows.values()].flatMap(entry => entry.project && !entry.window.isDestroyed() ? [{ windowId: entry.window.webContents.id, ...entry.project }] : []),
    dispatch: dispatchApplicationAction,
    open: () => nativeMenuAction(() => chooseRepository(focusedContext())),
    closeProject: () => nativeMenuAction(() => focusedContext()?.window.close()),
    focusProject: windowId => nativeMenuAction(() => focusProject(windowId)),
    showShortcuts: () => nativeMenuAction(async () => {
      const options = { type: 'info' as const, title: 'Keyboard Shortcuts', message: 'unintellij keyboard shortcuts', detail: applicationShortcutReference(process.platform), buttons: ['OK'] };
      const current = focusedContext();
      await (current ? dialog.showMessageBox(current.window, options) : dialog.showMessageBox(options));
    }),
  })));
}
function persistWindows() {
  if (restoring) return;
  const sessions = [...windows.values()].flatMap(context => context.project ? [{ id: context.sessionId, path: context.project.path }] : []);
  // Persistence failure must not destroy or replace a running workspace.
  void sessionStore.write(sessions).catch(error => console.error('Unable to save repository workspace', error));
}
function registerBridge() {
  ipcMain.handle('profiler:read', event => { assertSender(event); return profiler.readSnapshot(); });
  ipcMain.handle('profiler:history', event => { assertSender(event); return profiler.readHistory(); });
  ipcMain.handle('profiler:clear-history', event => { assertSender(event); profiler.clearHistory(); });
  ipcMain.handle('application:menu-state', (event, value: unknown) => {
    const context = assertSender(event);
    const next = validateApplicationMenuState(value);
    if (JSON.stringify(next) === JSON.stringify(context.menuState)) return;
    context.menuState = next;
    if (focusedContext() === context) rebuildApplicationMenu();
  });
  ipcMain.handle('application:native-edit', (event, action: unknown) => {
    const context = assertSender(event);
    if (action === 'undo') context.window.webContents.undo();
    else if (action === 'redo') context.window.webContents.redo();
    else throw new Error('Invalid native editing action');
  });
  ipcMain.handle('search:choose-directory', async (event, id: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    const context = assertSender(event);
    const result = await dialog.showOpenDialog(context.window, {
      title: 'Select search directory', defaultPath: git.getRepositoryRoot(repositoryId),
      properties: ['openDirectory'], buttonLabel: 'Search directory',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    repositoryForSender(event, repositoryId);
    return fileSearch.authorizeDirectory(String(context.window.webContents.id), repositoryId, result.filePaths[0]);
  });
  ipcMain.handle('search:start', (event, id: unknown, value: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid search request');
    const request = value as Partial<FileSearchRequest>;
    if (typeof request.query !== 'string' || request.query.length > 512 || request.query.includes('\0')) throw new Error('Invalid search text');
    const validated: FileSearchRequest = {
      requestId: identifier(request.requestId, 'search request'), query: request.query,
      ...(request.directoryId === undefined ? {} : { directoryId: identifier(request.directoryId, 'search directory') }),
    };
    const context = assertSender(event);
    return fileSearch.start(String(event.sender.id), repositoryId, validated, batch => {
      if (!context.window.isDestroyed() && context.repository?.id === repositoryId) context.window.webContents.send('search:batch', batch);
    });
  });
  ipcMain.handle('search:cancel', (event, id: unknown, requestId: unknown) => {
    repositoryForSender(event, id);
    fileSearch.cancel(String(event.sender.id), identifier(requestId, 'search request'));
  });
  ipcMain.handle('tree-actions:get', (event, id: unknown, target: unknown) => treeActions.getTreeActions(repositoryForSender(event, id), validateTreeActionTarget(target)));
  ipcMain.handle('tree-actions:perform', async (event, id: unknown, target: unknown, action: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    try { return await treeActions.performTreeAction(repositoryId, validateTreeActionTarget(target), validateTreeAction(action)); }
    finally { notify(repositoryId); updateWatchInterests(repositoryId); }
  });
  ipcMain.handle('file-actions:get', (event, id: unknown, target: unknown) => fileActions.getFileActions(repositoryForSender(event, id), fileActionTarget(target)));
  ipcMain.handle('file-actions:open', (event, id: unknown, target: unknown, applicationId: unknown) => fileActions.openFileIn(repositoryForSender(event, id), fileActionTarget(target), identifier(applicationId, 'application choice')));
  ipcMain.handle('file-actions:copy-path', (event, id: unknown, target: unknown, format: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (format !== 'absolute' && format !== 'relative') throw new Error('Invalid file path format');
    return fileActions.copyFilePath(repositoryId, validateTreeActionTarget(target), format);
  });
  ipcMain.handle('branches:list', (event, id: unknown) => branches.listBranches(repositoryForSender(event, id)));
  ipcMain.handle('branches:run', async (event, id: unknown, token: unknown, operation: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    try { return await branches.runBranchOperation(repositoryId, identifier(token, 'branch snapshot'), operation); }
    finally { notify(repositoryId); }
  });
  ipcMain.handle('branches:compare', (event, id: unknown, ref: unknown, target: unknown, swap: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (target !== 'head' && target !== 'working') throw new Error('Invalid comparison target');
    if (swap !== undefined && typeof swap !== 'boolean') throw new Error('Invalid comparison direction');
    return branches.compareBranches(repositoryId, identifier(ref, 'ref'), target, swap);
  });
  ipcMain.handle('branches:read', (event, id: unknown, comparison: unknown, change: unknown) => branches.readBranchComparison(repositoryForSender(event, id), identifier(comparison, 'comparison'), identifier(change, 'change')));
  ipcMain.handle('repository:choose', event => chooseRepository(assertSender(event)));
  ipcMain.handle('repository:create', async event => {
    const context = assertSender(event);
    const result = await dialog.showSaveDialog(context.window, {
      title: 'New Project', buttonLabel: 'Create Project', nameFieldLabel: 'Project name:',
      defaultPath: join(homedir(), 'untitled'), properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return;
    assertSender(event);
    await createWindow(await createProjectDirectory(result.filePath));
  });
  ipcMain.handle('repository:clone', async (event, value: unknown) => {
    const context = assertSender(event);
    const { url, name } = validateCloneUrl(value);
    if (context.cloneOperation) throw new Error('A repository clone is already in progress.');
    const controller = new AbortController();
    context.cloneOperation = controller;
    try {
      const result = await dialog.showSaveDialog(context.window, {
        title: 'Clone Repository', buttonLabel: 'Clone', nameFieldLabel: 'Directory name:',
        defaultPath: join(homedir(), name), properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return;
      assertSender(event);
      const path = await cloneProjectDirectory(url, result.filePath, controller.signal);
      assertSender(event);
      await createWindow(path);
    } finally { if (context.cloneOperation === controller) context.cloneOperation = undefined; }
  });
  ipcMain.handle('repository:recent', async event => {
    assertSender(event);
    return (await sessionStore.readRecent()).map(project => ({ ...project, displayPath: projectDisplayPath(project.path) }));
  });
  ipcMain.handle('repository:open-recent', (event, id: unknown) => { assertSender(event); return openRecentProject(id); });
  ipcMain.handle('workspace:session', event => assertSender(event).sessionId);
  ipcMain.handle('workspace:project', event => assertSender(event).project);
  ipcMain.handle('repository:last', async event => {
    const context = assertSender(event);
    await context.repositoryLoading;
    // A renderer may close or reload while the first repository scan is pending.
    assertSender(event);
    if (!context.repository) return null;
    const initial = context.initialSnapshot;
    context.initialSnapshot = undefined;
    // Registration already scanned this repository. Use the latest published
    // snapshot on first load, including a newer refresh from another window.
    // A later renderer load or observed mutation still requests a fresh scan.
    const snapshot = await (initial ? git.listChanges(context.repository.id) : refreshRepository(context.repository.id));
    if (!initial) void watchRepository(context).catch(error => console.error('Unable to watch repository', error));
    // Reply with usable tracked changes first. A later push supplies untracked
    // files directly without asking every renderer to repeat the full scan.
    if (snapshot.untrackedPending) setImmediate(() => {
      if (!context.window.isDestroyed()) void finishRepositoryScan(snapshot.repository.id).catch(() => {});
    });
    const untrackedError = snapshot.untrackedPending ? scanErrors.get(snapshot.repository.id) : undefined;
    return untrackedError ? { ...snapshot, untrackedPending: false, untrackedError } : snapshot;
  });
  ipcMain.handle('repository:open', event => { assertSender(event); return openRepositories(); });
  ipcMain.handle('repository:list', (event, id: unknown) => git.listChanges(repositoryForSender(event, id)));
  ipcMain.handle('repository:refresh', async (event, id: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    const snapshot = await refreshRepository(repositoryId);
    updateWatchInterests(repositoryId);
    return snapshot;
  });
  ipcMain.handle('repository:activate', async (event, id: unknown) => {
    assertSender(event);
    const repositoryId = identifier(id, 'repository');
    const existing = [...windows.values()].find(context => context.repository?.id === repositoryId);
    if (existing) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
    } else {
      // Only main-process-issued repository capabilities can open a window.
      const repository = knownRepositories.get(repositoryId);
      if (!repository) throw new Error('Unknown repository');
      const pending = [...windows.values()].find(context => context.project?.path === repository.path && !context.window.isDestroyed());
      if (pending) focusProject(pending.window.webContents.id);
      else await createWindow(repository.path);
    }
    return null;
  });
  ipcMain.handle('repository:read', async (event, id: unknown, changeId: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    try { return await git.readComparison(repositoryId, identifier(changeId, 'comparison')); }
    finally { updateWatchInterests(repositoryId); }
  });
  ipcMain.handle('project:preferences', (event, id: unknown) => git.getProjectTreePreferences(repositoryForSender(event, id)));
  ipcMain.handle('project:set-preferences', async (event, id: unknown, patch: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.entries(patch).some(([key, value]) => !Object.hasOwn(defaultTreePreferences, key) || typeof value !== 'boolean')) throw new Error('Invalid project tree preferences.');
    const result = await git.setProjectTreePreferences(repositoryId, patch as Partial<ProjectTreePreferences>);
    notify(repositoryId);
    return result;
  });
  ipcMain.handle('project:mark', async (event, id: unknown, directoryId: unknown, marking: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (marking !== null && (typeof marking !== 'string' || !['sources', 'test-sources', 'resources', 'test-resources', 'generated-sources', 'generated-test-sources', 'excluded', 'included', 'ordinary'].includes(marking))) throw new Error('Invalid directory marking.');
    await git.markProjectDirectory(repositoryId, directoryId === null ? null : identifier(directoryId, 'directory'), marking as DirectoryMarking | null);
    notify(repositoryId);
  });
  ipcMain.handle('project:list', async (event, id: unknown, directoryId: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    try { return await git.listProjectDirectory(repositoryId, directoryId === null ? null : identifier(directoryId, 'directory')); }
    finally { updateWatchInterests(repositoryId); }
  });
  ipcMain.handle('project:read', async (event, id: unknown, entryId: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    try { return await git.readProjectFile(repositoryId, identifier(entryId, 'file')); }
    finally { updateWatchInterests(repositoryId); }
  });
  ipcMain.handle('markdown:image', (event, id: unknown, entryId: unknown, href: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (typeof href !== 'string') throw new Error('Invalid Markdown image reference.');
    return git.readMarkdownImage(repositoryId, identifier(entryId, 'file'), href);
  });
  ipcMain.handle('markdown:resolve-link', async (event, id: unknown, entryId: unknown, href: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    if (typeof href !== 'string') throw new Error('Invalid Markdown link reference.');
    try { return await git.resolveMarkdownLink(repositoryId, identifier(entryId, 'file'), href); }
    finally { updateWatchInterests(repositoryId); }
  });
  ipcMain.handle('markdown:open-link', async (event, url: unknown) => {
    assertSender(event);
    await shell.openExternal(markdownExternalUrl(url));
  });
  ipcMain.handle('text:save', async (event, id: unknown, editId: unknown, version: unknown, text: unknown) => {
    const repositoryId = repositoryForSender(event, id);
    const edit = identifier(editId, 'edit capability');
    if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new Error('Invalid editing version');
    if (typeof text !== 'string' || text.length > git.maxFileBytes) throw new Error('Invalid or oversized text payload');
    const result = await git.saveText(repositoryId, edit, version, text);
    if (result.state === 'saved') notify(repositoryId);
    return result;
  });
}
async function createWindow(projectPath?: string, sessionId: string = randomUUID()) {
  const window = new BrowserWindow({
    ...(projectPath ? { width: 1380, height: 900, minWidth: 720, minHeight: 480 } : { width: 760, height: 520, minWidth: 560, minHeight: 400 }),
    show: false, backgroundColor: '#25272a', title: 'unintellij',
    // Keep native close/minimize/full-screen controls on the renderer's 42px
    // toolbar instead of adding a separate macOS title bar above it.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 14 },
      // Suppress macOS's native border highlight. The renderer stays opaque;
      // native rounded corners and traffic-light controls remain enabled.
      transparent: true,
    } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const context: WindowContext = { window, repository: null, project: projectPath ? { name: basename(projectPath) || projectPath, path: projectPath } : null, sessionId, menuState: {}, ready: false };
  let resolveRepository: (() => void) | undefined;
  let rejectRepository: ((error: unknown) => void) | undefined;
  if (projectPath) {
    context.repositoryLoading = new Promise<void>((resolve, reject) => { resolveRepository = resolve; rejectRepository = reject; });
    // The renderer may not have invoked repository:last before a failed load.
    void context.repositoryLoading.catch(() => {});
  }
  windows.set(window.webContents.id, context);
  const senderId = window.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Reloads replace the renderer and all of its search requests/scope handles.
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      context.cloneOperation?.abort();
      fileSearch.disposeOwner(String(senderId));
      context.menuState = {};
      rebuildApplicationMenu();
    }
  });
  window.webContents.on('render-process-gone', () => {
    context.cloneOperation?.abort();
    fileSearch.disposeOwner(String(senderId));
    context.menuState = {};
    rebuildApplicationMenu();
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  let initialFocus = true;
  window.on('focus', () => {
    rebuildApplicationMenu();
    // Showing a newly registered window must not immediately rescan its fresh
    // snapshot. Later focus events still check for changes made outside the app.
    if (initialFocus) { initialFocus = false; return; }
    if (context.repository) notify(context.repository.id, false);
  });
  window.on('blur', () => { setImmediate(rebuildApplicationMenu); });
  window.webContents.on('will-prevent-unload', () => {
    // A dirty editor can veto quitting; resume normal session bookkeeping.
    quitting = false;
    persistWindows();
  });
  window.on('closed', () => {
    context.cloneOperation?.abort();
    fileSearch.disposeOwner(String(senderId));
    windows.delete(senderId);
    stopWatching(context);
    context.initialSnapshot = undefined;
    releaseUnusedRepositories();
    notifyOpenRepositories();
    if (!quitting) persistWindows();
    // Closing the last project returns to the launcher. A failed/in-flight
    // project load must not create a second launcher alongside the existing one.
    if (context.project && context.ready && !quitting && !restoring && windows.size === 0) {
      void createWindow().catch(error => console.error('Unable to open welcome window', error));
    }
  });
  try {
    await window.loadURL(rendererUrl);
    if (window.isDestroyed()) { resolveRepository?.(); return window; }
    context.ready = true;
    window.show();
    notifyOpenRepositories();
    if (!quitting) persistWindows();
    // The renderer can paint a project shell before any Git scan or watcher
    // setup. repository:last waits on this window's initialization only.
    if (projectPath) {
      const snapshot = await registerRepository(projectPath);
      if (window.isDestroyed()) { resolveRepository?.(); return window; }
      context.repository = snapshot.repository;
      context.project = { name: snapshot.repository.name, path: snapshot.repository.path };
      context.initialSnapshot = snapshot;
      knownRepositories.set(snapshot.repository.id, snapshot.repository);
      resolveRepository?.();
      void watchRepository(context).catch(error => console.error('Unable to watch repository', error));
      await sessionStore.remember(snapshot.repository.path).catch(error => console.error('Unable to save recent project', error));
      if (window.isDestroyed()) return window;
      closeWelcomeWindows();
      notifyOpenRepositories();
      if (!quitting) persistWindows();
    }
    return window;
  } catch (error) {
    rejectRepository?.(error);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  } finally {
    // Includes windows closed while their initial registration was in flight.
    releaseUnusedRepositories();
  }
}
app.whenReady().then(async () => {
  // Start before restoring projects/creating renderers, independently of Settings.
  profiler.start();
  if (!devUrl) await registerAssetProtocol();
  sessionStore = new RepositorySessionStore(app.getPath('userData'));
  // Migrate trusted prior workspace paths before failed restores can remove
  // them from the next live-session snapshot.
  await sessionStore.readRecent().catch(error => console.error('Unable to read recent projects', error));
  registerBridge();
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.isPackaged ? app.getVersion() : developmentVersion, version: '' });
  rebuildApplicationMenu();
  await Promise.all((await sessionStore.read()).map(async session => {
    try { await createWindow(session.path, session.id); }
    catch (error) { console.error('Unable to restore repository window', error); }
  }));
  if (windows.size === 0) await createWindow();
  restoring = false;
  persistWindows();
  app.on('activate', () => { if (windows.size === 0) void createWindow(); });
});
app.on('before-quit', () => {
  if (quitFlushed || quitting) return;
  quitting = true;
  // Capture before closed events remove windows. Normal closes still remove
  // their repositories; quitting remembers the set that was open at exit.
  persistWindows();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// Unsaved editor buffers can veto closing. Keep services alive until quit is final.
app.on('will-quit', event => {
  if (!quitFlushed) {
    event.preventDefault();
    void (sessionStore?.flush() ?? Promise.resolve()).catch(error => console.error('Unable to flush repository workspace', error)).finally(() => {
      quitFlushed = true;
      app.quit();
    });
    return;
  }
  for (const context of windows.values()) stopWatching(context);
  fileActions.dispose();
  branches.dispose();
  git.dispose();
});
