import type { editor } from 'monaco-editor';
import type { Change, Comparison, Correspondence, DiffRequest, LineRange } from '../diff/model';
import { textMetadata } from '../diff/text-metadata';

/** Monaco's legacy public change API uses inclusive ends and an end of zero
 * for empty ranges. Their start is the preceding line, including zero at BOF. */
export function nativeLineRange(start: number, end: number): LineRange {
  return end === 0 ? { start: start + 1, end: start + 1 } : { start, end: end + 1 };
}

/** Adapt the native diff result, never compute a second diff or concatenate the
 * original into the editable model. IDs match the side-by-side controller. */
export function nativeComparison(lines: readonly editor.ILineChange[], request: DiffRequest, quitEarly = false, durationMs = 0): Comparison {
  const originalLineCount = request.original.split(/\r\n|\r|\n/).length;
  const modifiedLineCount = request.modified.split(/\r\n|\r|\n/).length;
  let changes: Change[] = lines.map((line, index) => {
    const original = nativeLineRange(line.originalStartLineNumber, line.originalEndLineNumber);
    const modified = nativeLineRange(line.modifiedStartLineNumber, line.modifiedEndLineNumber);
    return {
      id: `change-${index}-${original.start}-${modified.start}`,
      kind: original.start === original.end ? 'insert' : modified.start === modified.end ? 'delete' : 'replace',
      original, modified,
      innerChanges: (line.charChanges ?? []).map(change => ({
        original: { startLineNumber: change.originalStartLineNumber, endLineNumber: change.originalEndLineNumber, startColumn: change.originalStartColumn, endColumn: change.originalEndColumn },
        modified: { startLineNumber: change.modifiedStartLineNumber, endLineNumber: change.modifiedEndLineNumber, startColumn: change.modifiedStartColumn, endColumn: change.modifiedEndColumn },
      })),
    };
  });
  // Preserve the reusable viewer's empty-endpoint semantics (Monaco's model
  // always has at least one line, including when the file contains no bytes).
  if (request.original !== request.modified && (request.original === '' || request.modified === '')) {
    changes = [{ id: 'change-0-1-1', kind: request.original === '' ? 'insert' : 'delete', original: { start: 1, end: request.original === '' ? 1 : originalLineCount + 1 }, modified: { start: 1, end: request.modified === '' ? 1 : modifiedLineCount + 1 }, innerChanges: [] }];
  }
  const unchanged: Correspondence[] = [];
  let originalCursor = 1, modifiedCursor = 1;
  for (const change of changes) {
    const length = Math.min(change.original.start - originalCursor, change.modified.start - modifiedCursor);
    if (length > 0) unchanged.push({ original: { start: originalCursor, end: originalCursor + length }, modified: { start: modifiedCursor, end: modifiedCursor + length } });
    originalCursor = change.original.end; modifiedCursor = change.modified.end;
  }
  const remaining = Math.min(originalLineCount + 1 - originalCursor, modifiedLineCount + 1 - modifiedCursor);
  if (remaining > 0) unchanged.push({ original: { start: originalCursor, end: originalCursor + remaining }, modified: { start: modifiedCursor, end: modifiedCursor + remaining } });
  return { requestId: request.requestId, originalVersion: request.originalVersion, modifiedVersion: request.modifiedVersion, changes, unchanged, originalLineCount, modifiedLineCount, originalMetadata: textMetadata(request.original), modifiedMetadata: textMetadata(request.modified), status: quitEarly ? 'timeout' : 'complete', durationMs };
}
