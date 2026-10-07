import type { Comparison, Correspondence } from '../diff/model';

export interface CollapsedRegion extends Correspondence { id: string; hiddenLineCount: number }
export interface CollapseRegionOptions { contextLines: number; minimumHiddenLines: number }

/** Paired hidden ranges derived exclusively from canonical unchanged ranges. */
export function deriveCollapsedRegions(comparison: Comparison, options: CollapseRegionOptions): CollapsedRegion[] {
  if (!comparison.changes.length) return [];
  const context = Math.max(0, Math.floor(options.contextLines));
  const minimum = Math.max(1, Math.floor(options.minimumHiddenLines));
  return comparison.unchanged.flatMap(range => {
    const length = range.original.end - range.original.start;
    // Keep context on both edges, even at document ends, so the file never
    // opens with all of its identifying context hidden behind a separator.
    const hiddenLineCount = length - context * 2;
    if (hiddenLineCount < minimum) return [];
    const original = { start: range.original.start + context, end: range.original.end - context };
    const modified = { start: range.modified.start + context, end: range.modified.end - context };
    return [{ id: `unchanged-${original.start}-${original.end}-${modified.start}-${modified.end}`, original, modified, hiddenLineCount }];
  });
}
