import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SmartDiff } from 'monaco-smart-diff';
import type { editor } from 'monaco-editor';
import type { ComparisonSide, FileComparison, ProjectEntry, ProjectFile, SaveTextResult } from '../../desktop/src/bridge';
import { CommitPanel } from '../../shared/commit/CommitPanel';
import type { CommitSubmission } from '../../shared/commit/options';
import { ProjectPanel } from '../../shared/project/ProjectPanel';
import { WorkspaceSwitch } from '../../shared/project/WorkspaceSwitch';
import { ProjectPicker } from '../../shared/ProjectPicker';
import { defaultPreferences, type ViewerPreferences, type ViewerState } from '../../shared/DiffSurface';
import { EditorWorkspace, useEditorWorkspace, type WorkspaceDocument, type WorkspaceTab } from '../../shared/workspace';
import { TabContent } from '../../shared/workspace/TabContent';
import { monaco } from '../../shared/monaco';
import { BranchSelector } from '../../shared/branches/BranchSelector';
import { BranchComparisonPanel } from '../../shared/branches/BranchComparisonPanel';
import { SettingsButton } from '../../shared/settings/SettingsButton';
import { editingKey } from '../../shared/editing/store';
import { EditingGuard } from '../../shared/editing/UnsavedDialog';
import { FileActionsProvider } from '../../shared/files/FileActions';
import type { BranchClient, BranchComparison } from '../../shared/branches/types';
import { createPreviewBranchClient } from './branch-fixtures';
import { workingCommitFile, workingCommitFiles } from './commit-fixtures';
import { loadProjectDirectory, loadProjectFile, projectDirectoryReads, projectEntry, projectRepository, requestedProjectDirectories } from './project-fixtures';
import { markdownImageReads, waitForMarkdownImages } from './markdown-fixture';
import './commit-preview.css';

const initial: ViewerState = { status: 'loading', changeCount: 0, currentChange: -1 };
const initialProject = 'apps/playground/src/ReviewPreferencesPanel.tsx';
type WorkspaceMode = 'project' | 'commit';
declare global {
  interface Window {
    branchPreview: { client: BranchClient; refresh: () => void };
    commitPreview: {
      viewer: SmartDiff | null; editor: editor.IStandaloneCodeEditor | null;
      getSelected: () => string; selectFile: (id: string) => void; getState: () => ViewerState;
    };
    projectPreview: {
      editor: editor.IStandaloneCodeEditor | null; monaco: typeof monaco;
      getMode: () => WorkspaceMode; setMode: (mode: WorkspaceMode) => void;
      getSelected: () => string; selectFile: (path: string) => void;
      getState: () => ProjectFile | null; getRequestedDirectories: () => string[];
      directoryReads: typeof projectDirectoryReads;
      markdownImages: typeof markdownImageReads;
      saveText: PreviewWorkingTree['saveText'];
    };
  }
}
function modeFromUrl(): WorkspaceMode { return new URLSearchParams(location.search).get('view') === 'project' ? 'project' : 'commit'; }
function comparisonDocument(id: string): WorkspaceDocument {
  const file = workingCommitFile(id)!;
  const editable = file.status !== 'D' && !file.unsupported && !file.modifiedMedia;
  return { id: `comparison:${file.id}`, path: file.path, kind: 'comparison', description: file.group,
    ...(editable ? { editKey: editingKey(projectRepository.id, file.path) } : {}) };
}
function fileDocument(entry: ProjectEntry): WorkspaceDocument {
  return { id: `file:${entry.path}`, path: entry.path, kind: 'file', description: 'Working tree',
    ...(entry.kind === 'file' ? { editKey: editingKey(projectRepository.id, entry.path) } : {}) };
}
interface LiveTab { viewer?: SmartDiff | null; editor?: editor.IStandaloneCodeEditor | null; state?: ViewerState; file?: ProjectFile }

