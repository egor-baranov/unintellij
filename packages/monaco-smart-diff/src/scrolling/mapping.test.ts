import { describe, expect, it } from 'vitest';
import { computeComparison } from '../diff/engine';
import type { Comparison, Side } from '../diff/model';
import { mapLine } from './mapping';

const compare = (original: string, modified: string): Comparison => computeComparison({ requestId: 1, originalVersion: 1, modifiedVersion: 1, original, modified, ignoreTrimWhitespace: false, maxComputationTimeMs: 2_000 });

describe('correspondence line mapping', () => {
  it('maps unchanged lines exactly in both directions after a large insertion', () => {
    const inserted = Array.from({ length: 50 }, (_, i) => `insert ${i}`).join('\n');
    const comparison = compare('first\nlast\nend', `first\n${inserted}\nlast\nend`);
    expect(mapLine(comparison, 'original', 2)).toBe(52);
    expect(mapLine(comparison, 'original', 3.5)).toBe(53.5);
    expect(mapLine(comparison, 'modified', 52)).toBe(2);
    expect(mapLine(comparison, 'modified', 53.5)).toBe(3.5);
    expect(mapLine(comparison, 'modified', 20)).toBe(2);
  });

  it('interpolates a one-to-fifty-line replacement between matching boundaries', () => {
    const replacement = Array.from({ length: 50 }, (_, i) => `replacement ${i}`).join('\n');
    const comparison = compare('first\nold\nlast', `first\n${replacement}\nlast`);
    expect(comparison.changes[0].kind).toBe('replace');
    expect(mapLine(comparison, 'original', 2)).toBe(2);
    expect(mapLine(comparison, 'original', 2.5)).toBe(27);
    expect(mapLine(comparison, 'original', 3)).toBe(52);
    expect(mapLine(comparison, 'modified', 27)).toBe(2.5);
    expect(mapLine(comparison, 'modified', 52)).toBe(3);
  });

  it('clamps boundaries without division by zero for a whole-file insertion/deletion', () => {
    const comparison = compare('', 'new\nfile');
    for (const side of ['original', 'modified'] as Side[]) {
      for (const value of [-Infinity, -100, 1, 1.5, 2, 100, Infinity, NaN]) {
        const mapped = mapLine(comparison, side, value);
        expect(Number.isFinite(mapped)).toBe(true);
        expect(mapped).toBeGreaterThanOrEqual(1);
        expect(mapped).toBeLessThanOrEqual(side === 'original' ? 3 : 2);
      }
    }
    expect(mapLine(comparison, 'modified', 2.5)).toBe(1);
  });

  it('clamps identical files to valid document boundaries', () => {
    const comparison = compare('a\nb\nc', 'a\nb\nc');
    expect(mapLine(comparison, 'original', -40)).toBe(1);
    expect(mapLine(comparison, 'modified', 99)).toBe(4);
    expect(mapLine(comparison, 'original', 2.75)).toBe(2.75);
  });

  it('remains monotonic across neighboring insertions, removals and replacements', () => {
    const original = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const modified = original.flatMap((line, i) => i % 11 === 0 ? [] : i % 7 === 0 ? [line, `extra ${i}`, `more ${i}`] : i % 5 === 0 ? [`changed ${i}`] : [line]);
    const comparison = compare(original.join('\n'), modified.join('\n'));
    for (const side of ['original', 'modified'] as Side[]) {
      const count = side === 'original' ? comparison.originalLineCount : comparison.modifiedLineCount;
      let previous = 1;
      for (let line = 1; line <= count + 1; line += 0.125) {
        const next = mapLine(comparison, side, line);
        expect(next).toBeGreaterThanOrEqual(previous);
        previous = next;
      }
    }
  });

  it('never follows reordered blocks backwards', () => {
    const comparison = compare('function a() {\n return 1;\n}\nfunction b() {\n return 2;\n}', 'function b() {\n return 2;\n}\nfunction a() {\n return 1;\n}');
    for (const side of ['original', 'modified'] as Side[]) {
      const mapped = Array.from({ length: 61 }, (_, i) => mapLine(comparison, side, 1 + i / 10));
      expect(mapped).toEqual([...mapped].sort((a, b) => a - b));
    }
  });
});
