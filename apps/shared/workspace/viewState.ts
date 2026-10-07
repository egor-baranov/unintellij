import type { editor, IPosition, ISelection, IDisposable } from 'monaco-editor';
import type { SmartDiff, ViewState } from 'monaco-smart-diff';
import type { ViewerPreferences } from '../DiffSurface';
import { decodeMediaView, getMediaView, restoreMediaView, subscribeMediaViews, type MediaViewState } from '../media/viewState';
import { decodeMarkdownView, type MarkdownViewState } from '../markdown/viewState';

export interface SavedTab {
  file?: editor.ICodeEditorViewState;
  diff?: ViewState;
  media?: MediaViewState;
  markdown?: MarkdownViewState;
  preferences?: ViewerPreferences;
}

const maximumViews = 200;
const maximumItems = 1000;
const maximumPosition = 10_000_000;
const maximumOffset = 1_000_000_000;
const foldingContribution = 'editor.contrib.folding';
const saved = new Map<string, SavedTab>();
const liveFiles = new Map<string, editor.IStandaloneCodeEditor>();
const liveDiffs = new Map<string, { viewer: SmartDiff; initialized: boolean }>();
const listeners = new Set<() => void>();
let notification: ReturnType<typeof setTimeout> | undefined;
subscribeMediaViews(changed);

function changed() {
  if (!listeners.size || notification) return;
  // Throttle continuous scrolling so a long gesture is still persisted, while
  // coalescing Monaco's paired scroll/layout/cursor notifications.
  notification = setTimeout(() => {
    notification = undefined;
    for (const listener of listeners) listener();
  }, 150);
}

export function subscribeWorkspaceViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearTimeout(notification); notification = undefined; }
  };
}

export function rememberWorkspaceView(id: string, value: SavedTab): void {
  const previous = saved.get(id);
  saved.delete(id);
  saved.set(id, { ...previous, ...value });
  if (saved.size > maximumViews) saved.delete(saved.keys().next().value!);
  changed();
}

/** Capture live editors synchronously, including the last scroll before unload. */
export function getWorkspaceView(id: string): SavedTab | undefined {
  const previous = saved.get(id);
  const file = liveFiles.get(id)?.saveViewState();
  const liveDiff = liveDiffs.get(id);
  // While its first worker is pending, a restored diff has no current hunk and
  // may not have laid out its folded regions yet. Keep the requested view.
  if (liveDiff && liveDiff.viewer.getComparison()) liveDiff.initialized = true;
  const diff = liveDiff && (liveDiff.initialized || !previous?.diff) ? liveDiff.viewer.saveViewState() : undefined;
  const media = getMediaView(`tab:${id}`);
  return decodeTab({ ...previous, ...(file ? { file } : {}), ...(diff ? { diff } : {}), ...(media ? { media } : {}) });
}

export function captureWorkspaceViews(instanceIds: Iterable<string>): Record<string, SavedTab> {
  const result: Record<string, SavedTab> = {};
  let count = 0;
  for (const id of instanceIds) {
    if (count >= maximumViews) break;
    if (!validId(id)) continue;
    const state = getWorkspaceView(id);
    if (state) { result[id] = state; count++; }
  }
  return result;
}

/** Merge a repository session before mounting its tabs; other repos may be open. */
export function restoreWorkspaceViews(value: unknown): void {
  for (const [id, state] of Object.entries(decodeWorkspaceViews(value))) {
    saved.delete(id); saved.set(id, state);
    if (state.media) restoreMediaView(`tab:${id}`, state.media);
  }
  while (saved.size > maximumViews) saved.delete(saved.keys().next().value!);
}

function listen(instance: editor.IStandaloneCodeEditor): IDisposable[] {
  return [
    instance.onDidScrollChange(changed), instance.onDidChangeCursorSelection(changed),
    instance.onDidChangeHiddenAreas(changed), instance.onDidLayoutChange(changed),
  ];
}

/** The returned cleanup must run before disposing the editor. */
export function trackWorkspaceFile(id: string, instance: editor.IStandaloneCodeEditor): () => void {
  liveFiles.set(id, instance);
  const subscriptions = listen(instance);
  changed();
  return () => {
    subscriptions.forEach(subscription => subscription.dispose());
    if (liveFiles.get(id) !== instance) return;
    const file = decodeFileViewState(instance.saveViewState());
    liveFiles.delete(id);
    if (file) rememberWorkspaceView(id, { file });
  };
}

