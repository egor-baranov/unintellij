import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Comparison, Side } from '../diff/model';
import { deriveCollapsedRegions } from '../folding/regions';
import { captureAnchor, restoreAnchor, type CodeEditor } from '../rendering/geometry';
import type { SmartDiff, SmartDiffOptions, UpdateOptions, ViewState, ViewerState } from '../types';
import { nativeComparison } from './comparison';

const sides = ['original', 'modified'] as const;
interface NativeResult { quitEarly?: boolean }
interface NativeResultEditor { getDiffComputationResult(): NativeResult | null }
interface NativeBulkFoldingEditor { collapseAllUnchangedRegions(): void; showAllUnchangedRegions(): void }
function hasNativeResult(editor: object): editor is NativeResultEditor {
  return 'getDiffComputationResult' in editor && typeof editor.getDiffComputationResult === 'function';
}
function hasNativeBulkFolding(editor: object): editor is NativeBulkFoldingEditor {
  return 'collapseAllUnchangedRegions' in editor && typeof editor.collapseAllUnchangedRegions === 'function'
    && 'showAllUnchangedRegions' in editor && typeof editor.showAllUnchangedRegions === 'function';
}

/** The actual inline rows, original-text view zones, editing and selection are
 * owned by Monaco. Its diff worker is the only computation running in this mode. */
export class InlineController implements SmartDiff {
  private readonly root = document.createElement('div');
  private readonly statusNode = document.createElement('div');
  private readonly editor: Monaco.editor.IStandaloneDiffEditor;
  private readonly editors: Record<Side, CodeEditor>;
  private readonly observer: ResizeObserver;
  private readonly listeners: Monaco.IDisposable[] = [];
  private modelListeners: Monaco.IDisposable[] = [];
  private model: Monaco.editor.IDiffEditorViewModel;
  private comparison?: Comparison;
  private state: ViewerState = { status: 'loading', changeCount: 0, currentChange: -1 };
  private generation = 0;
  private acceptedGeneration = -1;
  private disposed = false;
  private frame = 0;
  private started = performance.now();
  private pendingRestore?: ViewState;
  private pendingBulkExpansion?: boolean;
  private expandedRegions: string[] = [];
  private splitRatio: number;