/** Browser saves update only this mounted sample repository, never fixture snapshots. */
function createPreviewWorkingTree() {
  const paths = new Map<string, { id: string; version: number; content: ComparisonSide }>();
  const capabilities = new Map<string, string>();
  function content(path: string, initial: ComparisonSide): ComparisonSide {
    let value = paths.get(path);
    if (!value) {
      value = { id: crypto.randomUUID(), version: 1, content: { ...initial } };
      paths.set(path, value); capabilities.set(value.id, path);
    }
    return { ...value.content, label: initial.label, editable: { id: value.id, version: String(value.version) } };
  }
  async function saveText(repositoryId: string, id: string, version: string, text: string): Promise<SaveTextResult> {
    const path = capabilities.get(id);
    const value = path === undefined ? undefined : paths.get(path);
    if (repositoryId !== projectRepository.id || path === undefined || !value) {
      return { repositoryId, path: '', state: 'unavailable', message: 'This sample file is no longer available. Refresh and try again.' };
    }
    if (version !== String(value.version)) {
      return { repositoryId, path, state: 'stale', message: 'This sample file changed after it was loaded. Reload before saving.', content: content(path, value.content) };
    }
    const saved = side('Working tree', text);
    if (saved.metadata.bytes > 32 * 1024 * 1024) {
      return { repositoryId, path, state: 'oversized', message: 'The sample file exceeds the 32 MiB text limit.' };
    }
    value.content = saved; value.version++;
    return { repositoryId, path, state: 'saved', content: content(path, saved) };
  }
  return { content, saveText };
}
type PreviewWorkingTree = ReturnType<typeof createPreviewWorkingTree>;

