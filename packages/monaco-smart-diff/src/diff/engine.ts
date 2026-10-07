import { DefaultLinesDiffComputer } from 'vscode-diff';
import { textMetadata } from './text-metadata';
export { textMetadata } from './text-metadata';
import type { CharacterRange, Change, Comparison, Correspondence, DiffRequest } from './model';

const engine = new DefaultLinesDiffComputer();

/** Monaco's line model includes one empty line for an empty document and a
 * trailing empty line when a final newline exists. Never trim displayed text. */
export const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

// Copy engine classes into plain structured-cloneable values at this boundary.
function characterRange(range: CharacterRange): CharacterRange {
  return {
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
  };
}

function wholeDocumentRange(lines: string[]): CharacterRange {
  return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 };
}

export function computeComparison(request: DiffRequest): Comparison {
  const started = performance.now();
  const original = splitLines(request.original);
  const modified = splitLines(request.modified);
  const result = engine.computeDiff(original, modified, {
    ignoreTrimWhitespace: request.ignoreTrimWhitespace,
    maxComputationTimeMs: Math.max(0, request.maxComputationTimeMs),
    computeMoves: false,
    extendToSubwords: true,
  });
  let changes: Change[] = result.changes.map((change, index) => {
    const originalRange = { start: change.original.startLineNumber, end: change.original.endLineNumberExclusive };
    const modifiedRange = { start: change.modified.startLineNumber, end: change.modified.endLineNumberExclusive };
    return {
      id: `change-${index}-${originalRange.start}-${modifiedRange.start}`,
      kind: originalRange.start === originalRange.end ? 'insert' : modifiedRange.start === modifiedRange.end ? 'delete' : 'replace',
      original: originalRange,
      modified: modifiedRange,
      innerChanges: (change.innerChanges ?? []).map(inner => ({ original: characterRange(inner.originalRange), modified: characterRange(inner.modifiedRange) })),
    };
  });
  // The engine treats Monaco's synthetic empty line as a replacement. A truly
  // empty endpoint represents an added/deleted file, so expose an empty range.
  if (request.original !== request.modified && (request.original === '' || request.modified === '')) {
    changes = [{
      id: 'change-0-1-1',
      kind: request.original === '' ? 'insert' : 'delete',
      original: { start: 1, end: request.original === '' ? 1 : original.length + 1 },
      modified: { start: 1, end: request.modified === '' ? 1 : modified.length + 1 },
      innerChanges: [{ original: wholeDocumentRange(original), modified: wholeDocumentRange(modified) }],
    }];
  }
  const unchanged: Correspondence[] = [];
  let originalCursor = 1;
  let modifiedCursor = 1;
  for (const change of changes) {
    const length = Math.min(change.original.start - originalCursor, change.modified.start - modifiedCursor);
    if (length > 0) unchanged.push({ original: { start: originalCursor, end: originalCursor + length }, modified: { start: modifiedCursor, end: modifiedCursor + length } });
    originalCursor = change.original.end;
    modifiedCursor = change.modified.end;
  }
  const remaining = Math.min(original.length + 1 - originalCursor, modified.length + 1 - modifiedCursor);
  if (remaining > 0) unchanged.push({ original: { start: originalCursor, end: originalCursor + remaining }, modified: { start: modifiedCursor, end: modifiedCursor + remaining } });
  return {
    requestId: request.requestId,
    originalVersion: request.originalVersion,
    modifiedVersion: request.modifiedVersion,
    changes,
    unchanged,
    originalLineCount: original.length,
    modifiedLineCount: modified.length,
    originalMetadata: textMetadata(request.original),
    modifiedMetadata: textMetadata(request.modified),
    status: result.hitTimeout ? 'timeout' : 'complete',
    durationMs: performance.now() - started,
  };
}
