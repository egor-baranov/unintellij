import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { WelcomeScreen } from './WelcomeScreen';
import type { SmartDiff } from 'monaco-smart-diff';
import type { editor } from 'monaco-editor';
import type { FileActionTarget, FileComparison, GitChange, ProjectEntry, ProjectFile, RepositorySnapshot, TreeAction, TreeActionTarget, TreeActionsInfo, WindowProject } from './bridge';
import { CommitPanel } from '../../shared/commit/CommitPanel';
import type { CommitSubmission } from '../../shared/commit/options';
import { ProjectPanel } from '../../shared/project/ProjectPanel';
import { defaultTreePreferences } from '../../shared/project/semantics';
import { WorkspaceSwitch } from '../../shared/project/WorkspaceSwitch';
import { ProjectPicker, type PickerProject } from '../../shared/ProjectPicker';
import { CloneProjectDialog } from './CloneProjectDialog';
import { TabContent } from '../../shared/workspace/TabContent';
import { EditorWorkspace, useEditorWorkspace, type WorkspaceDocument, type WorkspaceTab } from '../../shared/workspace';
import { UiIcon } from '../../shared/ui';
import { BranchSelector } from '../../shared/branches/BranchSelector';
import { BranchComparisonPanel } from '../../shared/branches/BranchComparisonPanel';
import { SettingsButton } from '../../shared/settings/SettingsButton';
import { FindInFilesDialog, FindInFilesView } from '../../shared/search/FindInFilesDialog';
import type { FileSearchResult } from '../../shared/search/types';
import type { BranchComparison } from '../../shared/branches/types';
import { defaultPreferences, type ViewerPreferences } from '../../shared/DiffSurface';
import '../../shared/app.css';
import './style.css';
import { dirtyKeys, editingKey, getBuffer, subscribeEditing } from '../../shared/editing/store';
import { EditingGuard } from '../../shared/editing/UnsavedDialog';
import { FileActionsProvider, type FileActionItem } from '../../shared/files/FileActions';
import { RepositoryRefresh, StaleReadRecovery } from './refresh';
import { initialTabContent, PendingComparisonReads, PendingTabRead, verifiedComparisonContent } from './tab-read';
import { readWorkspaceSession, resolveProjectPaths, restoreWorkspace, saveWorkspaceSession } from './workspace-session';
import { captureWorkspaceViews, restoreWorkspaceViews, subscribeWorkspaceViews } from '../../shared/workspace/viewState';
import { treeActionNeedsSavedPath } from './tree-action-state';
import { ApplicationMenu } from './ApplicationMenu';
import { useApplicationActions } from '../../shared/actions/renderer';
import { TreeActionDialog, type DialogTreeAction } from '../../shared/files/TreeActionDialog';
import { TabContentCache } from './content-cache';

const keyFor = (change: GitChange) => `${change.group}:${change.path}`;
const noChanges: GitChange[] = [];
const changesFor = (snapshot: RepositorySnapshot | null): GitChange[] => snapshot?.workingChanges ?? snapshot?.changes ?? noChanges;
const cachedContents = new TabContentCache(content => {
  const buffer = getBuffer(editingKey(content.repositoryId, content.path));
  return !!buffer?.dirty || !!buffer?.saving;
});
// Draft protection can end after an inactive tab finishes auto-saving/discarding.
// Reapply the byte budget then instead of retaining an old, large comparison.
const stopCachePruning = subscribeEditing(() => {
  // A save can finish on an inactive tab before the repository's next snapshot.
  // Never reopen its old modified text after releasing the newly clean buffer.
  cachedContents.invalidate(content => {
    const buffer = getBuffer(editingKey(content.repositoryId, content.path));
    const side = 'changeId' in content ? content.modified : content.content;
    return !!side?.editable && !!buffer && !buffer.dirty && !buffer.saving
      && side.editable.version !== buffer.source.editable?.version;
  });
  cachedContents.prune();
});
if (import.meta.hot) import.meta.hot.dispose(stopCachePruning);
const comparisonReads = new PendingComparisonReads();
type WorkspaceMode = 'project' | 'commit';
interface FileOpenRequest { token: number; repositoryId: string; result: FileSearchResult }

function loadPreferences(): ViewerPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('smart-diff:preferences') ?? '{}') as Record<string, unknown>;
    return { layout: value.layout === 'aligned' ? 'aligned' : 'compact', sync: typeof value.sync === 'boolean' ? value.sync : true, collapse: typeof value.collapse === 'boolean' ? value.collapse : true, whitespace: value.whitespace === true, wrap: value.wrap === true, splitRatio: typeof value.splitRatio === 'number' && Number.isFinite(value.splitRatio) ? Math.max(0.1, Math.min(0.9, value.splitRatio)) : 0.5 };
  } catch { return defaultPreferences; }
}
function loadSidebarWidth() {
  const saved = Number(localStorage.getItem('smart-diff:sidebar-width'));
  return Number.isFinite(saved) && saved >= 280 ? Math.min(560, saved) : 340;
}
function comparisonDocument(repositoryId: string, change: GitChange): WorkspaceDocument {
  return { id: JSON.stringify([repositoryId, 'comparison', change.path]), path: change.path, kind: 'comparison', comparisonGroup: change.group, editKey: change.group !== 'staged' ? editingKey(repositoryId, change.path) : undefined, description: `${change.group}${change.oldPath ? ` ← ${change.oldPath}` : ''}` };
}
function fileDocument(repositoryId: string, entry: Pick<ProjectEntry, 'path'>): WorkspaceDocument {
  return { id: JSON.stringify([repositoryId, 'file', entry.path]), path: entry.path, kind: 'file', editKey: editingKey(repositoryId, entry.path), description: 'Working tree' };
}
function comparisonForTab(snapshot: RepositorySnapshot, tab: WorkspaceTab): GitChange | undefined {
  return changesFor(snapshot).find(change => comparisonDocument(snapshot.repository.id, change).id === tab.id);
}