export function CommitPreview() {
  const [workingTree] = useState(createPreviewWorkingTree);
  const [branchClient] = useState(() => {
    const scenario = new URLSearchParams(location.search).get('branchScenario');
    return createPreviewBranchClient(projectRepository.id, { scenario: scenario === 'detached' || scenario === 'unborn' || scenario === 'loading' || scenario === 'error' || scenario === 'stale' ? scenario : 'normal' });
  });
  const [branchComparison, setBranchComparison] = useState<BranchComparison | null>(null);
  const [commitRequest, setCommitRequest] = useState<CommitSubmission & { id: number }>();
  const [mode, setMode] = useState<WorkspaceMode>(modeFromUrl);
  const [selectedId, setSelectedId] = useState(() => {
    const requested = new URLSearchParams(location.search).get('file');
    return requested ? workingCommitFile(requested)?.id ?? 'preferences' : 'preferences';
  });
  const [projectSelected, setProjectSelected] = useState(() => {
    const requested = new URLSearchParams(location.search).get('path');
    const entry = requested ? projectEntry(requested) : undefined;
    return entry && entry.kind !== 'directory' ? entry : projectEntry(initialProject)!;
  });
  const workspace = useEditorWorkspace([mode === 'project' ? fileDocument(projectSelected) : comparisonDocument(selectedId)]);
  const { open } = workspace;
  const group = workspace.state.groups.find(group => group.id === workspace.state.activeGroupId)!;
  const active = group.tabs.find(tab => tab.id === group.activeId);
  const activeRef = useRef(active); activeRef.current = active;
  const modeRef = useRef(mode); modeRef.current = mode;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const projectRef = useRef(projectSelected); projectRef.current = projectSelected;
  const live = useRef(new Map<string, LiveTab>());
  const [preferences, setPreferences] = useState<ViewerPreferences>(defaultPreferences);
  const [revision, setRevision] = useState(0);
  const [width, setWidth] = useState(350);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('preview-sidebar') !== 'hidden');
  const toggleSidebar = useCallback(() => setSidebar(value => !value), []);
  useEffect(() => { localStorage.setItem('preview-sidebar', sidebar ? 'shown' : 'hidden'); }, [sidebar]);
  const choose = useCallback((id: string) => {
    const file = workingCommitFile(id);
    if (!file) return;
    setSelectedId(file.id); setMode('commit'); open(comparisonDocument(file.id));
  }, [open]);
  const chooseProject = useCallback((entry: ProjectEntry) => {
    if (entry.kind === 'directory') return;
    setProjectSelected(entry); setMode('project'); open(fileDocument(entry));
  }, [open]);
  const changeMode = useCallback((next: WorkspaceMode, pushHistory = true) => {
    setBranchComparison(null);
    setSidebar(true);
    if (pushHistory && next !== modeRef.current) {
      const url = new URL(location.href); url.searchParams.set('view', next); url.searchParams.delete('fixture');
      history.pushState({}, '', url);
    }
    setMode(next);
    open(next === 'project' ? fileDocument(projectRef.current) : comparisonDocument(selectedRef.current));
  }, [open]);
  // Clicking a tab selects the matching tree without reopening/replacing tabs.
  useEffect(() => {
    if (!active) return;
    if (active.kind === 'file') {
      const entry = projectEntry(active.path); if (entry) setProjectSelected(entry);
      setMode('project');
    } else { setSelectedId(active.id.slice('comparison:'.length)); setMode('commit'); }
  }, [active?.instanceId, active?.id, active?.kind, active?.path]);
  const syncPreview = useCallback(() => {
    const tab = activeRef.current, value = tab ? live.current.get(tab.instanceId) : undefined;
    if (window.commitPreview) { window.commitPreview.viewer = tab?.kind === 'comparison' ? value?.viewer ?? null : null; window.commitPreview.editor = tab?.kind === 'comparison' ? value?.editor ?? null : null; }
    if (window.projectPreview) window.projectPreview.editor = tab?.kind === 'file' ? value?.editor ?? null : null;
  }, []);
  const updateLive = useCallback((id: string, value: Partial<LiveTab>) => {
    live.current.set(id, { ...live.current.get(id), ...value }); syncPreview();
  }, [syncPreview]);
  useEffect(() => {
    const current = () => { const tab = activeRef.current; return tab ? live.current.get(tab.instanceId) : undefined; };
    window.branchPreview = { client: branchClient, refresh: () => setRevision(value => value + 1) };
    window.commitPreview = { viewer: null, editor: null, getSelected: () => selectedRef.current, selectFile: choose, getState: () => current()?.state ?? initial };
    window.projectPreview = { editor: null, monaco, getMode: () => modeRef.current, setMode: changeMode, getSelected: () => projectRef.current.path, getState: () => current()?.file ?? null,
      selectFile: path => { const entry = projectEntry(path); if (entry) chooseProject(entry); }, getRequestedDirectories: requestedProjectDirectories, directoryReads: projectDirectoryReads, markdownImages: markdownImageReads, saveText: workingTree.saveText };
    syncPreview();
    // Monaco handles Ctrl+B as a caret command on macOS. Host shortcuts must
    // run in capture phase so the documented sidebar toggle works in an editor.
    const sidebarShortcut = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog')) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); event.stopPropagation(); toggleSidebar(); }
    };
    const navigate = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog')) return;
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && current()?.viewer) {
        event.preventDefault(); if (event.key === 'ArrowDown') current()!.viewer!.nextChange(); else current()!.viewer!.previousChange();
      }
    };
    const restoreMode = () => changeMode(modeFromUrl(), false);
    window.addEventListener('keydown', sidebarShortcut, true); window.addEventListener('keydown', navigate); window.addEventListener('popstate', restoreMode);
    return () => { window.removeEventListener('keydown', sidebarShortcut, true); window.removeEventListener('keydown', navigate); window.removeEventListener('popstate', restoreMode); };
  }, [choose, chooseProject, changeMode, syncPreview, toggleSidebar, branchClient, workingTree]);
  useEffect(() => {
    syncPreview();
    const ids = new Set(workspace.state.groups.flatMap(group => group.tabs.map(tab => tab.instanceId)));
    for (const id of live.current.keys()) if (!ids.has(id)) live.current.delete(id);
  }, [workspace.state, syncPreview]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  return <FileActionsProvider repositoryPath={projectRepository.path} preview onSource={chooseProject}
    getInfo={async item => {
      const entry = projectEntry(item.path);
      return { path: item.path, absolutePath: `${projectRepository.path}/${item.path}`, applications: [],
        source: entry?.kind === 'file' ? entry : undefined, unavailableReason: entry ? 'Available in desktop app' : 'This file is absent from the working tree.' };
    }} openIn={async () => { throw new Error('Available in desktop app'); }}>
  <div className="application commit-preview" data-workspace={mode}>
    <EditingGuard />
    <header className="topbar">
      <WorkspaceSwitch value={sidebar && !branchComparison ? mode : null} onChange={next => {
        if (next !== mode) changeMode(next);
        else { setSidebar(!sidebar || !!branchComparison); setBranchComparison(null); }
      }} /><span className="toolbar-divider" />
      <ProjectPicker project={projectRepository} onSelect={() => changeMode('project')} preview />
      <BranchSelector repository={projectRepository} client={branchClient} refreshToken={revision} commitRequest={commitRequest} onRepositoryChanged={refresh} onCompare={setBranchComparison} onCommit={() => changeMode('commit')} preview />
      <span className="preview-indicator" title="Interactive sample repository; no local files are changed">Preview</span>
      <a className="preview-link" href="/?fixture=reference">Diff fixtures</a>
      <span className="topbar-spacer" /><SettingsButton />
    </header>
    {branchComparison && <BranchComparisonPanel refreshToken={revision} comparison={branchComparison} client={branchClient} preferences={preferences} onPreferences={setPreferences} onReplace={setBranchComparison} onClose={() => setBranchComparison(null)} />}
    <div className={`commit-preview-body${branchComparison ? ' branch-workspace-hidden' : ''}`}>
      <aside className="commit-preview-sidebar" hidden={!sidebar} style={{ width }} aria-label={mode === 'commit' ? 'Commit changes panel' : 'Project files panel'}>
        <div className="preview-sidebar-pane" hidden={mode !== 'commit'}><CommitPanel files={branchClient.getChanges()} selectedId={selectedId} onSelect={choose} repositoryName={projectRepository.name} repositoryKey="preview-example" onRefresh={refresh} onCommitRequest={submission => setCommitRequest(previous => ({ ...submission, id: (previous?.id ?? 0) + 1 }))} /></div>
        <div className="preview-sidebar-pane" hidden={mode !== 'project'}><ProjectPanel repositoryKey={projectRepository.id} repositoryName={projectRepository.name} repositoryPath={projectRepository.path} selectedPath={projectSelected.path} loadDirectory={loadProjectDirectory} onSelect={chooseProject} refreshToken={revision} onRefresh={refresh} /></div>
      </aside>
      <div className="commit-preview-resizer" hidden={!sidebar} role="separator" tabIndex={0} aria-label={mode === 'commit' ? 'Resize commit panel' : 'Resize project panel'} aria-orientation="vertical" aria-valuemin={280} aria-valuemax={560} aria-valuenow={width}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(280, Math.min(560, event.clientX))); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(280, Math.min(560, value + (event.key === 'ArrowLeft' ? -20 : 20)))); } }} />
      <EditorWorkspace workspace={workspace} renderTab={tab => <PreviewTab key={tab.instanceId} tab={tab} revision={revision} workingTree={workingTree} preferences={preferences} onPreferences={setPreferences} onRefresh={refresh} onLive={updateLive} onSource={chooseProject} />} />
    </div>
  </div></FileActionsProvider>;
}

