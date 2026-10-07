import { useEffect, useRef } from 'react';
import { createSmartDiff, type SmartDiff, type SmartDiffOptions, type ViewState } from 'monaco-smart-diff';
import { monaco, languageForPath } from './monaco';
import { editorAppearance } from './settings/runtime';
import { subscribeSettings } from './settings/store';
import { ModelEchoes } from './modelEchoes';
import '../../packages/monaco-smart-diff/src/styles.css';

export type ViewerState = Parameters<NonNullable<SmartDiffOptions['onStateChange']>>[0];
export interface ViewerPreferences { viewMode?: 'side-by-side' | 'inline'; layout: 'compact' | 'aligned'; sync: boolean; collapse: boolean; whitespace: boolean; wrap: boolean; splitRatio?: number }
export const defaultPreferences: ViewerPreferences = { viewMode: 'side-by-side', layout: 'compact', sync: true, collapse: true, whitespace: false, wrap: false, splitRatio: 0.5 };
export interface DiffSurfaceProps {
  original: string; modified: string; path: string; preferences: ViewerPreferences;
  onState: (state: ViewerState) => void; onViewer?: (viewer: SmartDiff | null) => void;
  restoreState?: ViewState;
  onSplitRatioChange?: (ratio: number) => void;
  editable?: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
}
export function DiffSurface({ original, modified, path, preferences, onState, onViewer, restoreState, onSplitRatioChange, editable = false, onChange, onSave }: DiffSurfaceProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<SmartDiff | null>(null);
  const callbacks = useRef({ onState, onViewer, onSplitRatioChange, editable, onChange, onSave });
  callbacks.current = { onState, onViewer, onSplitRatioChange, editable, onChange, onSave };
  const lastPreferences = useRef(preferences);
  const lastEditable = useRef(editable);
  const actualSplitRatio = useRef(preferences.splitRatio ?? 0.5);
  const initial = useRef({ original, modified, path, preferences, restoreState, editable });
  const latest = useRef({ preferences, editable }); latest.current = { preferences, editable };
  const pendingView = useRef(restoreState);
  const viewMode = preferences.viewMode ?? 'side-by-side';
  const sourceProps = useRef({ original, modified, path });
  const updatingModels = useRef(false);
  const echoes = useRef(new ModelEchoes());
  const models = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const values = latest.current;
    if (!models.current) {
      const source = initial.current;
      models.current = { original: monaco.editor.createModel(source.original, languageForPath(source.path, source.original.slice(0, 512))), modified: monaco.editor.createModel(source.modified, languageForPath(source.path, source.modified.slice(0, 512))) };
    }
    viewer.current = createSmartDiff(container.current, {
      monaco, ...models.current, ...viewerOptions(values.preferences),
      modifiedEditable: values.editable,
      onStateChange: state => callbacks.current.onState(state),
      onSplitRatioChange: ratio => { actualSplitRatio.current = ratio; callbacks.current.onSplitRatioChange?.(ratio); },
    });
    const contentListener = models.current.modified.onDidChangeContent(() => {
      if (!updatingModels.current && callbacks.current.editable && callbacks.current.onChange) {
        const text = models.current!.modified.getValue();
        echoes.current.remember(text); callbacks.current.onChange(text);
      }
    });
    const saveAction = viewer.current.getEditors().modified.addAction({
      id: 'smartDiff.saveFile', label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], precondition: '!editorReadonly',
      run: () => { if (callbacks.current.editable) callbacks.current.onSave?.(); },
    });
    if (pendingView.current) viewer.current.restoreViewState(pendingView.current);
    callbacks.current.onViewer?.(viewer.current);
    const unsubscribe = subscribeSettings(() => viewer.current?.updateOptions({ editorOptions: editorAppearance() }));
    return () => {
      unsubscribe();
      contentListener.dispose(); saveAction.dispose();
      if (viewer.current?.getComparison()) pendingView.current = viewer.current.saveViewState();
      callbacks.current.onViewer?.(null);
      viewer.current?.dispose(); viewer.current = null;
    };
  }, [viewMode]);
  // View switches replace editor widgets, while the two source models retain
  // their exact text, undo stacks and live editing-buffer subscription.
  useEffect(() => () => {
    models.current?.original.dispose(); models.current?.modified.dispose(); models.current = null;
    echoes.current.clear();
  }, []);
  useEffect(() => {
    const previous = lastPreferences.current;
    // Pointer resizing is already applied by the package in its animation frame.
    // Persisting the ratio in React must not rebuild folds/geometry a second time.
    const presentationChanged = (['layout', 'sync', 'collapse', 'whitespace', 'wrap'] as const).some(key => previous[key] !== preferences[key]);
    const { splitRatio, ...presentation } = viewerOptions(preferences);
    const resizedExternally = previous.splitRatio !== preferences.splitRatio && splitRatio !== actualSplitRatio.current;
    if (presentationChanged || resizedExternally) viewer.current?.updateOptions({ ...(presentationChanged ? presentation : {}), ...(resizedExternally ? { splitRatio } : {}) });
    lastPreferences.current = preferences;
  }, [preferences]);
  useEffect(() => {
    if (lastEditable.current === editable) return;
    lastEditable.current = editable;
    viewer.current?.updateOptions({ modifiedEditable: editable });
  }, [editable]);
  useEffect(() => {
    const owned = models.current;
    if (!owned) return;
    const previous = sourceProps.current;
    sourceProps.current = { original, modified, path };
    const changedPath = previous.path !== path;
    if (changedPath) echoes.current.clear();
    const modifiedEcho = !changedPath && previous.modified !== modified && echoes.current.acknowledge(modified);
    if (changedPath) {
      monaco.editor.setModelLanguage(owned.original, languageForPath(path, original.slice(0, 512)));
      monaco.editor.setModelLanguage(owned.modified, languageForPath(path, modified.slice(0, 512)));
    }
    // An unchanged prop is not a request to discard an edited model. When a
    // parent echoes onChange, equal model text also keeps Monaco's undo stack.
    const originalChanged = (changedPath || previous.original !== original) && owned.original.getValue() !== original;
    const modifiedChanged = (changedPath || previous.modified !== modified) && !modifiedEcho && owned.modified.getValue() !== modified;
    // setValue resets Monaco's cursor before the worker can restore the new
    // comparison. Capture the reading position before an external reload.
    const view = (originalChanged || modifiedChanged) ? viewer.current?.saveViewState() : undefined;
    updatingModels.current = true;
    try {
      if (originalChanged) owned.original.setValue(original);
      if ((changedPath || previous.modified !== modified) && !modifiedEcho) {
        echoes.current.clear();
        if (owned.modified.getValue() !== modified) owned.modified.setValue(modified);
      }
    } finally {
      updatingModels.current = false;
      if (view) viewer.current?.restoreViewState(view);
    }
  }, [original, modified, path]);
  return <div className="diff-surface" ref={container} data-testid="diff-surface" data-editable={editable} />;
}
function viewerOptions(preferences: ViewerPreferences): Partial<SmartDiffOptions> {
  return {
    viewMode: preferences.viewMode ?? 'side-by-side',
    layout: preferences.layout, synchronizeScrolling: preferences.sync, ignoreTrimWhitespace: preferences.whitespace, splitRatio: preferences.splitRatio ?? 0.5,
    unchangedRegions: { collapse: preferences.collapse, contextLines: 3, minimumHiddenLines: 6 },
    editorOptions: { ...editorAppearance(), wordWrap: preferences.wrap ? 'on' : 'off' },
  };
}