function App() {
  const [initialized, setInitialized] = useState(false);
  const [loadingProject, setLoadingProject] = useState<WindowProject | null>(null);
  const [windowSessionId, setWindowSessionId] = useState<string>();
  const windowSession = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<WorkspaceMode>(() => localStorage.getItem('smart-diff:workspace') === 'project' ? 'project' : 'commit');
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [openProjects, setOpenProjects] = useState<PickerProject[]>([]);
  const [recentProjects, setRecentProjects] = useState<PickerProject[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const recentRequest = useRef(0);
  const loadRecentProjects = useCallback(() => {
    const request = ++recentRequest.current;
    void window.desktop.listRecentProjects().then(projects => {
      if (request === recentRequest.current) setRecentProjects(projects);
    }).catch(cause => { if (request === recentRequest.current) setError(String(cause)); });
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchComparison, setBranchComparison] = useState<BranchComparison | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fileOpenRequest, setFileOpenRequest] = useState<FileOpenRequest>();
  const fileOpenSequence = useRef(0);
  const consumeFileOpen = useCallback((token: number) => setFileOpenRequest(current => current?.token === token ? undefined : current), []);
  const openSearchResult = (result: FileSearchResult) => {
    if (!snapshot) return;
    setSearchOpen(false); setBranchComparison(null); setMode('project');
    setFileOpenRequest({ token: ++fileOpenSequence.current, repositoryId: snapshot.repository.id, result });
  };
  const [commitRequest, setCommitRequest] = useState<CommitSubmission & { id: number; repositoryId: string }>();
  const requestCommit = useCallback((submission: CommitSubmission) => {
    if (!snapshot) return;
    const unsaved = changesFor(snapshot).find(change => {
      if (change.group === 'staged' || !submission.changeIds.includes(change.id)) return false;
      const buffer = getBuffer(editingKey(snapshot.repository.id, change.path));
      return buffer?.dirty || buffer?.saving;
    });
    if (unsaved) { setError(`Save ${unsaved.path} before committing its working copy.`); return; }
    setError(null);
    setCommitRequest(previous => ({ ...submission, id: (previous?.id ?? 0) + 1, repositoryId: snapshot.repository.id }));
  }, [snapshot]);
  const [preferences, setPreferences] = useState(loadPreferences);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarVisible, setSidebarVisible] = useState(() => localStorage.getItem('smart-diff:sidebar-visible') !== 'false');
  const repositoryRequest = useRef(0);
  const currentRepository = useRef<string | undefined>(undefined);
  const refreshQueue = useRef<RepositoryRefresh<RepositorySnapshot> | null>(null);
  const acceptSnapshot = useCallback((next: RepositorySnapshot) => {
    if (currentRepository.current !== next.repository.id) {
      currentRepository.current = next.repository.id;
      setCommitRequest(undefined); setBranchComparison(null);
      const saved = windowSession.current ? readWorkspaceSession(next.repository.path, windowSession.current) : undefined;
      if (saved) { setMode(saved.chrome.mode); setSidebarVisible(saved.chrome.sidebarVisible); setSidebarWidth(saved.chrome.sidebarWidth); }
    }
    refreshQueue.current?.setRepository(next.repository.id);
    setError(null);
    // An operation may still be resolving renamed editor paths when a watcher
    // delivers a newer snapshot. Never roll that repository back afterwards.
    setSnapshot(current => current?.repository.id === next.repository.id && current.generation > next.generation ? current : next);
  }, []);
  if (!refreshQueue.current) refreshQueue.current = new RepositoryRefresh({
    load: id => window.desktop.refreshRepository(id), accept: acceptSnapshot, busy: setBusy,
    error: cause => setError(cause instanceof Error ? cause.message : String(cause)),
  });
  const fetchRepository = useCallback(async (operation: () => Promise<RepositorySnapshot | null>, refreshAfter = true) => {
    const generation = ++repositoryRequest.current;
    // Repository selection owns this session until the dialog/activation finishes.
    // An older background response cannot switch us back to the previous project.
    refreshQueue.current?.setRepository();
    setBusy(true); setError(null);
    try { const next = await operation(); if (generation === repositoryRequest.current && next) acceptSnapshot(next); }
    catch (cause) { if (generation === repositoryRequest.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      if (generation === repositoryRequest.current) {
        setBusy(false);
        refreshQueue.current?.setRepository(currentRepository.current);
        // Also catch writes made while the native repository chooser was open.
        if (refreshAfter) refreshQueue.current?.request();
      }
    }
  }, [acceptSnapshot]);
  const refresh = useCallback(() => { refreshQueue.current?.request(); }, []);
  const openRepository = useCallback(() => { void fetchRepository(() => window.desktop.chooseRepository()); }, [fetchRepository]);
  const createProject = useCallback(() => {
    void fetchRepository(async () => { await window.desktop.createProject(); return null; }, false);
  }, [fetchRepository]);
  const openRecentProject = useCallback((id: string) => {
    void fetchRepository(async () => { await window.desktop.openRecentProject(id); return null; });
  }, [fetchRepository]);
  useApplicationActions({
    'file.refresh': { enabled: !!snapshot && !busy, run: refresh },
    'edit.findInFiles': { enabled: !!snapshot, run: () => setSearchOpen(true) },
    'view.project': { enabled: !!snapshot, checked: sidebarVisible && !branchComparison && mode === 'project', run: () => { setSidebarVisible(true); setBranchComparison(null); setMode('project'); } },
    'view.commit': { enabled: !!snapshot, checked: sidebarVisible && !branchComparison && mode === 'commit', run: () => { setSidebarVisible(true); setBranchComparison(null); setMode('commit'); } },
    'view.sidebar': { enabled: !!snapshot && !branchComparison, checked: sidebarVisible && !branchComparison, run: () => setSidebarVisible(value => !value) },
  });
  useEffect(() => {
    let live = true;
    // The window knows its selected directory before the initial Git snapshot
    // is ready. Show that project immediately without restoring tabs against
    // an incomplete snapshot or presenting the launcher in a project window.
    void window.desktop.getWindowProject?.().then(project => { if (live) setLoadingProject(project); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => { void fetchRepository(async () => {
    const id = await window.desktop.getWindowSessionId();
    windowSession.current = id; setWindowSessionId(id);
    return window.desktop.getLastRepository();
  }, false).finally(() => setInitialized(true)); }, [fetchRepository]);
  useEffect(() => {
    let live = true, changed = false;
    const unsubscribe = window.desktop.subscribeToOpenRepositories(repositories => { changed = true; if (live) { setOpenProjects(repositories); loadRecentProjects(); } });
    void window.desktop.listOpenRepositories().then(repositories => { if (live && !changed) setOpenProjects(repositories); }).catch(() => {});
    loadRecentProjects();
    return () => { live = false; recentRequest.current++; unsubscribe(); };
  }, [loadRecentProjects]);
  useEffect(() => {
    const unsubscribe = window.desktop.subscribeToRepositoryChanges(id => refreshQueue.current?.request(id));
    return () => { unsubscribe(); refreshQueue.current?.setRepository(); repositoryRequest.current++; };
  }, []);
  useEffect(() => {
    // Initial discovery pushes its completed snapshot; requesting another scan
    // here would traverse large unversioned directories a second time.
    const unsubscribe = window.desktop.subscribeToRepositorySnapshots?.(next => {
      if (next.repository.id === currentRepository.current) acceptSnapshot(next);
    });
    const unsubscribeError = window.desktop.subscribeToRepositoryScanErrors?.((id, message) => {
      if (id !== currentRepository.current) return;
      setError(message);
      setSnapshot(current => current?.repository.id === id ? { ...current, untrackedPending: false, untrackedError: message } : current);
    });
    return () => { unsubscribe?.(); unsubscribeError?.(); };
  }, [acceptSnapshot]);
  useEffect(() => { localStorage.setItem('smart-diff:preferences', JSON.stringify(preferences)); }, [preferences]);
  useEffect(() => { localStorage.setItem('smart-diff:sidebar-width', String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem('smart-diff:sidebar-visible', String(sidebarVisible)); }, [sidebarVisible]);
  useEffect(() => { localStorage.setItem('smart-diff:workspace', mode); }, [mode]);
  useEffect(() => { setBranchComparison(null); setSearchOpen(false); setFileOpenRequest(undefined); }, [snapshot?.repository.id]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      const modifier = document.documentElement.dataset.windowChrome === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!snapshot || event.defaultPrevented || event.isComposing || !modifier || !event.shiftKey || event.altKey || event.code !== 'KeyF') return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      setSearchOpen(true);
    };
    // Capture before Monaco consumes the chord; ordinary Mod+F is untouched.
    window.addEventListener('keydown', find, true);
    return () => window.removeEventListener('keydown', find, true);
  }, [snapshot?.repository.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog')) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); refresh(); }
      if (event.key.toLowerCase() === 'b') { event.preventDefault(); event.stopPropagation(); setSidebarVisible(value => !value); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [refresh]);
  if (!initialized) return loadingProject ? <div className="application project-loading-screen" aria-label={`Opening ${loadingProject.name}`}>
    <ApplicationMenu onError={setError} />
    <header className="topbar desktop-topbar"><UiIcon name="project" /><strong className="project-loading-name" title={loadingProject.path}>{loadingProject.name}</strong><span className="topbar-spacer" /><SettingsButton /></header>
    <div role="status"><StatePanel title={`Opening ${loadingProject.name}…`} text={loadingProject.path} /></div>
  </div> : <div className="application startup-screen" role="status">Opening unintellij…</div>;
  if (!snapshot) return <>
    <ApplicationMenu onError={setError} />
    <WelcomeScreen busy={busy} error={error} onOpen={openRepository} onRecent={openRecentProject} onDismissError={() => setError(null)}
      onCreate={typeof window.desktop.createProject === 'function' ? createProject : undefined}
      onClone={typeof window.desktop.cloneProject === 'function' ? () => setCloneOpen(true) : undefined} />
    {cloneOpen && <CloneProjectDialog onClose={() => setCloneOpen(false)} onClone={url => window.desktop.cloneProject(url)} />}
  </>;
  return <div className="application">
    <ApplicationMenu repositoryId={snapshot?.repository.id} onError={setError} />
    <EditingGuard />
    <header className="topbar desktop-topbar">
      <WorkspaceSwitch value={sidebarVisible && !branchComparison ? mode : null} onChange={value => {
        setSidebarVisible(!sidebarVisible || !!branchComparison || value !== mode); setBranchComparison(null); setMode(value);
      }} /><span className="toolbar-divider" />
      <ProjectPicker project={snapshot.repository} projects={openProjects} recentProjects={recentProjects}
        onCreate={typeof window.desktop.createProject === 'function' ? createProject : undefined} onOpen={openRepository}
        onClone={typeof window.desktop.cloneProject === 'function' ? () => setCloneOpen(true) : undefined}
        onSelect={id => void fetchRepository(() => window.desktop.activateRepository(id), false)} onSelectRecent={openRecentProject}
        onOpenChange={open => { if (open) loadRecentProjects(); }} />
      {snapshot && snapshot.repository.gitAvailable !== false && <BranchSelector key={snapshot.repository.id} repository={snapshot.repository} client={window.desktop} refreshToken={snapshot.generation} commitRequest={commitRequest?.repositoryId === snapshot.repository.id ? commitRequest : undefined}
        onRepositoryChanged={refresh} onCompare={setBranchComparison} onCommit={() => { setMode('commit'); setSidebarVisible(true); setBranchComparison(null); }} />}
      <span className="topbar-spacer" />
      <button className="ui-toolbar-icon" aria-label="Find in Files" title="Find in Files (⌘/Ctrl+Shift+F)" aria-haspopup="dialog" aria-expanded={searchOpen}
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F" disabled={!snapshot} onClick={() => setSearchOpen(true)}><UiIcon name="search" /></button>
      <SettingsButton />
    </header>
    {cloneOpen && <CloneProjectDialog onClose={() => setCloneOpen(false)} onClone={url => window.desktop.cloneProject(url)} />}
    {error && <div className="notice" role="alert"><span>{error}</span><button className="chrome-icon-button" onClick={() => setError(null)} aria-label="Dismiss error"><UiIcon name="close" /></button>{snapshot && <button onClick={refresh}>Refresh</button>}</div>}
    {branchComparison && <BranchComparisonPanel key={branchComparison.repositoryId} comparison={branchComparison} client={window.desktop} preferences={preferences} onPreferences={setPreferences} onReplace={setBranchComparison} onClose={() => setBranchComparison(null)} refreshToken={snapshot?.generation} />}
    <div className={branchComparison ? 'branch-workspace-hidden' : 'desktop-workspace-host'}><DesktopWorkspace key={snapshot?.repository.id ?? 'no-repository'} snapshot={snapshot} mode={mode} onModeChange={setMode} busy={busy}
      preferences={preferences} onPreferences={setPreferences} refresh={refresh} onSnapshot={acceptSnapshot} openRepository={openRepository} onCommitRequest={requestCommit}
      sidebarVisible={sidebarVisible} sidebarWidth={sidebarWidth} onSidebarWidth={setSidebarWidth} windowSessionId={windowSessionId}
      fileOpenRequest={fileOpenRequest} onFileOpened={consumeFileOpen} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery}
      onOpenSearchResult={openSearchResult} searchActive={!searchOpen && !branchComparison} /></div>
    {searchOpen && snapshot && <FindInFilesDialog key={snapshot.repository.id} repository={snapshot.repository} client={window.desktop}
      initialQuery={searchQuery} onQueryChange={setSearchQuery} onClose={() => setSearchOpen(false)} onOpenResult={openSearchResult} />}
  </div>;
}

/** Repository identity is the React key: capabilities and pending tab loads never cross projects. */
function DesktopWorkspace({ snapshot, mode, onModeChange, busy, preferences, onPreferences, refresh, onSnapshot, openRepository, sidebarVisible, sidebarWidth, onSidebarWidth, onCommitRequest, windowSessionId, fileOpenRequest, onFileOpened, searchQuery, onSearchQueryChange, onOpenSearchResult, searchActive }: {
  snapshot: RepositorySnapshot | null; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; busy: boolean;
  preferences: ViewerPreferences; onPreferences: (value: ViewerPreferences) => void; refresh: () => void; openRepository: () => void;
  onSnapshot: (snapshot: RepositorySnapshot) => void;
  sidebarVisible: boolean; sidebarWidth: number; onSidebarWidth: (value: number) => void;
  onCommitRequest: (submission: CommitSubmission) => void;
  windowSessionId?: string;
  fileOpenRequest?: FileOpenRequest;
  onFileOpened: (token: number) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenSearchResult: (result: FileSearchResult) => void;
  searchActive: boolean;
}) {
  const firstChange = changesFor(snapshot)[0];
  const initialDocument = snapshot && firstChange ? comparisonDocument(snapshot.repository.id, firstChange) : undefined;
  const [savedSession] = useState(() => snapshot && windowSessionId ? readWorkspaceSession(snapshot.repository.path, windowSessionId) : undefined);
  const [restoredWorkspace] = useState(() => {
    if (!savedSession || !snapshot) return;
    restoreWorkspaceViews(savedSession.views);
    return restoreWorkspace(savedSession, tab => tab.kind === 'file' ? fileDocument(snapshot.repository.id, tab) : comparisonDocument(snapshot.repository.id,
      changesFor(snapshot).find(change => change.path === tab.path) ?? { id: '', path: tab.path, group: tab.comparisonGroup ?? 'working', status: 'M' }));
  });
  const workspace = useEditorWorkspace(mode === 'commit' && initialDocument ? [initialDocument] : [], restoredWorkspace);
  const [selection, setSelection] = useState<string | null>(firstChange ? keyFor(firstChange) : null);
  const [projectSelection, setProjectSelection] = useState<ProjectEntry | null>(null);
  const [treePreferences, setTreePreferences] = useState(defaultTreePreferences);
  const [treeMenuTarget, setTreeMenuTarget] = useState<FileActionItem>();
  const [menuTreeAction, setMenuTreeAction] = useState<{ item: FileActionItem; info: TreeActionsInfo; kind: DialogTreeAction }>();
  const [menuActionBusy, setMenuActionBusy] = useState(false);
  const menuRequestPending = useRef(false);
  const menuActionCompleted = useRef(false);
  const editorWorkspaceElement = useRef<HTMLDivElement>(null);
  const projectEntries = useRef(new Map<string, ProjectEntry>());
  const [projectRevision, setProjectRevision] = useState(0);
  const [resolvingPaths, setResolvingPaths] = useState(() => new Set(restoredWorkspace?.groups.flatMap(group => group.tabs.filter(tab => tab.kind === 'file').map(tab => tab.path))));
  const lastComparison = useRef<WorkspaceDocument | undefined>(initialDocument);
  const lastProject = useRef<WorkspaceDocument | undefined>(undefined);
  const previousMode = useRef(mode);
  const viewers = useRef(new Map<string, SmartDiff>());
  const repositoryId = snapshot?.repository.id;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const activeGroup = workspace.state.groups.find(group => group.id === workspace.state.activeGroupId);
  const activeTab = activeGroup?.tabs.find(tab => tab.id === activeGroup.activeId);
  const activeInstance = useRef(activeTab?.instanceId); activeInstance.current = activeTab?.instanceId;
  const selected = changesFor(snapshot).find(change => keyFor(change) === selection);
  const registerViewer = useCallback((instanceId: string, value: SmartDiff | null) => {
    if (value) viewers.current.set(instanceId, value); else viewers.current.delete(instanceId);
  }, []);
  const loadDirectory = useCallback((id: string | null) => repositoryId ? window.desktop.listProjectDirectory(repositoryId, id) : Promise.reject(new Error('Open a repository to browse its files.')), [repositoryId]);
  const sessionState = useRef({ state: workspace.state, chrome: { mode, sidebarVisible, sidebarWidth } });
  sessionState.current = { state: workspace.state, chrome: { mode, sidebarVisible, sidebarWidth } };
  const persistSession = useCallback(() => {
    if (!snapshot || !windowSessionId) return;
    const { state, chrome } = sessionState.current;
    saveWorkspaceSession(snapshot.repository.path, windowSessionId, state,
      captureWorkspaceViews(state.groups.flatMap(group => group.tabs.map(tab => tab.instanceId))), chrome);
  }, [snapshot?.repository.path, windowSessionId]);
  useEffect(() => {
    const timer = window.setTimeout(persistSession, 180);
    return () => clearTimeout(timer);
  }, [workspace.state, mode, sidebarVisible, sidebarWidth, persistSession]);
  useEffect(() => {
    const unsubscribe = subscribeWorkspaceViews(persistSession);
    // Capture live Monaco handles before reload/close, without waiting for React unmount.
    window.addEventListener('beforeunload', persistSession);
    window.addEventListener('pagehide', persistSession);
    return () => { persistSession(); unsubscribe(); window.removeEventListener('beforeunload', persistSession); window.removeEventListener('pagehide', persistSession); };
  }, [persistSession]);
  useEffect(() => {
    if (!repositoryId) return;
    const missing = [...new Set(workspace.state.groups.flatMap(group => group.tabs.filter(tab => tab.kind === 'file' && !projectEntries.current.has(tab.id)).map(tab => tab.path)))];
    if (!missing.length) return;
    let cancelled = false;
    setResolvingPaths(new Set(missing));
    void resolveProjectPaths(missing, loadDirectory).then(entries => {
      if (cancelled) return;
      for (const entry of entries.values()) projectEntries.current.set(fileDocument(repositoryId, entry).id, entry);
      setProjectRevision(value => value + 1); setResolvingPaths(new Set());
    });
    return () => { cancelled = true; };
  }, [repositoryId, snapshot?.generation, workspace.state.groups, loadDirectory]);
  const selectChange = useCallback((id: string) => {
    const change = changesFor(snapshot).find(item => item.id === id);
    if (!snapshot || !change) return;
    const document = comparisonDocument(snapshot.repository.id, change);
    setSelection(keyFor(change)); lastComparison.current = document; workspace.open(document);
  }, [snapshot, workspace.open]);
  const selectProject = useCallback((entry: ProjectEntry) => {
    if (!repositoryId || entry.kind === 'directory') return;
    const document = fileDocument(repositoryId, entry);
    projectEntries.current.set(document.id, entry);
    setProjectSelection(entry); lastProject.current = document; workspace.open(document);
  }, [repositoryId, workspace.open]);
  useEffect(() => {
    if (fileOpenRequest && fileOpenRequest.repositoryId === repositoryId) selectProject(fileOpenRequest.result.entry);
  }, [fileOpenRequest, repositoryId, selectProject]);
  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    const remembered = mode === 'project' ? lastProject.current : lastComparison.current;
    if (remembered) workspace.open(remembered);
  }, [mode, workspace.open]);
  useEffect(() => {
    if (!snapshot) return;
    // Rename and index actions can move a comparison between tracked and
    // untracked groups. A watcher may deliver that fact after tabs are remapped.
    const replacements = [...new Map(workspace.state.groups.flatMap(group => group.tabs).map(tab => [tab.id, tab])).values()].flatMap(tab => {
      if (tab.kind !== 'comparison') return [];
      const change = comparisonForTab(snapshot, tab);
      if (!change) return [];
      const document = comparisonDocument(snapshot.repository.id, change);
      return document.comparisonGroup !== tab.comparisonGroup || document.description !== tab.description || document.editKey !== tab.editKey
        ? [{ id: tab.id, document }] : [];
    });
    if (replacements.length) workspace.replaceDocuments(replacements);
  }, [snapshot, workspace.state.groups, workspace.replaceDocuments]);
  useEffect(() => {
    if (!activeTab || !snapshot) return;
    if (activeTab.kind === 'comparison') {
      const change = comparisonForTab(snapshot, activeTab);
      if (change) setSelection(keyFor(change));
      lastComparison.current = activeTab;
    } else {
      const entry = projectEntries.current.get(activeTab.id);
      if (entry) setProjectSelection(entry);
      lastProject.current = activeTab;
    }
  }, [activeTab, snapshot, projectRevision]);
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog')) return;
      const instance = activeInstance.current ? viewers.current.get(activeInstance.current) : undefined;
      if (!instance || !event.altKey || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') instance.nextChange(); else instance.previousChange();
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, []);
  const emptyState = !snapshot ? <StatePanel title="Review your local changes" text="Open a Git repository to browse files and compare local changes." action={<button disabled={busy} onClick={openRepository}>Open repository…</button>} />
    : <FindInFilesView repository={snapshot.repository} client={window.desktop} initialQuery={searchQuery}
      onQueryChange={onSearchQueryChange} onOpenResult={onOpenSearchResult} active={searchActive} />;
  function actionTarget(item: FileActionItem): FileActionTarget {
    if (item.kind === 'comparison' && snapshot) {
      const change = changesFor(snapshot).find(change => item.changeId ? change.id === item.changeId : comparisonDocument(snapshot.repository.id, change).id === item.documentId);
      if (change) return { kind: 'change', id: change.id };
    } else {
      const id = item.entryId ?? (item.documentId ? projectEntries.current.get(item.documentId)?.id : undefined);
      if (id) return { kind: 'project', id };
    }
    throw new Error('This file is no longer available. Refresh the repository and try again.');
  }
  function treeActionTarget(item: FileActionItem): TreeActionTarget {
    if (item.kind === 'change-group') return { kind: 'change-group', changeIds: item.changeIds ?? [] };
    if (item.kind === 'directory') {
      if (item.entryId !== undefined) return { kind: 'project', id: item.entryId };
      if (item.changeId) return { kind: 'change-directory', changeId: item.changeId, path: item.path };
    }
    return actionTarget(item);
  }
  async function performTreeAction(item: FileActionItem, action: TreeAction) {
    if (!repositoryId) throw new Error('Open a repository first.');
    const target = treeActionTarget(item);
    const unsaved = dirtyKeys().map(getBuffer).find(buffer => buffer?.repositoryId === repositoryId && treeActionNeedsSavedPath(item, action, buffer.path));
    if (unsaved) throw new Error(`Save ${unsaved.path} first, then ${action.kind === 'add' ? 'add it to Git' : action.kind === 'rename' ? 'rename it' : 'create the item'}.`);
    const result = await window.desktop.performTreeAction(repositoryId, target, action);
    if (!alive.current) return;
    if (result.entry && action.kind === 'rename') {
      const entry = result.entry;
      setTreeMenuTarget(current => current?.path === item.path ? { kind: entry.kind === 'directory' ? 'directory' : 'file', path: entry.path, entryId: entry.id } : current);
    }
    const next = await window.desktop.listChanges(repositoryId);
    if (!alive.current) return;
    if (result.remap) {
      const { from, to, directory } = result.remap;
      const remapPath = (path: string) => path === from || directory && path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
      const remapDocument = (document: WorkspaceDocument): WorkspaceDocument => {
        const path = remapPath(document.path);
        if (path === document.path) return document;
        if (document.kind === 'file') return fileDocument(repositoryId, { path });
        const change = changesFor(next).find(change => change.path === path);
        return comparisonDocument(repositoryId, change ?? { id: '', path, group: document.comparisonGroup ?? 'working', status: 'M' });
      };
      // Reissue path capabilities before remounting editors at their new location.
      // The tab instance remains stable so scroll/fold/cursor state survives.
      const documents = [...new Map(sessionState.current.state.groups.flatMap(group => group.tabs).map(tab => [tab.id, tab])).values()];
      const replacements = documents.filter(document => remapPath(document.path) !== document.path).map(document => ({ id: document.id, document: remapDocument(document) }));
      const entries = await resolveProjectPaths(replacements.filter(item => item.document.kind === 'file').map(item => item.document.path), loadDirectory);
      if (!alive.current) return;
      for (const [id, entry] of projectEntries.current) if (remapPath(entry.path) !== entry.path) projectEntries.current.delete(id);
      for (const entry of entries.values()) projectEntries.current.set(fileDocument(repositoryId, entry).id, entry);
      for (const { id, document } of replacements) { cachedContents.delete(id); cachedContents.delete(document.id); }
      if (lastProject.current) lastProject.current = remapDocument(lastProject.current);
      if (lastComparison.current) lastComparison.current = remapDocument(lastComparison.current);
      setProjectSelection(current => {
        if (!current || remapPath(current.path) === current.path) return current;
        const path = remapPath(current.path);
        return entries.get(path) ?? (result.entry?.path === path ? result.entry : { ...current, path, name: path.split('/').at(-1)! });
      });
      workspace.replaceDocuments(replacements);
      setProjectRevision(value => value + 1);
    }
    onSnapshot(next);
    if (result.entry && action.kind === 'create-file') {
      selectProject(result.entry); onModeChange('project');
    } else if (result.entry && action.kind === 'create-directory') {
      setProjectSelection(result.entry); onModeChange('project');
    }
  }
  const menuTarget: FileActionItem = mode === 'project' && sidebarVisible && treeMenuTarget ? treeMenuTarget
    : activeTab ? { kind: activeTab.kind, path: activeTab.path, documentId: activeTab.id }
      : { kind: 'directory', path: '', entryId: null };
  async function promptTreeAction(kind: DialogTreeAction) {
    if (!repositoryId || menuRequestPending.current) return;
    menuRequestPending.current = true; setMenuActionBusy(true);
    const item = menuTarget;
    try {
      const info = await window.desktop.getTreeActions(repositoryId, treeActionTarget(item));
      if (!alive.current || document.querySelector('dialog[open], [aria-modal="true"]')) return;
      if (kind === 'rename' && !info.canRename) throw new Error(info.renameReason ?? 'This item cannot be renamed.');
      if ((kind === 'create-file' || kind === 'create-directory') && !info.canCreate) throw new Error(info.createReason ?? 'Cannot create items here.');
      menuActionCompleted.current = false;
      setMenuTreeAction({ item, info, kind });
    } finally {
      menuRequestPending.current = false;
      if (alive.current) setMenuActionBusy(false);
    }
  }
  // Background Git refresh does not invalidate file capabilities. Keep file
  // commands available while it runs; each operation revalidates in the backend.
  const actionsAvailable = !!repositoryId && searchActive && !menuActionBusy;
  useApplicationActions({
    'file.newFile': { enabled: actionsAvailable, run: () => promptTreeAction('create-file') },
    'file.newFolder': { enabled: actionsAvailable, run: () => promptTreeAction('create-directory') },
    'file.rename': { enabled: actionsAvailable && !!menuTarget.path, run: () => promptTreeAction('rename') },
    'navigate.source': { enabled: actionsAvailable && activeTab?.kind === 'comparison' && comparisonForTab(snapshot!, activeTab)?.status !== 'D', run: async () => {
      if (!activeTab || !repositoryId) return;
      const entries = await resolveProjectPaths([activeTab.path], loadDirectory);
      if (!alive.current) return;
      const entry = entries.get(activeTab.path);
      if (!entry || entry.kind !== 'file') throw new Error('This working-tree file is no longer available.');
      selectProject(entry); onModeChange('project');
    } },
  });
  return <FileActionsProvider repositoryPath={snapshot?.repository.path ?? ''}
    getTreeInfo={async item => {
      if (!repositoryId) throw new Error('Open a repository first.');
      return window.desktop.getTreeActions(repositoryId, treeActionTarget(item));
    }} performAction={performTreeAction}
    copyPath={async (item, format) => {
      if (!repositoryId) throw new Error('Open a repository first.');
      await window.desktop.copyFilePath(repositoryId, treeActionTarget(item), format);
    }}
    getInfo={async item => {
      if (!repositoryId) throw new Error('Open a repository first.');
      if (item.kind === 'directory') return { path: item.path, absolutePath: '', applications: [] };
      return window.desktop.getFileActions(repositoryId, actionTarget(item));
    }} openIn={async (item, applicationId) => {
      if (!repositoryId) throw new Error('Open a repository first.');
      await window.desktop.openFileIn(repositoryId, actionTarget(item), applicationId);
    }} onSource={entry => { selectProject(entry); onModeChange('project'); }}>
    <div className="desktop-body">
      <aside className="sidebar" hidden={!sidebarVisible} style={{ width: sidebarWidth }} aria-label={mode === 'project' ? 'Project files' : 'Changed files'}>
        <div className="workspace-panel" hidden={mode !== 'project'}>
          {snapshot ? <ProjectPanel repositoryKey={snapshot.repository.id} repositoryName={snapshot.repository.name} repositoryPath={snapshot.repository.path}
            selectedPath={projectSelection?.path ?? null} loadDirectory={loadDirectory} onSelect={selectProject}
            onFocusEntry={entry => setTreeMenuTarget(entry ? { kind: entry.kind === 'directory' ? 'directory' : 'file', path: entry.path, entryId: entry.id } : { kind: 'directory', path: '', entryId: null })}
            refreshToken={snapshot.generation} onRefresh={refresh} decorationClient={window.desktop} onPreferencesChange={setTreePreferences} />
            : <StatePanel title="Project" text="Open a repository to browse its folders and files." />}
        </div>
        <div className="workspace-panel" hidden={mode !== 'commit'}>
          <CommitPanel files={changesFor(snapshot)} selectedId={selected?.id ?? null} onSelect={selectChange} onCommitRequest={snapshot && snapshot.repository.gitAvailable !== false ? onCommitRequest : undefined}
            repositoryName={snapshot?.repository.name ?? 'No repository'} repositoryKey={snapshot?.repository.path ?? 'no-repository'}
            scopeBackgrounds={treePreferences.scopeBackgrounds}
            onRefresh={snapshot ? refresh : undefined} busy={busy} untrackedPending={snapshot?.untrackedPending} untrackedError={snapshot?.untrackedError} emptyMessage={snapshot?.repository.gitAvailable === false ? 'This project has no Git repository.' : snapshot ? 'Working tree clean' : 'Open a repository to review local changes.'} />
        </div>
      </aside>
      <div className="sidebar-resizer" hidden={!sidebarVisible} role="separator" aria-label="Resize file sidebar" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={560} aria-valuenow={sidebarWidth} tabIndex={0}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onSidebarWidth(Math.max(280, Math.min(560, event.clientX))); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onSidebarWidth(Math.max(280, Math.min(560, sidebarWidth + (event.key === 'ArrowLeft' ? -20 : 20)))); } }} />
      <div ref={editorWorkspaceElement} className="viewer-section desktop-editor-workspace" onFocusCapture={() => setTreeMenuTarget(undefined)}>
        <EditorWorkspace workspace={workspace} applicationActionsEnabled={searchActive} emptyState={emptyState} renderTab={(tab, groupId) => snapshot ? <DesktopTab key={`${tab.instanceId}:${tab.id}`}
          tab={tab} snapshot={snapshot} projectEntry={projectEntries.current.get(tab.id)} resolvingProject={resolvingPaths.has(tab.path)} preferences={preferences} onPreferences={onPreferences}
          refresh={refresh} onViewer={registerViewer} onFileOpened={onFileOpened} onSource={selectProject}
          fileOpenRequest={groupId === workspace.state.activeGroupId && tab.kind === 'file' && fileOpenRequest?.result.entry.path === tab.path ? fileOpenRequest : undefined} /> : emptyState} />
      </div>
    </div>
    {menuTreeAction && <TreeActionDialog kind={menuTreeAction.kind} info={menuTreeAction.info}
      onPerform={async action => { await performTreeAction(menuTreeAction.item, action); menuActionCompleted.current = true; }}
      onClose={() => {
        const focusEditor = menuActionCompleted.current && (menuTreeAction.kind === 'create-file' || menuTreeAction.kind === 'rename' && menuTreeAction.item.kind !== 'directory');
        setMenuTreeAction(undefined);
        if (focusEditor) {
          setTreeMenuTarget(undefined);
          // A successful file operation opens/remaps its tab. Do not restore
          // native-dialog focus to an older Project row and rename that next.
          requestAnimationFrame(() => editorWorkspaceElement.current?.querySelector<HTMLElement>('.workspace-group.is-active [role="tab"][aria-selected="true"]')?.focus());
        }
      }} />}
  </FileActionsProvider>;
}

