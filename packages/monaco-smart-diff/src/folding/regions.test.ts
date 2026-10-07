import { describe, expect, it } from 'vitest';
import { computeComparison } from '../diff/engine';
import { deriveCollapsedRegions } from './regions';

const options = { contextLines: 3, minimumHiddenLines: 6 };
const compare = (original: string, modified: string) => computeComparison({ requestId: 1, originalVersion: 1, modifiedVersion: 1, original, modified, ignoreTrimWhitespace: false, maxComputationTimeMs: 2_000 });

describe('coordinated unchanged regions', () => {
  it('keeps both hidden ranges in exact correspondence with three context lines', () => {
    const original = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const modified = [...original];
    modified.splice(10, 0, 'inserted 1', 'inserted 2');
    modified[52] = 'edited';
    const comparison = compare(original.join('\n'), modified.join('\n'));
    const regions = deriveCollapsedRegions(comparison, options);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ original: { start: 14, end: 48 }, modified: { start: 16, end: 50 }, hiddenLineCount: 34 });
    expect(original.slice(regions[0].original.start - 1, regions[0].original.end - 1)).toEqual(modified.slice(regions[0].modified.start - 1, regions[0].modified.end - 1));
    expect(deriveCollapsedRegions(comparison, options)[0].id).toBe(regions[0].id);
  });

  it('never turns identical files into an empty hidden view', () => {
    const source = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(deriveCollapsedRegions(compare(source, source), options)).toEqual([]);
  });

  it('does not hide a region when fewer than the minimum lines remain after context', () => {
    const original = 'old\n' + Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n');
    const modified = original.replace('old', 'new');
    expect(deriveCollapsedRegions(compare(original, modified), options)).toEqual([]);
  });
});
