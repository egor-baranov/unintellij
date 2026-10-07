import { describe, expect, it } from 'vitest';
import { clampSplitRatio, splitBounds } from './divider';

describe('diff divider bounds', () => {
  it('keeps normal panes at least 160px wide and enforces fractional limits', () => {
    expect(splitBounds(1152)).toEqual({ minimum: .16, maximum: .84 });
    expect(clampSplitRatio(0, 1152)).toBe(.16);
    expect(clampSplitRatio(1, 1152)).toBe(.84);
    expect(splitBounds(2152)).toEqual({ minimum: .1, maximum: .9 });
  });
  it('shares narrow containers evenly and tolerates hidden containers and nonfinite input', () => {
    expect(clampSplitRatio(.8, 400)).toBe(.5);
    expect(clampSplitRatio(.8, 0)).toBe(.8);
    expect(clampSplitRatio(Number.NaN, 1152, .6)).toBe(.6);
    expect(clampSplitRatio(Infinity, 1152)).toBe(.5);
  });
});