/** Every editor instance owns its loading generation; siblings cannot replace each other's data. */
function DesktopTab({ tab, snapshot, projectEntry, resolvingProject, preferences, onPreferences, refresh, onViewer, fileOpenRequest, onFileOpened, onSource }: {
  tab: WorkspaceTab; snapshot: RepositorySnapshot; projectEntry?: ProjectEntry;
  resolvingProject?: boolean;
  preferences: ViewerPreferences; onPreferences: (value: ViewerPreferences) => void; refresh: () => void;
  onViewer: (instanceId: string, value: SmartDiff | null) => void;
  fileOpenRequest?: FileOpenRequest;
  onFileOpened: (token: number) => void;
  onSource: (entry: ProjectEntry) => void;
}) {
  const fileEditor = useRef<editor.IStandaloneCodeEditor | null>(null);
  const openLocation = useRef({ fileOpenRequest, onFileOpened }); openLocation.current = { fileOpenRequest, onFileOpened };
  const navigateFile = useCallback(() => {
    const { fileOpenRequest: request, onFileOpened: consumed } = openLocation.current;
    const instance = fileEditor.current, model = instance?.getModel();
    if (!request || !instance || !model) return;
    const position = model.validatePosition({ lineNumber: request.result.lineNumber, column: request.result.matches[0]?.column ?? 1 });
    instance.layout(); instance.setPosition(position);
    instance.revealPositionInCenter(position, 1); instance.focus();
    consumed(request.token);
  }, []);
  const registerFileEditor = useCallback((instance: editor.IStandaloneCodeEditor | null) => {
    fileEditor.current = instance;
    if (instance) navigateFile();
  }, [navigateFile]);
  useEffect(() => {
    if (!fileOpenRequest) return;
    const frame = requestAnimationFrame(navigateFile);
    return () => cancelAnimationFrame(frame);
  }, [fileOpenRequest, navigateFile]);
  const change = tab.kind === 'comparison' ? comparisonForTab(snapshot, tab) : undefined;
  const repositoryId = snapshot.repository.id;
  const generation = snapshot.generation;
  const [content, setContent] = useState<FileComparison | ProjectFile | undefined>(() => {
    const buffer = getBuffer(tab.editKey);
    return initialTabContent(cachedContents.get(tab.id), { repositoryId, path: tab.path, kind: tab.kind, changeId: change?.id }, !!buffer?.dirty || !!buffer?.saving);
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshNotice, setRefreshNotice] = useState<string>();
  const [resolved, setResolved] = useState(false);
  const recovery = useRef(new StaleReadRecovery());
  const request = useRef(new PendingTabRead());
  useEffect(() => {
    const current = request.current.begin({ repositoryId, documentId: tab.id, kind: tab.kind, capabilityId: change?.id ?? projectEntry?.id, generation });
    if (current === undefined) return;
    recovery.current.cancel();
    setLoading(true); setError(undefined); setRefreshNotice(undefined); setResolved(false);
    if (tab.kind === 'file' && !projectEntry && resolvingProject) { request.current.finish(current); return; }
    // Restored unversioned tabs have no capability until the initial background
    // scan finishes. Keep their tab/draft instead of declaring them unchanged.
    if (tab.kind === 'comparison' && !change && snapshot.untrackedPending) { request.current.finish(current); return; }
    if (tab.kind === 'comparison' && !change && snapshot.untrackedError) { setError(snapshot.untrackedError); setLoading(false); request.current.finish(current); return; }
    if (tab.kind === 'comparison' && !change || tab.kind === 'file' && !projectEntry) {
      const buffer = getBuffer(tab.editKey);
      if (tab.kind === 'comparison' && !buffer?.dirty && !buffer?.saving) setResolved(true);
      else setError(buffer?.dirty || buffer?.saving ? 'This comparison changed on disk. Your unsaved edits are preserved.' : 'This file is no longer available.');
      setLoading(false);
      request.current.finish(current);
      return;
    }
    // A tab switch is not a new repository snapshot. Reuse the already verified
    // endpoints without another disk/Git request; watcher/manual refreshes still
    // advance generation and revalidate through the backend.
    const verified = verifiedComparisonContent(cachedContents.get(tab.id), {
      repositoryId, path: tab.path, kind: tab.kind, changeId: change?.id, generation,
    });
    if (verified) {
      recovery.current.reset(); setContent(verified); setLoading(false); request.current.finish(current);
      return;
    }
    const operation = tab.kind === 'comparison'
      ? comparisonReads.read(repositoryId, change!.id, () => window.desktop.readComparison(repositoryId, change!.id))
      : window.desktop.readProjectFile(repositoryId, projectEntry!.id);
    operation.then(next => {
      if (!request.current.isCurrent(current)) return;
      if (next.state === 'stale') {
        // Keep the last usable editor mounted during a race. A bounded delayed
        // refresh obtains fresh capabilities and restarts this read automatically.
        if (!recovery.current.schedule(refresh)) {
          const notice = 'This file is still changing. It will reload when changes settle.';
          if (content) setRefreshNotice(notice); else setError(notice);
        }
        return;
      }
      if (next.repositoryId !== repositoryId || next.path !== tab.path || ('changeId' in next
        ? next.changeId !== change?.id
        : next.entryId !== projectEntry?.id)) {
        if (!recovery.current.schedule(refresh)) {
          const notice = 'Waiting for the current file to become available.';
          if (content) setRefreshNotice(notice); else setError(notice);
        }
        return;
      }
      recovery.current.reset();
      const nextSide = 'entryId' in next ? next.content : next.modified;
      const buffer = getBuffer(tab.editKey);
      if ((next.state !== 'text' || !nextSide?.editable) && (buffer?.dirty || buffer?.saving)) {
        setError(next.message ?? nextSide?.readOnlyReason ?? 'This file is no longer available. Your unsaved edits are preserved.'); return;
      }
      cachedContents.set(tab.id, next);
      setContent(next);
    }).catch(cause => { if (request.current.isCurrent(current)) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (request.current.finish(current)) setLoading(false); });
  }, [repositoryId, generation, snapshot.untrackedPending, snapshot.untrackedError, tab.id, tab.kind, tab.path, change?.id, projectEntry?.id, resolvingProject, refresh]);
  useEffect(() => () => { request.current.cancel(); recovery.current.cancel(); onViewer(tab.instanceId, null); }, [tab.instanceId, onViewer]);
  const register = useCallback((value: SmartDiff | null) => onViewer(tab.instanceId, value), [tab.instanceId, onViewer]);
  if (resolved) return <StatePanel title="No differences" text="This file no longer has changes in this comparison." />;
  return <TabContent tab={tab} content={content} originalPath={change?.oldPath} loading={loading} error={error} preferences={preferences} onPreferences={onPreferences}
    refreshNotice={refreshNotice} onRefresh={refresh} onViewer={register} onEditor={registerFileEditor} saveText={window.desktop.saveText}
    markdownActions={projectEntry ? {
      readImage: href => window.desktop.readMarkdownImage(repositoryId, projectEntry.id, href),
      openLink: async href => {
        if (/^(?:https?:|mailto:)/i.test(href)) await window.desktop.openMarkdownLink(href);
        else onSource(await window.desktop.resolveMarkdownLink(repositoryId, projectEntry.id, href));
      },
    } : undefined} />;
}

function StatePanel({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="state-panel"><UiIcon name="split" size={32} className="state-icon" /><h2>{title}</h2><p>{text}</p>{action}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