  constructor(container: HTMLElement, private options: SmartDiffOptions) {
    this.splitRatio = options.splitRatio ?? .5;
    this.root.className = 'smart-diff smart-diff-inline';
    this.root.dataset.viewMode = 'inline';
    const surface = document.createElement('div');
    surface.className = 'smart-diff-inline-surface';
    this.statusNode.className = 'smart-diff-status';
    this.statusNode.setAttribute('role', 'status');
    this.root.append(surface, this.statusNode); container.append(this.root);
    this.editor = options.monaco.editor.createDiffEditor(surface, this.nativeOptions());
    this.editors = { original: this.editor.getOriginalEditor(), modified: this.editor.getModifiedEditor() };
    this.model = this.editor.createViewModel({ original: options.original, modified: options.modified });
    this.editor.setModel(this.model);
    this.listeners.push(this.editor.onDidUpdateDiff(() => this.acceptWhenReady()));
    this.observer = new ResizeObserver(() => {
      if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.layout(); });
    });
    this.observer.observe(container);
    this.bindModels(); this.layout(); this.invalidate();
  }

  private nativeOptions(): Monaco.editor.IStandaloneDiffEditorConstructionOptions {
    const regions = { collapse: true, contextLines: 3, minimumHiddenLines: 6, ...this.options.unchangedRegions };
    return {
      fontSize: 16, lineHeight: 23, fontWeight: '400', letterSpacing: 0,
      fontFamily: '"JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
      minimap: { enabled: false }, stickyScroll: { enabled: false }, scrollBeyondLastLine: false,
      automaticLayout: false, folding: false, glyphMargin: false, renderLineHighlight: 'none',
      overviewRulerLanes: 0, hideCursorInOverviewRuler: true, padding: { top: 0, bottom: 0 },
      guides: { indentation: false, bracketPairs: false }, wordWrap: 'off', smoothScrolling: false,
      contextmenu: true, renderWhitespace: 'selection',
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, alwaysConsumeMouseWheel: false, useShadows: false },
      ...this.options.editorOptions,
      readOnly: !this.options.modifiedEditable, domReadOnly: !this.options.modifiedEditable,
      originalEditable: false, renderSideBySide: false, useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: false, renderOverviewRuler: false,
      renderMarginRevertIcon: false, renderGutterMenu: false, renderIndicators: true,
      diffCodeLens: false, diffAlgorithm: 'advanced', diffWordWrap: 'inherit',
      ignoreTrimWhitespace: this.options.ignoreTrimWhitespace ?? false,
      maxComputationTime: this.options.maxComputationTimeMs ?? 1500,
      hideUnchangedRegions: { enabled: regions.collapse, contextLineCount: regions.contextLines, minimumLineCount: regions.minimumHiddenLines, revealLineCount: regions.contextLines },
      originalAriaLabel: 'Original comparison content, read only',
      modifiedAriaLabel: 'Inline comparison, modified content',
    };
  }

  private bindModels(): void {
    this.modelListeners.forEach(listener => listener.dispose());
    this.modelListeners = sides.map(side => this.options[side].onDidChangeContent(() => {
      // Do not restore pre-keystroke selections when the asynchronous result
      // arrives: Monaco owns cursor tracking and undo on the unchanged model.
      this.pendingRestore = undefined;
      this.invalidate();
    }));
  }
  private invalidate(): void {
    this.generation++; this.started = performance.now(); this.comparison = undefined;
    this.emit({ status: 'loading', changeCount: 0, currentChange: -1 });
    this.acceptWhenReady();
  }
  private acceptWhenReady(): void {
    const generation = this.generation, model = this.model;
    const originalVersion = this.options.original.getVersionId(), modifiedVersion = this.options.modified.getVersionId();
    void model.waitForDiff().then(() => {
      if (this.disposed || this.model !== model || generation !== this.generation || this.acceptedGeneration === generation || originalVersion !== this.options.original.getVersionId() || modifiedVersion !== this.options.modified.getVersionId()) return;
      const lines = this.editor.getLineChanges();
      if (!lines) return;
      this.acceptedGeneration = generation;
      // quitEarly is not yet in Monaco's public declarations; this optional
      // capability is verified against 0.55.1 and never required for rendering.
      const quitEarly = hasNativeResult(this.editor) && this.editor.getDiffComputationResult()?.quitEarly === true;
      this.comparison = nativeComparison(lines, { requestId: generation, originalVersion, modifiedVersion, original: this.options.original.getValue(), modified: this.options.modified.getValue(), ignoreTrimWhitespace: this.options.ignoreTrimWhitespace ?? false, maxComputationTimeMs: this.options.maxComputationTimeMs ?? 1500 }, quitEarly, performance.now() - this.started);
      this.emit({ status: quitEarly ? 'timeout' : lines.length ? 'ready' : 'empty', changeCount: this.comparison.changes.length, currentChange: this.comparison.changes.length ? 0 : -1, message: quitEarly ? 'Computation limit reached; the displayed comparison is incomplete.' : undefined });
      if (this.pendingBulkExpansion !== undefined) {
        const saved = this.pendingRestore ?? this.saveViewState(), expanded = this.pendingBulkExpansion;
        this.pendingRestore = undefined; this.pendingBulkExpansion = undefined;
        this.setAllRegionsExpanded(expanded, saved);
      } else if (this.pendingRestore) { const saved = this.pendingRestore; this.pendingRestore = undefined; this.restoreViewState(saved); }
    }).catch(error => {
      if (!this.disposed && this.model === model && generation === this.generation) this.emit({ status: 'error', changeCount: 0, currentChange: -1, message: error instanceof Error ? error.message : 'Unable to compute this comparison.' });
    });
  }
  private emit(state: ViewerState): void {
    if (this.disposed) return;
    this.state = state; this.root.dataset.status = state.status;
    this.statusNode.textContent = state.message ?? (state.status === 'loading' ? 'Computing differences…' : state.status === 'empty' ? 'No differences' : '');
    this.statusNode.hidden = !this.statusNode.textContent;
    this.options.onStateChange?.({ ...state });
  }
  layout(): void { if (!this.disposed) this.editor.layout(); }
  updateOptions(options: UpdateOptions): void {
    if (this.disposed) return;
    const recompute = options.ignoreTrimWhitespace !== undefined && options.ignoreTrimWhitespace !== this.options.ignoreTrimWhitespace || options.maxComputationTimeMs !== undefined && options.maxComputationTimeMs !== this.options.maxComputationTimeMs;
    this.options = { ...this.options, ...options, editorOptions: { ...this.options.editorOptions, ...options.editorOptions }, unchangedRegions: { ...this.options.unchangedRegions, ...options.unchangedRegions } };
    if (options.splitRatio !== undefined) this.splitRatio = options.splitRatio;
    this.editor.updateOptions(this.nativeOptions());
    if (recompute) this.invalidate();
  }
  setModels(models: Pick<SmartDiffOptions, 'original' | 'modified'>): void {
    if (this.disposed) return;
    this.generation++; this.pendingRestore = undefined; this.pendingBulkExpansion = undefined; this.expandedRegions = [];
    this.options = { ...this.options, ...models };
    const previous = this.model;
    this.model = this.editor.createViewModel(models); this.editor.setModel(this.model); previous.dispose();
    this.bindModels(); this.invalidate();
  }
  saveViewState(): ViewState {
    const regions = this.comparison ? deriveCollapsedRegions(this.comparison, { contextLines: this.options.unchangedRegions?.contextLines ?? 3, minimumHiddenLines: this.options.unchangedRegions?.minimumHiddenLines ?? 6 }) : [];
    // Native controls can also expand a region. Derive canonical IDs from real
    // visible model lines rather than screen/widget indices.
    if (this.options.unchangedRegions?.collapse !== false) this.expandedRegions = regions.filter(region => this.editors.modified.getLineHeightForPosition({ lineNumber: region.modified.start, column: 1 }) > 0 && this.editors.modified.getLineHeightForPosition({ lineNumber: region.modified.end - 1, column: 1 }) > 0).map(region => region.id);
    return { original: { anchor: captureAnchor(this.editors.original), selections: this.editors.original.getSelections() }, modified: { anchor: captureAnchor(this.editors.modified), selections: this.editors.modified.getSelections() }, currentChangeId: this.comparison?.changes[this.state.currentChange]?.id, expandedRegions: [...this.expandedRegions], splitRatio: this.splitRatio };
  }
  restoreViewState(state: ViewState): void {
    if (this.disposed) return;
    if (!this.comparison) this.pendingRestore = state;
    this.expandedRegions = [...state.expandedRegions];
    this.splitRatio = state.splitRatio ?? this.splitRatio;
    this.restoreExpandedRegions();
    for (const side of sides) {
      if (state[side].selections?.length) this.editors[side].setSelections(state[side].selections!);
      restoreAnchor(this.editors[side], state[side].anchor);
    }
    const currentChange = this.comparison?.changes.findIndex(change => change.id === state.currentChangeId) ?? -1;
    if (currentChange >= 0) this.emit({ ...this.state, currentChange });
  }
  private restoreExpandedRegions(): void {
    if (!this.comparison || !this.expandedRegions.length) return;
    const expanded = new Set(this.expandedRegions);
    const regions = deriveCollapsedRegions(this.comparison, { contextLines: this.options.unchangedRegions?.contextLines ?? 3, minimumHiddenLines: this.options.unchangedRegions?.minimumHiddenLines ?? 6 }).filter(region => expanded.has(region.id));
    const native = this.editor.saveViewState();
    if (!native?.modelState || typeof native.modelState !== 'object' || !('collapsedRegions' in native.modelState) || !Array.isArray(native.modelState.collapsedRegions)) return;
    // Pinned Monaco 0.55.1 serializes hidden modified ranges as [start, end).
    // Guard its optional model state; never access generated DOM or view models.
    const collapsedRegions = native.modelState.collapsedRegions.map((value: unknown) => {
      if (!value || typeof value !== 'object' || !('range' in value) || !Array.isArray(value.range)) return value;
      const [start, end] = value.range;
      if (typeof start !== 'number' || typeof end !== 'number') return value;
      return regions.some(region => region.modified.start < end && start < region.modified.end) ? { range: [start, start] } : value;
    });
    this.editor.restoreViewState({ ...native, modelState: { collapsedRegions } });
  }
  expandRegion(id: string): void {
    if (this.disposed) return;
    const state = this.saveViewState(); state.expandedRegions.push(id); this.restoreViewState(state);
  }
  expandAllRegions(): void { this.setAllRegionsExpanded(true); }
  collapseAllRegions(): void { this.setAllRegionsExpanded(false); }
  private setAllRegionsExpanded(expanded: boolean, saved?: ViewState): void {
    if (this.disposed) return;
    const state = { ...(saved ?? this.pendingRestore ?? this.saveViewState()) };
    const enableFolding = this.options.unchangedRegions?.collapse === false;
    this.options.unchangedRegions = { ...this.options.unchangedRegions, collapse: true };
    if (enableFolding) this.editor.updateOptions(this.nativeOptions());
    if (!this.comparison) {
      this.pendingBulkExpansion = expanded; this.pendingRestore = state;
      return;
    }
    const regions = deriveCollapsedRegions(this.comparison, { contextLines: this.options.unchangedRegions.contextLines ?? 3, minimumHiddenLines: this.options.unchangedRegions.minimumHiddenLines ?? 6 });
    state.expandedRegions = expanded ? regions.map(region => region.id) : [];
    // Monaco 0.55.1 exposes these operations on its diff widget. Keep the
    // optional capability guarded, with public folding options as a fallback.
    if (hasNativeBulkFolding(this.editor)) {
      if (expanded) this.editor.showAllUnchangedRegions();
      else this.editor.collapseAllUnchangedRegions();
    } else {
      // Disabling native folding resets its manually revealed region state.
      this.editor.updateOptions({ hideUnchangedRegions: { enabled: false } });
      this.editor.updateOptions(this.nativeOptions());
    }
    this.restoreViewState(state);
  }
  goToChange(id: string): void {
    const index = this.comparison?.changes.findIndex(change => change.id === id) ?? -1;
    if (this.disposed || index < 0 || !this.comparison) return;
    const change = this.comparison.changes[index];
    this.emit({ ...this.state, currentChange: index });
    const line = Math.min(this.options.modified.getLineCount(), change.modified.start);
    const editor = this.editors.modified;
    editor.setPosition({ lineNumber: line, column: 1 });
    if (change.kind === 'delete') {
      // Deleted lines have no modified model positions. Center their actual
      // native view zone, including BOF/EOF deletions and wrapped original text.
      const atEnd = change.modified.start > this.options.modified.getLineCount();
      const top = atEnd ? editor.getBottomForLineNumber(line) : editor.getTopForLineNumber(line, true);
      const bottom = atEnd ? editor.getScrollHeight() : editor.getTopForLineNumber(line);
      if (bottom > top) {
        const height = editor.getLayoutInfo().height;
        editor.setScrollTop(Math.max(0, top + Math.min(bottom - top, height) / 2 - height / 2), this.options.monaco.editor.ScrollType.Immediate);
        return;
      }
    }
    editor.revealLineInCenter(line, this.options.monaco.editor.ScrollType.Immediate);
  }
  nextChange(): void { const changes = this.comparison?.changes; if (changes?.length) this.goToChange(changes[(this.state.currentChange + 1) % changes.length].id); }
  previousChange(): void { const changes = this.comparison?.changes; if (changes?.length) this.goToChange(changes[(this.state.currentChange - 1 + changes.length) % changes.length].id); }
  getState(): ViewerState { return { ...this.state }; }
  getComparison(): Comparison | undefined { return this.comparison; }
  getEditors(): Record<Side, CodeEditor> { return this.editors; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; cancelAnimationFrame(this.frame); this.observer.disconnect();
    this.modelListeners.forEach(listener => listener.dispose()); this.listeners.forEach(listener => listener.dispose());
    this.editor.dispose(); this.model.dispose(); this.root.remove();
  }
}