function side(label: string, text: string): ComparisonSide {
  const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  const lineEnding = endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'CRLF' : endings.has('\r') ? 'CR' : endings.has('\n') ? 'LF' : 'none';
  return { label, text, metadata: { bytes: new TextEncoder().encode(text).byteLength, encoding: 'utf-8', lineEnding, finalNewline: /[\r\n]$/.test(text) } };
}
function PreviewTab({ tab, revision, workingTree, preferences, onPreferences, onRefresh, onLive, onSource }: {
  tab: WorkspaceTab; revision: number; preferences: ViewerPreferences; onPreferences: (value: ViewerPreferences) => void;
  workingTree: PreviewWorkingTree;
  onRefresh: () => void; onLive: (id: string, value: Partial<LiveTab>) => void;
  onSource: (entry: ProjectEntry) => void;
}) {
  const [file, setFile] = useState<ProjectFile>();
  const [loading, setLoading] = useState(tab.kind === 'file');
  const [error, setError] = useState<string>();
  const selected = workingCommitFiles.find(file => `comparison:${file.id}` === tab.id);
  const comparison = useMemo<FileComparison | undefined>(() => {
    if (!selected) return undefined;
    const originalLabel = selected.group === 'untracked' ? 'Empty' : 'HEAD';
    const modifiedLabel = 'Working tree';
    const media = selected.originalMedia || selected.modifiedMedia;
    const original = { ...side(originalLabel, selected.original), readOnlyReason: selected.group === 'untracked' ? 'This file does not exist in HEAD.' : `${originalLabel} is a read-only Git snapshot.` };
    const initialModified = side(modifiedLabel, selected.modified);
    const modified = selected.status !== 'D' && !selected.unsupported && !media
      ? workingTree.content(selected.path, initialModified)
      : { ...initialModified, readOnlyReason: selected.status === 'D' ? 'This file has been deleted.' : 'This file cannot be edited as text.' };
    return {
      repositoryId: projectRepository.id, changeId: selected.id, path: selected.path, generation: revision,
      state: selected.unsupported ? 'binary' : media ? 'media' : 'text', message: selected.message,
      changeType: selected.status === 'A' || selected.group === 'untracked' ? 'added' : selected.status === 'D' ? 'deleted' : 'modified',
      ...(media ? { originalLabel, modifiedLabel,
        originalMedia: selected.originalMedia && { ...selected.originalMedia, label: originalLabel },
        modifiedMedia: selected.modifiedMedia && { ...selected.modifiedMedia, label: modifiedLabel },
      } : { original, modified }),
    };
  }, [selected, revision, workingTree]);
  useEffect(() => {
    if (tab.kind !== 'file') return;
    let current = true; setLoading(true); setError(undefined);
    const entry = projectEntry(tab.path);
    if (!entry) { setLoading(false); setError('This sample file is unavailable.'); return; }
    loadProjectFile(entry).then(value => {
      if (!current) return;
      const loaded = value.state === 'text' && value.content && entry.kind === 'file'
        ? { ...value, content: workingTree.content(value.path, value.content) } : value;
      setFile(loaded); onLive(tab.instanceId, { file: loaded });
    })
      .catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [tab.instanceId, tab.path, tab.kind, revision, onLive, workingTree]);
  const markdownActions = useMemo(() => {
    const resolve = (href: string) => {
      const base = new URL(`https://preview.invalid/${tab.path}`);
      const target = new URL(href, base);
      const entry = target.origin === base.origin ? projectEntry(decodeURIComponent(target.pathname.slice(1))) : undefined;
      if (!entry || entry.kind !== 'file') throw new Error('This sample link is unavailable.');
      return entry;
    };
    return {
      readImage: async (href: string) => {
        await waitForMarkdownImages();
        const value = await loadProjectFile(resolve(href));
        if (value.media?.kind !== 'image') throw new Error('This sample image is unavailable.');
        return { mimeType: value.media.mimeType, base64: value.media.base64, bytes: value.media.bytes };
      },
      openLink: async (href: string) => { onSource(resolve(href)); },
    };
  }, [tab.path, onSource]);
  return <TabContent tab={tab} content={comparison ?? file} originalPath={selected?.oldPath} loading={loading} error={error} preferences={preferences} onPreferences={onPreferences} onRefresh={onRefresh}
    saveText={workingTree.saveText}
    markdownActions={markdownActions}
    onState={state => onLive(tab.instanceId, { state })} onViewer={viewer => onLive(tab.instanceId, { viewer })} onEditor={editor => onLive(tab.instanceId, { editor })} />;
}
