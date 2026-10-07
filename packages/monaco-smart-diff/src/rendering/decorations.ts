import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { CharacterRange, Comparison, Side } from '../diff/model';

type TextLines = Pick<Monaco.editor.ITextModel, 'getLineCount' | 'getLineMaxColumn'>;
type ChangeColor = 'replace' | 'delete' | 'insert';
type RangeFactory = { Range: new (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => Monaco.IRange };

/** A line break has no text glyph to decorate. Split a canonical UTF-16 range
 * into its actual per-line text spans instead of asking Monaco to fill the
 * remainder of each visual row. Whitespace inside the engine's range is real
 * changed content and deliberately remains included. */
export function splitCharacterRange(model: TextLines, range: CharacterRange): CharacterRange[] {
  const spans: CharacterRange[] = [];
  const first = Math.max(1, range.startLineNumber);
  const last = Math.min(model.getLineCount(), range.endLineNumber);
  for (let line = first; line <= last; line++) {
    const maximum = model.getLineMaxColumn(line);
    const start = Math.max(1, Math.min(maximum, line === range.startLineNumber ? range.startColumn : 1));
    const end = Math.max(1, Math.min(maximum, line === range.endLineNumber ? range.endColumn : maximum));
    if (end > start) spans.push({ startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: end });
  }
  return spans;
}

/** Inner ranges may touch or overlap after engine word/subword extension.
 * Paint each character once so transparency never becomes an accidental
 * indicator of how many engine ranges cover it. */
function mergeSpans(spans: CharacterRange[]): CharacterRange[] {
  spans.sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  const merged: CharacterRange[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous?.startLineNumber === span.startLineNumber && span.startColumn <= previous.endColumn) {
      previous.endColumn = Math.max(previous.endColumn, span.endColumn);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function decorations(monaco: RangeFactory, model: TextLines, comparison: Comparison, side: Side, activeId?: string): Monaco.editor.IModelDeltaDecoration[] {
  const result: Monaco.editor.IModelDeltaDecoration[] = [];
  const innerSpans = new Map<ChangeColor, CharacterRange[]>();
  for (const change of comparison.changes) {
    const range = change[side];
    const color: ChangeColor = change.kind === 'replace' ? 'replace' : side === 'original' ? 'delete' : 'insert';
    if (range.end > range.start) {
      result.push({
        range: new monaco.Range(range.start, 1, range.end - 1, model.getLineMaxColumn(Math.min(model.getLineCount(), range.end - 1))),
        options: {
          isWholeLine: true,
          className: `smart-diff-line-${color}${activeId === change.id ? ' smart-diff-active' : ''}`,
          shouldFillLineOnLineBreak: true,
        },
      });
    }
    // Empty sides have no line decoration. Gutter owns their viewport-wide
    // hairline as part of its filled connector; no fake model row or zone.
    const spans = innerSpans.get(color) ?? [];
    for (const inner of change.innerChanges) spans.push(...splitCharacterRange(model, inner[side]));
    innerSpans.set(color, spans);
  }
  for (const [color, spans] of innerSpans) {
    for (const range of mergeSpans(spans)) {
      result.push({ range, options: { className: `smart-diff-inner-${color}` } });
    }
  }
  return result;
}
