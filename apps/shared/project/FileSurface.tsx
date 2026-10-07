import { useEffect, useRef } from 'react';
import { monaco, languageForPath } from '../monaco';
import { editorAppearance } from '../settings/runtime';
import { subscribeSettings } from '../settings/store';
import { ModelEchoes } from '../modelEchoes';
import { decodeFileViewState } from '../workspace/viewState';
import { HiddenAreasAdapter } from '../../../packages/monaco-smart-diff/src/compatibility/monaco';
import './project.css';
import './added-file.css';

const savedViews = new Map<string, monaco.editor.ICodeEditorViewState>();
export interface FileSurfaceProps {
  path: string;
  text: string;
  wrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  /** Highlight a newly added file as one document, without creating a comparison. */
  added?: boolean;
  /** Show the original contents of a deleted file as one read-only document. */
  deleted?: boolean;
  /** Include a repository identifier to keep same-named files independent. */
  stateKey?: string;
  restoreState?: monaco.editor.ICodeEditorViewState;
  onEditor?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  editable?: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
}

/** Ordinary file view, read-only by default. Models and editors are owned here. */
export function FileSurface({ path, text, wrap = false, onWrapChange, added = false, deleted = false, stateKey = path, restoreState, onEditor, editable: requestedEditable = false, onChange, onSave }: FileSurfaceProps) {
  const editable = requestedEditable && !deleted;
  const change = deleted ? 'deleted' : added ? 'added' : undefined;
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const refreshChangeDecorations = useRef<(() => void) | null>(null);
  const values = useRef({ path, text, wrap, onWrapChange, change, restoreState, onEditor, editable, onChange, onSave });
  values.current = { path, text, wrap, onWrapChange, change, restoreState, onEditor, editable, onChange, onSave };
  const sourceProps = useRef({ path, text, stateKey });
  const updatingModel = useRef(false);
  const echoes = useRef(new ModelEchoes());

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const initial = values.current;
    const model = monaco.editor.createModel(initial.text, languageForPath(initial.path, initial.text.slice(0, 512)));
    const instance = monaco.editor.create(element, {
      ...editorAppearance(), model, readOnly: !initial.editable, domReadOnly: !initial.editable,
      wordWrap: initial.wrap ? 'on' : 'off', automaticLayout: false,
      lineNumbers: 'on', lineNumbersMinChars: 4, glyphMargin: false,
      folding: false, scrollBeyondLastLine: false,
      ariaLabel: `File contents: ${initial.path}`, renderValidationDecorations: 'off',
    });
    const saveAction = instance.addAction({
      id: 'smartDiff.saveFile', label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], precondition: '!editorReadonly',
      run: () => { if (values.current.editable) values.current.onSave?.(); },
    });
    editor.current = instance;
    // Standalone Monaco does not ship the workbench's word-wrap command.
    // Keep this ordinary editor action available without a dedicated toolbar row.
    const wrapAction = instance.addAction({
      id: 'editor.action.toggleWordWrap', label: 'Toggle Word Wrap',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      contextMenuGroupId: 'view', contextMenuOrder: 1,
      run: () => {
        const next = instance.getOption(monaco.editor.EditorOption.wordWrap) === 'off';
        instance.updateOptions({ wordWrap: next ? 'on' : 'off' });
        values.current.onWrapChange?.(next);
      },
    });
    const changeDecorations = instance.createDecorationsCollection();
    // Reuse the pinned Monaco compatibility boundary; never trim the model or
    // hide generated DOM rows with CSS. Only whole-file change presentation omits the
    // terminal display row, so intentional blank content remains highlighted.
    const terminalRow = new HiddenAreasAdapter(instance);
    const decorateChangedLines = () => {
      terminalRow.clear();
      const kind = values.current.change;
      if (!kind || !model.getValueLength()) { changeDecorations.clear(); return; }
      let lastLine = model.getLineCount();
      // Monaco represents a terminating line break with a final empty editor line.
      // It is not an extra changed content line; real blank lines before it stay highlighted.
      if (lastLine > 1 && model.getLineContent(lastLine) === '') {
        if (!values.current.editable) terminalRow.set([{ start: lastLine, end: lastLine + 1 }]);
        lastLine--;
      }
      changeDecorations.set([{
        range: new monaco.Range(1, 1, lastLine, model.getLineMaxColumn(lastLine)),
        options: {
          isWholeLine: true, shouldFillLineOnLineBreak: true,
          className: `${kind}-file-line`, marginClassName: `${kind}-file-margin`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }]);
    };
    refreshChangeDecorations.current = decorateChangedLines;
    decorateChangedLines();
    const contentListener = model.onDidChangeContent(() => {
      decorateChangedLines();
      if (!updatingModel.current && values.current.editable && values.current.onChange) {
        const text = model.getValue();
        echoes.current.remember(text); values.current.onChange(text);
      }
    });
    let pendingView = decodeFileViewState(initial.restoreState ?? savedViews.get(stateKey));
    let registered = false;
    const registerEditor = () => {
      if (registered) return;
      registered = true;
      values.current.onEditor?.(instance);
    };
    const finishRestoring = () => { pendingView = undefined; registerEditor(); };
    // Keep durable cursor/viewport/folding state across tabs and reappearance.
    // Transient contribution state (notably delayed occurrence highlights)
    // belongs to the old editor and must not replay against the new model.
    const restorePendingView = () => {
      if (!pendingView || !element.clientWidth || !element.clientHeight) return false;
      instance.layout();
      instance.restoreViewState(pendingView);
      // Monaco initially knows only the widths of the previous rendered lines.
      // Restoring a vertical position can therefore clamp scrollLeft to zero.
      // Paint the restored viewport to measure its lines, then apply X again.
      instance.render(true);
      instance.setScrollLeft(pendingView.viewState.scrollLeft, monaco.editor.ScrollType.Immediate);
      instance.render(true);
      return true;
    };
    restorePendingView();
    if (!pendingView) registerEditor();
    // A real gesture owns the position from this point on; a later layout must
    // never replay the initial selection over typing, clicking or scrolling.
    const inputEvents = ['pointerdown', 'wheel', 'keydown'] as const;
    for (const event of inputEvents) element.addEventListener(event, finishRestoring, { capture: true, passive: true });
    let frame = 0;
    const scheduleLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!element.clientWidth || !element.clientHeight) return;
        if (pendingView) {
          // Keep live persistence detached until the first visible layout has
          // completed. A hidden split retains its requested view until shown.
          if (restorePendingView()) finishRestoring();
        } else instance.layout();
      });
    };
    const resize = new ResizeObserver(scheduleLayout);
    resize.observe(element);
    scheduleLayout();
    const unsubscribe = subscribeSettings(() => {
      const line = instance.getVisibleRanges()[0]?.startLineNumber ?? 1;
      const oldHeight = instance.getOption(monaco.editor.EditorOption.lineHeight);
      const offset = (instance.getTopForLineNumber(line) - instance.getScrollTop()) / oldHeight;
      instance.updateOptions({ ...editorAppearance(), readOnly: !values.current.editable, domReadOnly: !values.current.editable });
      instance.layout();
      instance.setScrollTop(instance.getTopForLineNumber(line) - offset * instance.getOption(monaco.editor.EditorOption.lineHeight));
    });
    return () => {
      unsubscribe();
      const state = pendingView ?? instance.saveViewState();
      if (state) {
        savedViews.delete(stateKey); savedViews.set(stateKey, state);
        if (savedViews.size > 100) savedViews.delete(savedViews.keys().next().value!);
      }
      if (registered) values.current.onEditor?.(null);
      for (const event of inputEvents) element.removeEventListener(event, finishRestoring, true);
      cancelAnimationFrame(frame); resize.disconnect();
      wrapAction.dispose(); saveAction.dispose(); contentListener.dispose(); terminalRow.clear(); changeDecorations.clear(); refreshChangeDecorations.current = null;
      instance.dispose(); model.dispose(); editor.current = null; echoes.current.clear();
    };
  }, [stateKey]);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    const previous = sourceProps.current;
    sourceProps.current = { path, text, stateKey };
    const changedDocument = previous.path !== path || previous.stateKey !== stateKey;
    if (changedDocument) echoes.current.clear();
    const echo = !changedDocument && previous.text !== text && echoes.current.acknowledge(text);
    if ((previous.text !== text || changedDocument) && !echo) {
      echoes.current.clear();
      // The editor stays mounted during a reload. Restore only its reading
      // position; replaying contribution state restarts Monaco's delayed word
      // highlighter and rapid updates can cancel its unhandled restore promise.
      const selections = instance.getSelections();
      const scroll = { scrollTop: instance.getScrollTop(), scrollLeft: instance.getScrollLeft() };
      updatingModel.current = true;
      try { if (model.getValue() !== text) model.setValue(text); } finally { updatingModel.current = false; }
      if (selections?.length) instance.setSelections(selections);
      instance.setScrollPosition(scroll, monaco.editor.ScrollType.Immediate);
    }
    monaco.editor.setModelLanguage(model, languageForPath(path, model.getLineContent(1)));
    instance.updateOptions({ ariaLabel: `File contents: ${path}` });
  }, [text, path, stateKey]);

  useEffect(() => { editor.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off', readOnly: !editable, domReadOnly: !editable }); }, [wrap, editable, stateKey]);

  useEffect(() => { refreshChangeDecorations.current?.(); }, [change, editable, stateKey]);

  return <div ref={container} className={`file-surface${change ? ` file-surface-${change}` : ''}`} data-testid="file-surface" data-path={path} data-added={change === 'added' ? 'true' : undefined} data-deleted={change === 'deleted' ? 'true' : undefined} data-editable={editable} />;
}