/** The returned cleanup must run before disposing the viewer. */
export function trackWorkspaceDiff(id: string, viewer: SmartDiff): () => void {
  const live = { viewer, initialized: !!viewer.getComparison() };
  liveDiffs.set(id, live);
  const editors = viewer.getEditors();
  const subscriptions = [...listen(editors.original), ...listen(editors.modified)];
  changed();
  return () => {
    subscriptions.forEach(subscription => subscription.dispose());
    if (liveDiffs.get(id) !== live) return;
    const diff = getWorkspaceView(id)?.diff;
    liveDiffs.delete(id);
    if (diff) rememberWorkspaceView(id, { diff });
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function integer(value: unknown, min = 1, max = maximumPosition): value is number {
  return number(value, min, max) && Number.isInteger(value);
}
function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}
function position(value: unknown): IPosition | undefined {
  const input = object(value);
  return input && integer(input.lineNumber) && integer(input.column) ? { lineNumber: input.lineNumber, column: input.column } : undefined;
}

/** Only folding belongs to the durable contribution state. Find/highlight and
 * other contribution snapshots can refer to a model disposed before reload. */
function folding(value: unknown): Record<string, unknown> | undefined {
  const input = object(value);
  if (!input) return;
  const collapsedRegions = Array.isArray(input.collapsedRegions) ? input.collapsedRegions.slice(0, maximumItems).flatMap(value => {
    const region = object(value);
    if (!region || !integer(region.startLineNumber) || !integer(region.endLineNumber) || region.endLineNumber <= region.startLineNumber) return [];
    return [{
      startLineNumber: region.startLineNumber, endLineNumber: region.endLineNumber,
      isCollapsed: typeof region.isCollapsed === 'boolean' ? region.isCollapsed : true,
      ...(integer(region.source, 0, 2) ? { source: region.source } : {}),
      ...(integer(region.checksum, -1_000_000, 1_000_000) ? { checksum: region.checksum } : {}),
    }];
  }) : [];
  return { collapsedRegions, ...(integer(input.lineCount) ? { lineCount: input.lineCount } : {}), foldedImports: input.foldedImports === true };
}

export function decodeFileViewState(value: unknown): editor.ICodeEditorViewState | undefined {
  const input = object(value), view = object(input?.viewState);
  const firstPosition = position(view?.firstPosition);
  if (!input || !view || !firstPosition || !number(view.scrollLeft, 0, maximumOffset) || !number(view.firstPositionDeltaTop, -maximumOffset, maximumOffset) || !Array.isArray(input.cursorState)) return;
  const cursorState = input.cursorState.slice(0, maximumItems).flatMap(value => {
    const cursor = object(value), selectionStart = position(cursor?.selectionStart), current = position(cursor?.position);
    return cursor && selectionStart && current ? [{ inSelectionMode: cursor.inSelectionMode === true, selectionStart, position: current }] : [];
  });
  const folded = folding(object(input.contributionsState)?.[foldingContribution]);
  return {
    cursorState,
    viewState: {
      scrollLeft: view.scrollLeft, firstPosition, firstPositionDeltaTop: view.firstPositionDeltaTop,
      ...(number(view.scrollTop, 0, maximumOffset) ? { scrollTop: view.scrollTop } : {}),
      ...(number(view.scrollTopWithoutViewZones, 0, maximumOffset) ? { scrollTopWithoutViewZones: view.scrollTopWithoutViewZones } : {}),
    },
    contributionsState: folded ? { [foldingContribution]: folded } : {},
  };
}

function diffPane(value: unknown): ViewState['original'] | undefined {
  const input = object(value), anchor = object(input?.anchor);
  if (!input || !anchor || !number(anchor.line, 1, maximumPosition) || !number(anchor.offset, -maximumOffset, maximumOffset) || !number(anchor.scrollLeft, 0, maximumOffset)) return;
  const selections: ISelection[] | null = Array.isArray(input.selections) ? input.selections.slice(0, maximumItems).flatMap(value => {
    const selection = object(value);
    if (!selection || !integer(selection.selectionStartLineNumber) || !integer(selection.selectionStartColumn) || !integer(selection.positionLineNumber) || !integer(selection.positionColumn)) return [];
    return [{ selectionStartLineNumber: selection.selectionStartLineNumber, selectionStartColumn: selection.selectionStartColumn, positionLineNumber: selection.positionLineNumber, positionColumn: selection.positionColumn }];
  }) : null;
  return { anchor: { line: anchor.line, offset: anchor.offset, scrollLeft: anchor.scrollLeft }, selections };
}

function diffView(value: unknown): ViewState | undefined {
  const input = object(value), original = diffPane(input?.original), modified = diffPane(input?.modified);
  if (!input || !original || !modified || !Array.isArray(input.expandedRegions)) return;
  return {
    original, modified,
    expandedRegions: input.expandedRegions.slice(0, maximumItems).filter((id): id is string => typeof id === 'string' && validId(id)),
    ...(typeof input.currentChangeId === 'string' && validId(input.currentChangeId) ? { currentChangeId: input.currentChangeId } : {}),
    ...(number(input.splitRatio, .1, .9) ? { splitRatio: input.splitRatio } : {}),
  };
}

function preferences(value: unknown): ViewerPreferences | undefined {
  const input = object(value);
  if (!input || (input.layout !== 'compact' && input.layout !== 'aligned') || typeof input.sync !== 'boolean' || typeof input.collapse !== 'boolean' || typeof input.whitespace !== 'boolean' || typeof input.wrap !== 'boolean') return;
  return { layout: input.layout, sync: input.sync, collapse: input.collapse, whitespace: input.whitespace, wrap: input.wrap,
    ...(input.viewMode === 'inline' || input.viewMode === 'side-by-side' ? { viewMode: input.viewMode } : {}),
    ...(number(input.splitRatio, .1, .9) ? { splitRatio: input.splitRatio } : {}) };
}

function decodeTab(value: unknown): SavedTab | undefined {
  const input = object(value);
  if (!input) return;
  const file = decodeFileViewState(input.file), diff = diffView(input.diff), media = decodeMediaView(input.media), markdown = decodeMarkdownView(input.markdown), preference = preferences(input.preferences);
  return file || diff || media || markdown || preference ? { ...(file ? { file } : {}), ...(diff ? { diff } : {}), ...(media ? { media } : {}), ...(markdown ? { markdown } : {}), ...(preference ? { preferences: preference } : {}) } : undefined;
}

/** Validate and copy serialized input without retaining content or model IDs. */
export function decodeWorkspaceViews(value: unknown): Record<string, SavedTab> {
  const input = object(value), result: Record<string, SavedTab> = {};
  if (!input) return result;
  for (const [id, entry] of Object.entries(input).slice(0, maximumViews)) {
    if (!validId(id)) continue;
    const state = decodeTab(entry);
    if (state) result[id] = state;
  }
  return result;
}
