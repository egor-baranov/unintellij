import type { editor } from 'monaco-editor';
import type { LineRange } from '../diff/model';
import type { ReadingAnchor } from '../types';
export type CodeEditor = editor.IStandaloneCodeEditor;

/** Public visible ranges exclude hidden intervals in pinned Monaco. Expand by
 * a few model lines to include partial viewport rows, then cull in pixel space.
 * Iterating those disjoint ranges avoids walking thousands of collapsed lines. */
export function visibleLineGeometry(editor: CodeEditor, buffer: number): {lineNumber:number;top:number;rowHeight:number}[] {
  const model = editor.getModel();
  if (!model) return [];
  const result = new Map<number, {lineNumber:number;top:number;rowHeight:number}>();
  const scrollTop = editor.getScrollTop(), viewportHeight = editor.getLayoutInfo().height;
  for (const range of editor.getVisibleRanges()) {
    for (let lineNumber = Math.max(1,range.startLineNumber-3); lineNumber <= Math.min(model.getLineCount(),range.endLineNumber+3); lineNumber++) {
      if (result.has(lineNumber)) continue;
      const rowHeight = editor.getLineHeightForPosition({lineNumber,column:1});
      if (!rowHeight) continue;
      const top = editor.getTopForLineNumber(lineNumber) - scrollTop;
      if (top + rowHeight < -buffer || top > viewportHeight + buffer) continue;
      result.set(lineNumber,{lineNumber,top,rowHeight});
    }
  }
  return [...result.values()];
}

/** Model boundaries, including the virtual boundary after the last line. */
export function boundaryTop(editor: CodeEditor, boundary: number): number {
  const count = editor.getModel()?.getLineCount() ?? 1;
  if (boundary > count) return editor.getBottomForLineNumber(count);
  return editor.getTopForLineNumber(Math.max(1, boundary));
}
export function lineToY(editor: CodeEditor, line: number): number {
  const count = editor.getModel()?.getLineCount() ?? 1;
  const clamped = Math.max(1, Math.min(count + 1, line));
  const whole = Math.floor(clamped);
  const top = boundaryTop(editor, whole);
  // Use the rendered line's complete height (wrapping), not a nominal line height.
  const visible = whole <= count && editor.getLineHeightForPosition({lineNumber:whole,column:1}) > 0;
  const height = visible ? Math.max(0, editor.getBottomForLineNumber(whole) - top) : 0;
  return top + (clamped - whole) * height;
}
export function yToLine(editor: CodeEditor, y: number): number {
  const count = editor.getModel()?.getLineCount() ?? 1;
  y = Math.max(boundaryTop(editor, 1), y);
  if (y >= boundaryTop(editor, count + 1)) return count + 1;
  let low = 1, high = count;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (boundaryTop(editor, mid) <= y) low = mid;
    else high = mid - 1;
  }
  // Hidden model lines project onto the previous visible row (onto its last
  // wrapped row when it wraps). A plain upper-bound search consequently lands
  // on the *last hidden line*. Using that line as a saved reading anchor makes
  // expansion jump deep into the formerly hidden region. Find the start of
  // this equal-position plateau and anchor to its preceding visible model row.
  if (editor.getLineHeightForPosition({lineNumber:low,column:1}) === 0) {
    const hiddenTop = boundaryTop(editor,low);
    let first = 1, last = low;
    while (first < last) {
      const mid = Math.floor((first+last)/2);
      if (boundaryTop(editor,mid) < hiddenTop) first=mid+1;
      else last=mid;
    }
    low = editor.getLineHeightForPosition({lineNumber:first,column:1}) > 0 ? first : Math.max(1,first-1);
  }
  const top = boundaryTop(editor, low);
  const height = Math.max(1, editor.getBottomForLineNumber(low) - top);
  // A view zone contains no document text. Stay on the visible row immediately
  // before it; adding exactly 1 could instead select the next hidden model row.
  return low + Math.max(0, Math.min(1-1e-7, (y - top) / height));
}
export function rangeGeometry(editor: CodeEditor, range: LineRange): [number, number] {
  const top = boundaryTop(editor, range.start) - editor.getScrollTop();
  const bottom = range.end === range.start ? top : editor.getBottomForLineNumber(range.end - 1) - editor.getScrollTop();
  return [top, Math.max(top, bottom)];
}

/** Emptiness is semantic, never inferred from a rendered height. A folded or
 * offscreen nonempty range remains a block; a boundary consumes no model row. */
export type HunkSideGeometry =
  | { kind: 'boundary'; top: number; bottom: number }
  | { kind: 'block'; top: number; bottom: number };

export function hunkSideGeometry(editor: CodeEditor, range: LineRange): HunkSideGeometry {
  const [top, bottom] = rangeGeometry(editor, range);
  return { kind: range.start === range.end ? 'boundary' : 'block', top, bottom };
}

/** Inclusive checks keep zero-height boundaries at either viewport edge. */
export function boundaryInViewport(y: number, height: number, buffer = 0): boolean {
  return y >= -buffer && y <= height + buffer;
}
export function captureAnchor(editor: CodeEditor): ReadingAnchor {
  const desiredOffset = Math.min(editor.getLayoutInfo().height * .4, 240);
  const line = yToLine(editor,editor.getScrollTop()+desiredOffset);
  // If the desired anchor falls in a spacer/omission, preserve the actual
  // nearby text's viewport position rather than the arbitrary spacer pixel.
  const offset = lineToY(editor,line)-editor.getScrollTop();
  return {line,offset,scrollLeft:editor.getScrollLeft()};
}
export function restoreAnchor(editor: CodeEditor, anchor: ReadingAnchor): void {
  editor.setScrollPosition({scrollTop:Math.max(0,lineToY(editor,anchor.line)-anchor.offset),scrollLeft:anchor.scrollLeft},1);
}
