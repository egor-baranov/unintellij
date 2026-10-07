import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import type { SmartDiff } from 'monaco-smart-diff';
import type { FileComparison, FileState, ProjectFile } from '../../desktop/src/bridge';
import { DiffSurface, type ViewerPreferences, type ViewerState } from '../DiffSurface';
import { FileSurface } from '../project/FileSurface';
import { diagnosticBarrier, trackProjectDiagnostics } from '../project/diagnostics';
import { Controls } from '../Controls';
import { MediaSurface } from '../media/MediaSurface';
import type { WorkspaceTab } from './model';
import { getWorkspaceView as snapshot, rememberWorkspaceView as remember, trackWorkspaceDiff, trackWorkspaceFile } from './viewState';
import { changeText, discardBuffer, editingKey, getBuffer, receiveText, retainEditingBuffer, saveBuffer, useEditingRevision, type SaveText } from '../editing/store';
import '../editing/editing.css';
import { useEditorApplicationActions } from './useEditorApplicationActions';
import { MarkdownSurface, type MarkdownActions } from '../markdown/MarkdownSurface';
import { isMarkdownPath } from '../markdown/render';
import type { MarkdownMode } from '../markdown/viewState';

const initialState: ViewerState = { status: 'loading', changeCount: 0, currentChange: -1 };
export interface TabContentProps {
  tab: WorkspaceTab;
  content?: ProjectFile | FileComparison;
  originalPath?: string;
  loading?: boolean;
  error?: string;
  refreshNotice?: string;
  preferences: ViewerPreferences;
  onPreferences: (preferences: ViewerPreferences) => void;
  onRefresh?: () => void;
  onState?: (state: ViewerState) => void;
  onViewer?: (viewer: SmartDiff | null) => void;
  onEditor?: (editor: editor.IStandaloneCodeEditor | null) => void;
  saveText?: SaveText;
  markdownActions?: MarkdownActions;
}

