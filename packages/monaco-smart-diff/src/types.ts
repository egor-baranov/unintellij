import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Comparison } from './diff/model';
export type { Comparison, Change, Side, LineRange } from './diff/model';
export interface UnchangedRegionOptions { collapse: boolean; contextLines: number; minimumHiddenLines: number }
export interface ViewerState {
  status: 'loading' | 'ready' | 'empty' | 'error' | 'timeout';
  changeCount: number;
  /** Zero-based index, or -1 when none is active. */
  currentChange: number;
  message?: string;
  featureUnavailable?: string[];
}
export interface SmartDiffOptions {
  monaco: typeof Monaco;
  original: Monaco.editor.ITextModel;
  modified: Monaco.editor.ITextModel;
  /** Allow ordinary editing of the modified model. The original is always read-only. */
  modifiedEditable?: boolean;
  /** Construction-time presentation. Switching modes can reuse the same consumer-owned models. */
  viewMode?: 'side-by-side' | 'inline';
  layout?: 'compact' | 'aligned';
  /** Original pane's share of editor space, excluding the central gutter. Default 0.5. */
  splitRatio?: number;
  /** Called when the effective split changes, including a narrow-container clamp. */
  onSplitRatioChange?: (ratio: number) => void;
  synchronizeScrolling?: boolean;
  ignoreTrimWhitespace?: boolean;
  unchangedRegions?: Partial<UnchangedRegionOptions>;
  maxComputationTimeMs?: number;
  workerFactory?: () => Worker;
  editorOptions?: Monaco.editor.IStandaloneEditorConstructionOptions;
  onStateChange?: (state: ViewerState) => void;
}
export type UpdateOptions = Partial<Pick<SmartDiffOptions, 'modifiedEditable' | 'layout' | 'splitRatio' | 'onSplitRatioChange' | 'synchronizeScrolling' | 'ignoreTrimWhitespace' | 'unchangedRegions' | 'maxComputationTimeMs' | 'editorOptions'>>;
export interface ReadingAnchor { line: number; offset: number; scrollLeft: number }
export interface ViewState {
  original: { anchor: ReadingAnchor; selections: Monaco.ISelection[] | null };
  modified: { anchor: ReadingAnchor; selections: Monaco.ISelection[] | null };
  expandedRegions: string[];
  currentChangeId?: string;
  /** Optional so states saved by earlier versions remain compatible. */
  splitRatio?: number;
}
export interface SmartDiff {
  nextChange(): void;
  previousChange(): void;
  goToChange(changeId: string): void;
  updateOptions(options: UpdateOptions): void;
  setModels(models: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel }): void;
  saveViewState(): ViewState;
  restoreViewState(state: ViewState): void;
  layout(): void;
  dispose(): void;
  getState(): ViewerState;
  getComparison(): Comparison | undefined;
  /** Editor integrations/testing. Models remain consumer-owned. */
  getEditors(): { original: Monaco.editor.IStandaloneCodeEditor; modified: Monaco.editor.IStandaloneCodeEditor };
  expandRegion(id: string): void;
  /** Reveal every unchanged region while retaining folding and reading state. */
  expandAllRegions(): void;
  /** Collapse every unchanged region, including previously expanded regions. */
  collapseAllRegions(): void;
}
