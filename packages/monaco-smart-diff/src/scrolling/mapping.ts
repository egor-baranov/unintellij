import { oppositeSide, type Comparison, type Side } from '../diff/model';

/** Maps fractional document line boundaries, not pixels or document percentages.
 * Unchanged ranges have slope 1, replacements interpolate between their ends,
 * deleted ranges have slope 0. Insertions are right-continuous jumps: the line
 * immediately after an inserted block retains exact unchanged correspondence.
 * This ordinary map is monotonic and deliberately does not follow moved blocks.
 */
export function mapLine(comparison: Comparison, sourceSide: Side, line: number): number {
  const targetSide = oppositeSide(sourceSide);
  const sourceEnd = (sourceSide === 'original' ? comparison.originalLineCount : comparison.modifiedLineCount) + 1;
  const targetEnd = (targetSide === 'original' ? comparison.originalLineCount : comparison.modifiedLineCount) + 1;
  const position = Math.max(1, Math.min(sourceEnd, Number.isNaN(line) ? 1 : line));
  const clamp = (value: number) => Math.max(1, Math.min(targetEnd, value));
  let sourceCursor = 1;
  let targetCursor = 1;
  for (const change of comparison.changes) {
    const source = change[sourceSide];
    const target = change[targetSide];
    if (position < source.start) return clamp(targetCursor + position - sourceCursor);
    if (position < source.end) {
      const fraction = (position - source.start) / (source.end - source.start);
      return clamp(target.start + fraction * (target.end - target.start));
    }
    sourceCursor = source.end;
    targetCursor = target.end;
  }
  return clamp(targetCursor + position - sourceCursor);
}