/** Shared content; only read-issued working-tree capabilities enable saving. */
export function TabContent(props: TabContentProps) {
  const { tab, content, loading, error, onRefresh } = props;
  const callbacks = useRef(props); callbacks.current = props;
  const [seed] = useState(() => {
    const previous = snapshot(tab.instanceId);
    if (previous || !tab.sourceInstanceId) return previous;
    const source = snapshot(tab.sourceInstanceId);
    // A split can still be loading when the app closes. Give it its own copy
    // immediately, before either surface has a live editor to snapshot.
    if (source) remember(tab.instanceId, source);
    return source;
  });
  const [preferences, setPreferences] = useState(seed?.preferences ?? props.preferences);
  const [state, setState] = useState<ViewerState>(initialState);
  const viewer = useRef<SmartDiff | null>(null);
  const fileEditor = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [menuViewer, setMenuViewer] = useState<SmartDiff | null>(null);
  const [menuEditor, setMenuEditor] = useState<editor.IStandaloneCodeEditor | null>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>(seed?.markdown?.mode ?? 'split');
  const stopViewer = useRef<(() => void) | undefined>(undefined);
  const stopEditor = useRef<(() => void) | undefined>(undefined);
  const stopDiagnostics = useRef<(() => void) | undefined>(undefined);
  const comparison = content && 'changeId' in content ? content : undefined;
  const file = content && 'entryId' in content ? content : undefined;
  const added = comparison?.changeType === 'added';
  const deleted = comparison?.changeType === 'deleted';
  const text = file?.content ?? (added ? comparison?.modified : deleted ? comparison?.original : undefined);
  const workingSide = file?.content ?? comparison?.modified;
  const editKey = content ? editingKey(content.repositoryId, tab.path) : tab.editKey;
  useEditingRevision();
  const editable = !deleted && !!workingSide?.editable && !!props.saveText;
  const buffer = editable ? getBuffer(editKey) : undefined;
  useEffect(() => editKey && editable ? retainEditingBuffer(editKey) : undefined, [editKey, editable]);
  useEffect(() => {
    if (!deleted && content && workingSide && props.saveText) receiveText(content.repositoryId, tab.path, workingSide, props.saveText, onRefresh);
  }, [deleted, content?.repositoryId, tab.path, workingSide, props.saveText, onRefresh]);
  const editText = (value: string) => { if (editKey) changeText(editKey, value); };
  const save = () => { if (editKey) void saveBuffer(editKey); };
  const keepDraft = !!buffer?.dirty || !!buffer?.saving;
  const updatePreferences = (next: ViewerPreferences) => {
    remember(tab.instanceId, { preferences: next });
    setPreferences(next); callbacks.current.onPreferences(next);
  };
  const markdown = !!file && isMarkdownPath(tab.path);
  useEditorApplicationActions({ fileEditor: markdown && markdownMode === 'preview' ? null : menuEditor, viewer: menuViewer, preferences, state, onPreferences: updatePreferences });
  const report = (next: ViewerState) => { setState(next); callbacks.current.onState?.(next); };
  const registerDiagnostics = () => {
    stopDiagnostics.current?.(); stopDiagnostics.current = undefined;
    const current = callbacks.current.content;
    // Historical/staged snapshots are not the current project's diagnostics.
    if (!current || !('entryId' in current)) return;
    const model = fileEditor.current?.getModel();
    if (model) stopDiagnostics.current = trackProjectDiagnostics(current.repositoryId, callbacks.current.tab.path, model, current.facts);
  };
  const reportBarrier = diagnosticBarrier(file?.facts);
  useEffect(() => {
    registerDiagnostics();
    return () => { stopDiagnostics.current?.(); stopDiagnostics.current = undefined; };
  }, [content?.repositoryId, tab.path, reportBarrier]);
  useEffect(() => { remember(tab.instanceId, { preferences }); }, [tab.instanceId, preferences]);
  useEffect(() => {
    // Background reads keep the current editor mounted. Its worker may not
    // emit again when the endpoints match, so retain its count/navigation.
    if (!content) report(error ? { ...initialState, status: 'error', message: error } : initialState);
    else if (content.state === 'media') report({ ...initialState, status: 'ready' });
    else if (content.state !== 'text') report({ ...initialState, status: 'empty', message: content.message });
    else if (text) report({ ...initialState, status: 'ready' });
    // A normal comparison reports worker progress through DiffSurface.
  }, [loading, error, content, text]);
  const registerViewer = (instance: SmartDiff | null) => {
    stopViewer.current?.();
    viewer.current = instance;
    setMenuViewer(instance);
    stopViewer.current = instance ? trackWorkspaceDiff(tab.instanceId, instance) : undefined;
    callbacks.current.onViewer?.(instance);
  };
  const registerEditor = (instance: editor.IStandaloneCodeEditor | null) => {
    stopEditor.current?.();
    fileEditor.current = instance;
    setMenuEditor(instance);
    stopEditor.current = instance ? trackWorkspaceFile(tab.instanceId, instance) : undefined;
    registerDiagnostics();
    callbacks.current.onEditor?.(instance);
  };
  const notice = state.message ?? state.featureUnavailable?.join(' · ');
  const TextSurface = markdown ? MarkdownSurface : FileSurface;
  return <main className="viewer-section workspace-tab-content" aria-label={tab.kind === 'file' ? 'Selected project file' : 'Selected file comparison'} data-document-id={tab.id} data-instance-id={tab.instanceId} data-editable={editable}
    data-path={tab.path} data-original-path={props.originalPath ?? tab.path} data-original-label={comparison?.original?.label ?? comparison?.originalLabel} data-modified-label={workingSide?.label ?? comparison?.modifiedLabel}>
    {props.refreshNotice && <div className="notice" role="status">{props.refreshNotice}{onRefresh && <button onClick={onRefresh}>Retry</button>}</div>}
    {buffer?.error || (error && keepDraft) ? <div className="editing-notice" role="alert"><span>{buffer?.error ?? error}</span>
      <button disabled={buffer?.saving} onClick={() => { if (editKey) discardBuffer(editKey); onRefresh?.(); }}>Reload from disk</button></div> : null}
    {(loading && !content) || (!content && !error) ? <div className="state-panel" role="status"><h2>Loading {tab.kind === 'file' ? 'file' : 'comparison'}…</h2></div> : !error && content?.state === 'media' ?
      <MediaSurface path={tab.path} original={comparison?.originalMedia} modified={file?.media ?? comparison?.modifiedMedia}
        originalLabel={comparison?.originalLabel} modifiedLabel={comparison?.modifiedLabel} comparison={!!comparison && !added && !deleted} stateKey={`tab:${tab.instanceId}`} restoreState={snapshot(tab.instanceId)?.media ?? seed?.media} /> : (error && !keepDraft) || content?.state !== 'text' ?
      <div className="state-panel" role={error ? 'alert' : 'status'}><h2>{error ? 'File unavailable' : stateTitle(content?.state)}</h2><p>{error ?? content?.message ?? 'This file cannot be displayed.'}</p>{onRefresh && <button onClick={onRefresh}>Refresh {tab.kind === 'file' ? 'project' : 'changes'}</button>}</div> : <>
        {!text && <div className="editor-toolbar"><Controls preferences={preferences} onChange={updatePreferences} state={state} previous={() => viewer.current?.previousChange()} next={() => viewer.current?.nextChange()} expandAll={() => viewer.current?.expandAllRegions()} collapseAll={() => viewer.current?.collapseAllRegions()} /></div>}
        {!text && notice && <div className="notice" role="status">{notice}</div>}
        {workingSide?.readOnlyReason && <div className="notice" role="status">{workingSide.readOnlyReason}</div>}
        {text ? <TextSurface path={tab.path} text={buffer?.text ?? text.text} editable={editable} onChange={editText} onSave={save} added={added} deleted={deleted} wrap={preferences.wrap} onWrapChange={wrap => updatePreferences({ ...preferences, wrap })} stateKey={`tab:${tab.instanceId}`} restoreState={fileEditor.current ? undefined : snapshot(tab.instanceId)?.file ?? seed?.file} onEditor={registerEditor}
          markdownView={snapshot(tab.instanceId)?.markdown ?? seed?.markdown} onMarkdownView={markdown => remember(tab.instanceId, { markdown })} onModeChange={setMarkdownMode} actions={props.markdownActions} /> : comparison?.original && comparison.modified ?
          <DiffSurface path={tab.path} original={comparison.original.text} modified={buffer?.text ?? comparison.modified.text} editable={editable} onChange={editText} onSave={save} preferences={preferences} onState={report} onViewer={registerViewer} restoreState={viewer.current ? undefined : snapshot(tab.instanceId)?.diff ?? seed?.diff} onSplitRatioChange={splitRatio => updatePreferences({ ...preferences, splitRatio })} /> : <div className="state-panel"><h2>File unavailable</h2><p>Complete file contents are unavailable. Refresh to try again.</p></div>}
      </>}
  </main>;
}
function stateTitle(state?: FileState) {
  switch (state) {
    case 'binary': return 'Binary file';
    case 'oversized': return 'File exceeds interactive limit';
    case 'encoding': return 'Unsupported text encoding';
    case 'conflicted': return 'Merge conflict';
    case 'submodule': return 'Submodule';
    case 'type-change': return 'File type changed';
    case 'symlink': return 'Symbolic link';
    case 'stale': return 'Comparison changed';
    default: return 'File unavailable';
  }
}
