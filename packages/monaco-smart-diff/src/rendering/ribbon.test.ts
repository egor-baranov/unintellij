import { describe, expect, it } from 'vitest';
import type { HunkSideGeometry } from './geometry';
import { createRibbon, emptySideMarkerThicknessPx, type RibbonGeometry, type RibbonOptions } from './ribbon';

const boundary = (y: number): HunkSideGeometry => ({ kind: 'boundary', top: y, bottom: y });
const block = (top: number, bottom: number): HunkSideGeometry => ({ kind: 'block', top, bottom });
const base = { gutterLeft: 413.375, viewportWidth: 1400, gutterWidth: 152, numberWidth: 48 };

function pathSegments(ribbon: RibbonGeometry) {
  return [...ribbon.d.matchAll(/([MHCVZ])([^MHCVZ]*)/g)].map(([, command, values]) => ({ command, values: values.trim() ? values.trim().split(/\s+/).map(Number) : [] }));
}

function bezier(start: number, first: number, second: number, end: number, t: number): number {
  return (1 - t) ** 3 * start + 3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3 * end;
}

function expectHorizontalTangents(ribbon: RibbonGeometry): void {
  const segments = pathSegments(ribbon);
  expect(segments.map(segment => segment.command)).toEqual(['M', 'H', 'C', 'H', 'V', 'H', 'C', 'H', 'Z']);
  const upper = segments[2].values;
  const lower = segments[6].values;
  expect(segments[1].values).toEqual([ribbon.transitionStart]);
  expect(upper).toEqual([
    ribbon.transitionStart + ribbon.controlOffset, ribbon.original.top,
    ribbon.transitionEnd - ribbon.controlOffset, ribbon.modified.top,
    ribbon.transitionEnd, ribbon.modified.top,
  ]);
  expect(segments[5].values).toEqual([ribbon.transitionEnd]);
  expect(lower).toEqual([
    ribbon.transitionEnd - ribbon.controlOffset, ribbon.modified.bottom,
    ribbon.transitionStart + ribbon.controlOffset, ribbon.original.bottom,
    ribbon.transitionStart, ribbon.original.bottom,
  ]);
  expect(segments[0].values).toEqual([ribbon.left, ribbon.original.top]);
  expect(segments[3].values).toEqual([ribbon.right]);
  expect(segments[4].values).toEqual([ribbon.modified.bottom]);
  expect(segments[7].values).toEqual([ribbon.left]);
}

function expectNoCrossing(ribbon: RibbonGeometry): void {
  const segments = pathSegments(ribbon);
  const upper = segments[2].values, lower = segments[6].values;
  let previousX = ribbon.transitionStart;
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const upperX = bezier(ribbon.transitionStart, upper[0], upper[2], upper[4], t);
    const lowerX = bezier(lower[4], lower[2], lower[0], ribbon.transitionEnd, t);
    const upperY = bezier(ribbon.original.top, upper[1], upper[3], upper[5], t);
    const lowerY = bezier(lower[5], lower[3], lower[1], ribbon.modified.bottom, t);
    expect(upperX).toBeCloseTo(lowerX, 10);
    expect(upperX).toBeGreaterThanOrEqual(previousX - 1e-10);
    expect(lowerY).toBeGreaterThan(upperY);
    previousX = upperX;
  }
}

