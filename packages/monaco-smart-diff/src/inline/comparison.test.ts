import { describe, expect, it } from 'vitest';
import type { editor } from 'monaco-editor';
import type { DiffRequest } from '../diff/model';
import { computeComparison } from '../diff/engine';
import { nativeComparison, nativeLineRange } from './comparison';

function request(original: string, modified: string): DiffRequest {
  return { requestId: 7, originalVersion: 3, modifiedVersion: 5, original, modified, ignoreTrimWhitespace: false, maxComputationTimeMs: 1500 };
}
function line(originalStartLineNumber: number, originalEndLineNumber: number, modifiedStartLineNumber: number, modifiedEndLineNumber: number): editor.ILineChange {
  return { originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber, charChanges: undefined };
}

describe('native inline comparison adapter', () => {
  it('converts empty boundaries at BOF, between lines and EOF without off-by-one errors', () => {
    expect(nativeLineRange(0, 0)).toEqual({ start: 1, end: 1 });
    expect(nativeLineRange(4, 0)).toEqual({ start: 5, end: 5 });
    expect(nativeLineRange(7, 9)).toEqual({ start: 7, end: 10 });
  });

  it.each([
    ['insert at BOF', 'old', 'new\nold', line(0, 0, 1, 1)],
    ['insert at EOF', 'old', 'old\nnew', line(1, 0, 2, 2)],
    ['delete at BOF', 'old\nkeep', 'keep', line(1, 1, 0, 0)],
    ['delete at EOF', 'keep\nold', 'keep', line(2, 2, 1, 0)],
    ['replace', 'keep\nold\nend', 'keep\nnew\nend', line(2, 2, 2, 2)],
  ])('preserves canonical correspondence for %s', (_label, original, modified, change) => {
    const input = request(original as string, modified as string);
    const native = nativeComparison([change as editor.ILineChange], input);
    const standard = computeComparison(input);
    expect(native.changes.map(({ innerChanges: _inner, ...rest }) => rest)).toEqual(standard.changes.map(({ innerChanges: _inner, ...rest }) => rest));
    expect(native.unchanged).toEqual(standard.unchanged);
    expect(native.originalLineCount).toBe(standard.originalLineCount);
    expect(native.modifiedLineCount).toBe(standard.modifiedLineCount);
  });

  it('keeps character ranges in UTF-16 and does not convert their exclusive end columns', () => {
    const change: editor.ILineChange = { ...line(1, 1, 1, 1), charChanges: [{ originalStartLineNumber: 1, originalStartColumn: 3, originalEndLineNumber: 1, originalEndColumn: 4, modifiedStartLineNumber: 1, modifiedStartColumn: 3, modifiedEndLineNumber: 1, modifiedEndColumn: 5 }] };
    const result = nativeComparison([change], request('😀a', '😀bc'));
    expect(result.changes[0].innerChanges).toEqual([{ original: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 4 }, modified: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 5 } }]);
  });

  it('pairs unchanged intervals by line correspondence across unequal changes', () => {
    const result = nativeComparison([line(2, 2, 2, 4), line(5, 6, 6, 0)], request('a\nb\nc\nd\ne\nf\ng', 'a\nx\ny\nz\nc\nd\ng'));
    expect(result.changes.map(change => change.kind)).toEqual(['replace', 'delete']);
    expect(result.unchanged).toEqual([
      { original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } },
      { original: { start: 3, end: 5 }, modified: { start: 5, end: 7 } },
      { original: { start: 7, end: 8 }, modified: { start: 7, end: 8 } },
    ]);
  });

  it.each([['', 'new\n', 'insert'], ['old\n', '', 'delete']])('normalizes empty file endpoints', (original, modified, kind) => {
    const result = nativeComparison([line(1, 1, 1, 2)], request(original, modified));
    expect(result.changes[0].kind).toBe(kind);
    expect(result.changes[0][kind === 'insert' ? 'original' : 'modified']).toEqual({ start: 1, end: 1 });
    expect(result.unchanged).toEqual([]);
  });

  it('retains completion status, model generations and line-ending metadata', () => {
    const result = nativeComparison([], request('same\r\n', 'same\n'), true, 123);
    expect(result).toMatchObject({ requestId: 7, originalVersion: 3, modifiedVersion: 5, status: 'timeout', durationMs: 123, originalMetadata: { lineEndings: 'crlf', hasFinalNewline: true }, modifiedMetadata: { lineEndings: 'lf', hasFinalNewline: true } });
    expect(result.unchanged).toEqual([{ original: { start: 1, end: 3 }, modified: { start: 1, end: 3 } }]);
  });
});
