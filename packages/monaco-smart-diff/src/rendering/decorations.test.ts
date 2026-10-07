import { describe, expect, it } from 'vitest';
import { computeComparison, splitLines } from '../diff/engine';
import type { CharacterRange } from '../diff/model';
import { decorations, splitCharacterRange } from './decorations';

// Only the public constructor and text-model methods consumed by decorations
// are needed here; browser tests cover the actual Monaco renderer.
class Range {
  constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
}

function textModel(text: string) {
  const lines = splitLines(text);
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
  };
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number): CharacterRange {
  return { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn };
}

function comparison(original: string, modified: string) {
  return computeComparison({ requestId: 1, originalVersion: 1, modifiedVersion: 1, original, modified, ignoreTrimWhitespace: false, maxComputationTimeMs: 0 });
}

const inline = (items: ReturnType<typeof decorations>) => items.filter(item => item.options.className?.startsWith('smart-diff-inner-'));

describe('precise inline decorations', () => {
  it('splits a multiline engine range into the actual first, middle, and final text spans', () => {
    const model = textModel('before changed\n  entirely changed  \nlast unchanged');
    expect(splitCharacterRange(model, range(1, 8, 3, 5))).toEqual([
      range(1, 8, 1, 15),
      range(2, 1, 2, 21),
      range(3, 1, 3, 5),
    ]);
  });

  it('does not paint the unchanged final line when the exclusive endpoint is column one', () => {
    expect(splitCharacterRange(textModel('changed\nunchanged'), range(1, 1, 2, 1))).toEqual([range(1, 1, 1, 8)]);
  });

  it('omits empty lines and changed line breaks without extending into blank visual space', () => {
    expect(splitCharacterRange(textModel('one\n\nthree\nfour'), range(1, 4, 4, 1))).toEqual([range(3, 1, 3, 6)]);
    expect(splitCharacterRange(textModel('one\ntwo'), range(1, 4, 2, 1))).toEqual([]);
  });

  it('preserves genuinely changed leading and trailing whitespace', () => {
    const model = textModel('  first  \n\t second \t');
    expect(splitCharacterRange(model, range(1, 1, 2, 11))).toEqual([
      range(1, 1, 1, 10),
      range(2, 1, 2, 11),
    ]);
  });

  it('retains UTF-16 columns for surrogate pairs and combining characters', () => {
    const text = 'A😀 café e\u0301!';
    const spans = splitCharacterRange(textModel(text), range(1, 2, 1, 12));
    expect(spans).toEqual([range(1, 2, 1, 12)]);
    expect(text.slice(spans[0].startColumn - 1, spans[0].endColumn - 1)).toBe('😀 café e\u0301');
  });

  it('skips empty insertion/deletion-side spans and bounds spans to real model columns', () => {
    const model = textModel('abc');
    expect(splitCharacterRange(model, range(1, 2, 1, 2))).toEqual([]);
    expect(splitCharacterRange(model, range(2, 1, 2, 1))).toEqual([]);
    expect(splitCharacterRange(model, range(1, 2, 1, 100))).toEqual([range(1, 2, 1, 4)]);
  });

  it('unions overlapping and touching same-color spans without consuming unchanged gaps', () => {
    const result = comparison('abcdefghijk', 'ABCDEFGHIJK');
    result.changes[0].innerChanges = [
      { original: range(1, 4, 1, 7), modified: range(1, 4, 1, 7) },
      { original: range(1, 2, 1, 5), modified: range(1, 2, 1, 5) },
      { original: range(1, 7, 1, 8), modified: range(1, 7, 1, 8) },
      { original: range(1, 10, 1, 12), modified: range(1, 10, 1, 12) },
    ];
    const actual = inline(decorations({ Range }, textModel('ABCDEFGHIJK'), result, 'modified'));
    expect(actual.map(item => item.range)).toEqual([range(1, 2, 1, 8), range(1, 10, 1, 12)]);
  });

  it('keeps line backgrounds separate from single-line inline glyph spans', () => {
    const original = 'const value = old;\nconst mode = slow;';
    const modified = 'const value = fresh;\n\nconst mode = fast;';
    const result = comparison(original, modified);
    const actual = decorations({ Range }, textModel(modified), result, 'modified', result.changes[0].id);
    expect(actual.some(item => item.options.isWholeLine && item.options.className?.includes('smart-diff-active'))).toBe(true);
    expect(inline(actual).length).toBeGreaterThan(0);
    for (const item of inline(actual)) {
      expect(item.range.startLineNumber).toBe(item.range.endLineNumber);
      expect(item.range.endColumn).toBeGreaterThan(item.range.startColumn);
      expect(item.options.shouldFillLineOnLineBreak).toBeUndefined();
      expect(item.options.isWholeLine).toBeUndefined();
    }
    for (const item of actual) {
      expect(item.options.linesDecorationsClassName).toBeUndefined();
      expect(item.options.overviewRuler).toBeUndefined();
    }
  });

  it.each(['insert', 'delete'] as const)('leaves a genuinely empty %s endpoint to the center gutter', kind => {
    const original = kind === 'insert' ? '' : 'first\nsecond\n';
    const modified = kind === 'delete' ? '' : 'first\nsecond\n';
    const result = comparison(original, modified);
    const emptySide = kind === 'insert' ? 'original' : 'modified';
    const fullSide = kind === 'insert' ? 'modified' : 'original';
    expect(decorations({ Range }, textModel(''), result, emptySide)).toEqual([]);
    const full = inline(decorations({ Range }, textModel('first\nsecond\n'), result, fullSide));
    expect(full.map(item => item.range)).toEqual([range(1, 1, 1, 6), range(2, 1, 2, 7)]);
    expect(full.every(item => item.options.className === `smart-diff-inner-${kind}`)).toBe(true);
  });
});