describe('continuous one-sided ribbon geometry', () => {
  it('uses one closed path from the empty-pane edge through the number cells to the changed code edge', () => {
    const original = Object.freeze(boundary(120));
    const modified = Object.freeze(block(140.25, 209.25));
    const ribbon = createRibbon({ ...base, original, modified });
    expect(ribbon.left).toBe(0);
    expect(ribbon.right).toBe(base.gutterLeft + base.gutterWidth);
    expect(ribbon.transitionStart).toBe(base.gutterLeft + base.numberWidth);
    expect(ribbon.transitionEnd).toBe(base.gutterLeft + base.gutterWidth - base.numberWidth);
    expect(ribbon.original).toEqual({ top: 118, bottom: 122 });
    expect(ribbon.modified).toEqual({ top: 140.25, bottom: 209.25 });
    expect(original).toEqual(boundary(120));
    expect(modified).toEqual(block(140.25, 209.25));
    expectHorizontalTangents(ribbon);
  });

  it.each([
    [1, 0, 1], [2, 0, 1], [1.25, 0, 1],
    [1, .375, 1], [2, 41.125, 1], [1.25, -.375, 1],
    [1, 8.35, 1.25], [2, -.15, .8], [1.25, 32.125, 1.25],
  ])('snaps one shared paint strip in actual device pixels (DPR %s, origin %s, scale %s)', (devicePixelRatio, screenOriginY, scaleY) => {
    const semanticY = 142.37;
    const ribbon = createRibbon({ ...base, original: boundary(semanticY), modified: block(100.123, 180.789), devicePixelRatio, screenOriginY, scaleY });
    const topInPixels = (ribbon.original.top * scaleY + screenOriginY) * devicePixelRatio;
    const bottomInPixels = (ribbon.original.bottom * scaleY + screenOriginY) * devicePixelRatio;
    expect(topInPixels).toBeCloseTo(Math.round(topInPixels), 9);
    expect(bottomInPixels).toBeCloseTo(Math.round(bottomInPixels), 9);
    expect(bottomInPixels - topInPixels).toBeCloseTo(Math.max(1, Math.round(emptySideMarkerThicknessPx * devicePixelRatio * scaleY)), 9);
    expect(Math.abs((ribbon.original.top + ribbon.original.bottom) / 2 - semanticY)).toBeLessThanOrEqual(.5 / (devicePixelRatio * scaleY) + 1e-10);
    expect(ribbon.modified).toEqual({ top: 100.123, bottom: 180.789 });
    expectHorizontalTangents(ribbon);
  });

  it.each([
    [boundary(110), block(150, 173)],
    [boundary(210), block(75, 144)],
    [boundary(-15.5), block(250, 950)],
    [boundary(1050), block(-700, -350)],
    [block(10, 33), boundary(110)],
    [block(175, 244), boundary(110)],
    [block(20, 20.25), boundary(20.125)],
  ])('keeps horizontal tangents and noncrossing boundaries above, below, and across small blocks', (original, modified) => {
    const ribbon = createRibbon({ ...base, original, modified, devicePixelRatio: 1.25, screenOriginY: 13.375 });
    expectHorizontalTangents(ribbon);
    expectNoCrossing(ribbon);
  });

  it('mirrors insertion and deletion exactly across an uneven split', () => {
    const original = boundary(123.25), modified = block(50.125, 119.375);
    const options: RibbonOptions = { ...base, original, modified, devicePixelRatio: 2, screenOriginY: .375, scaleY: 1.25 };
    const insertion = createRibbon(options);
    const deletion = createRibbon({ ...options, original: modified, modified: original, gutterLeft: base.viewportWidth - base.gutterLeft - base.gutterWidth });
    expect(deletion.original).toEqual(insertion.modified);
    expect(deletion.modified).toEqual(insertion.original);
    expect(deletion.left).toBeCloseTo(base.viewportWidth - insertion.right, 10);
    expect(deletion.right).toBeCloseTo(base.viewportWidth - insertion.left, 10);
    expect(deletion.transitionStart).toBeCloseTo(base.viewportWidth - insertion.transitionEnd, 10);
    expect(deletion.transitionEnd).toBeCloseTo(base.viewportWidth - insertion.transitionStart, 10);
    expect(deletion.controlOffset).toBeCloseTo(insertion.controlOffset, 10);
    expectHorizontalTangents(deletion);
    expectNoCrossing(deletion);
  });

  it.each([1, 2])('centers four CSS pixels on either empty side at DPR %s without changing block or semantic bounds', devicePixelRatio => {
    expect(emptySideMarkerThicknessPx).toBe(4);
    for (const y of [0, 1, 120, 500]) {
      const empty = Object.freeze(boundary(y)), full = Object.freeze(block(24, 47));
      for (const insertion of [true, false]) {
        const ribbon = createRibbon({ ...base, original: insertion ? empty : full, modified: insertion ? full : empty, devicePixelRatio });
        expect(ribbon[insertion ? 'original' : 'modified']).toEqual({ top: y - 2, bottom: y + 2 });
        expect(ribbon[insertion ? 'modified' : 'original']).toEqual({ top: 24, bottom: 47 });
        expect(empty).toEqual(boundary(y));
        expect(full).toEqual(block(24, 47));
        expectHorizontalTangents(ribbon);
      }
    }
  });

  it.each([1, 2, 1.25])('keeps edge paint centered for viewport clipping at DPR %s', devicePixelRatio => {
    const viewportHeight = 500.375, screenOriginY = 27.325, scaleY = 1.25;
    for (const y of [0, .1, viewportHeight - .1, viewportHeight]) {
      const ribbon = createRibbon({ ...base, original: boundary(y), modified: block(10.125, 33.125), devicePixelRatio, screenOriginY, scaleY });
      expect(Math.abs((ribbon.original.top + ribbon.original.bottom) / 2 - y)).toBeLessThanOrEqual(.5 / (devicePixelRatio * scaleY) + 1e-10);
      if (y < 1) expect(ribbon.original.top).toBeLessThan(0);
      else expect(ribbon.original.bottom).toBeGreaterThan(viewportHeight);
      for (const edge of [ribbon.original.top, ribbon.original.bottom]) {
        const deviceEdge = (edge * scaleY + screenOriginY) * devicePixelRatio;
        expect(deviceEdge).toBeCloseTo(Math.round(deviceEdge), 9);
      }
      expect(ribbon.modified).toEqual({ top: 10.125, bottom: 33.125 });
      expectHorizontalTangents(ribbon);
    }
  });

  it('does not pin genuinely offscreen boundaries onto the viewport edges', () => {
    for (const y of [-100, -.1, 500.1, 600]) {
      const options = { ...base, original: boundary(y), modified: block(10, 33), devicePixelRatio: 2, screenOriginY: .375 };
      const paint = createRibbon(options).original;
      expect(Math.abs((paint.top + paint.bottom) / 2 - y)).toBeLessThanOrEqual(.25);
      expect(paint.bottom - paint.top).toBe(4);
    }
  });

  it('does not snap or extend ordinary replacement block geometry', () => {
    const original = block(12.325, 35.675), modified = block(51.125, 190.25);
    const ribbon = createRibbon({ ...base, original, modified, devicePixelRatio: 2, screenOriginY: .1 });
    expect(ribbon.original).toEqual({ top: original.top, bottom: original.bottom });
    expect(ribbon.modified).toEqual({ top: modified.top, bottom: modified.bottom });
    expect(ribbon.left).toBe(base.gutterLeft);
    expect(ribbon.right).toBe(base.gutterLeft + base.gutterWidth);
    expectHorizontalTangents(ribbon);
    expectNoCrossing(ribbon);
  });
});
