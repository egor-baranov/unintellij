import { describe, expect, it, vi } from 'vitest';
import { DefaultLinesDiffComputer } from 'vscode-diff';
import { computeComparison, splitLines, textMetadata } from './engine';
import type { DiffRequest } from './model';

const request = (original: string, modified: string, options: Partial<DiffRequest> = {}): DiffRequest => ({
  requestId: 7, originalVersion: 2, modifiedVersion: 3, original, modified, ignoreTrimWhitespace: false, maxComputationTimeMs: 2_000, ...options,
});

describe('VS Code diff adapter', () => {
  it('preserves request identities and produces plain serializable values', () => {
    const result = computeComparison(request('const n = 1;', 'const n = 42;'));
    expect(result).toMatchObject({ requestId: 7, originalVersion: 2, modifiedVersion: 3, status: 'complete', originalLineCount: 1, modifiedLineCount: 1 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ kind: 'replace', original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } });
    expect(result.changes[0].innerChanges).toEqual([{ original: { startLineNumber: 1, endLineNumber: 1, startColumn: 11, endColumn: 12 }, modified: { startLineNumber: 1, endLineNumber: 1, startColumn: 11, endColumn: 13 } }]);
  });

  it.each([
    ['a\nb', 'x\na\nb', 'insert', { start: 1, end: 1 }, { start: 1, end: 2 }],
    ['x\na\nb', 'a\nb', 'delete', { start: 1, end: 2 }, { start: 1, end: 1 }],
    ['a\nb', 'a\nb\nx', 'insert', { start: 3, end: 3 }, { start: 3, end: 4 }],
    ['a\nb\nx', 'a\nb', 'delete', { start: 3, end: 4 }, { start: 3, end: 3 }],
    ['', 'new\nfile', 'insert', { start: 1, end: 1 }, { start: 1, end: 3 }],
    ['old\nfile', '', 'delete', { start: 1, end: 3 }, { start: 1, end: 1 }],
  ] as const)('represents empty boundaries in %j → %j', (original, modified, kind, before, after) => {
    const result = computeComparison(request(original, modified));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ kind, original: before, modified: after });
  });

  it('does not invent a difference between empty files', () => {
    const result = computeComparison(request('', ''));
    expect(result.changes).toEqual([]);
    expect(result.unchanged).toEqual([{ original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } }]);
  });

  it('returns exact unchanged correspondence around an insertion', () => {
    const result = computeComparison(request('one\ntwo\nthree', 'one\ninserted\ntwo\nthree'));
    expect(result.unchanged).toEqual([
      { original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } },
      { original: { start: 2, end: 4 }, modified: { start: 3, end: 5 } },
    ]);
  });

  it('ignores only trim whitespace when requested, keeping input source intact', () => {
    const original = '  const x = 1;  \nreturn x;';
    const modified = 'const x = 1;\nreturn x;';
    const input = Object.freeze(request(original, modified, { ignoreTrimWhitespace: true }));
    expect(computeComparison(input).changes).toEqual([]);
    expect(input.original).toBe(original);
    expect(computeComparison(request(original, modified)).changes).toHaveLength(1);
    expect(computeComparison(request('const x=1', 'const x = 1', { ignoreTrimWhitespace: true })).changes).toHaveLength(1);
  });

  it('normalizes line endings only for comparison and reports the original metadata', () => {
    const result = computeComparison(request('a\r\nb\r\n', 'a\nb\n'));
    expect(result.changes).toEqual([]);
    expect(result.originalMetadata).toEqual({ lineEndings: 'crlf', hasFinalNewline: true });
    expect(result.modifiedMetadata).toEqual({ lineEndings: 'lf', hasFinalNewline: true });
    expect(textMetadata('a\rb\nc\r\n')).toEqual({ lineEndings: 'mixed', hasFinalNewline: true });
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
  });

  it('detects a missing final newline as an insertion at the ending boundary', () => {
    const result = computeComparison(request('a', 'a\n'));
    expect(result.changes[0]).toMatchObject({ kind: 'insert', original: { start: 2, end: 2 }, modified: { start: 2, end: 3 } });
    expect(result.originalMetadata.hasFinalNewline).toBe(false);
    expect(result.modifiedMetadata.hasFinalNewline).toBe(true);
  });

  it('preserves UTF-16 inner coordinates for Unicode text', () => {
    const result = computeComparison(request('const icon = "🌍";', 'const icon = "🌎";'));
    const inner = result.changes[0].innerChanges[0];
    expect(inner.original).toMatchObject({ startLineNumber: 1, endLineNumber: 1 });
    const before = 'const icon = "🌍";'.slice(inner.original.startColumn - 1, inner.original.endColumn - 1);
    const after = 'const icon = "🌎";'.slice(inner.modified.startColumn - 1, inner.modified.endColumn - 1);
    expect(before).not.toBe(after);
  });

  it('exposes an engine timeout instead of claiming a complete result', () => {
    const implementation = vi.spyOn(DefaultLinesDiffComputer.prototype, 'computeDiff').mockReturnValue({ changes: [], moves: [], hitTimeout: true });
    try { expect(computeComparison(request('one', 'two')).status).toBe('timeout'); }
    finally { implementation.mockRestore(); }
  });

  it('compares a reproducible 20,000-line fixture with hundreds of separated changes', () => {
    const original = Array.from({ length: 20_000 }, (_, i) => `export const value_${i} = ${i};`);
    const modified = original.map((line, i) => i % 83 === 0 ? line.replace(`= ${i};`, `= ${i + 1}; // updated`) : line);
    const result = computeComparison(request(original.join('\n'), modified.join('\n'), { maxComputationTimeMs: 5_000 }));
    expect(result.status).toBe('complete');
    expect(result.changes.length).toBeGreaterThan(200);
    expect(result.changes.length).toBeLessThan(300);
    expect(result.originalLineCount).toBe(20_000);
  });
});
