import { describe, expect, it } from 'vitest';
import {
  collapsedSeparatorAmplitudePx, collapsedSeparatorRowHeightPx, collapsedSeparatorStrokeWidthPx,
  collapsedSeparatorWavelengthPx, createOmissionSeparator, omissionIntersectsViewport,
  type OmissionSeparatorOptions,
} from './omission';

type Point = { x: number; y: number };
type Curve = { from: Point; first: Point; second: Point; to: Point };
const base: OmissionSeparatorOptions = {
  xStart: 0, xOriginalJoin: 461.375, xModifiedJoin: 517.375, xEnd: 1000,
  originalY: 120.25, modifiedY: 310.75,
};

function curves(d: string): Curve[] {
  const pieces = [...d.matchAll(/([MC])([^MC]*)/g)];
  const [x, y] = pieces[0][2].trim().split(/\s+/).map(Number);
  let point = { x, y };
  return pieces.slice(1).map(([, command, values]) => {
    expect(command).toBe('C');
    const numbers = values.trim().split(/\s+/).map(Number);
    expect(numbers).toHaveLength(6);
    const curve = {
      from: point, first: { x: numbers[0], y: numbers[1] },
      second: { x: numbers[2], y: numbers[3] }, to: { x: numbers[4], y: numbers[5] },
    };
    point = curve.to;
    return curve;
  });
}

function bezier(start: number, first: number, second: number, end: number, t: number): number {
  return (1 - t) ** 3 * start + 3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3 * end;
}

function pointAt(curve: Curve, t: number): Point {
  return {
    x: bezier(curve.from.x, curve.first.x, curve.second.x, curve.to.x, t),
    y: bezier(curve.from.y, curve.first.y, curve.second.y, curve.to.y, t),
  };
}

function atX(path: Curve[], x: number): Point {
  const curve = path.find(part => part.from.x <= x && part.to.x >= x)!;
  expect(curve).toBeDefined();
  let lower = 0, upper = 1;
  for (let n = 0; n < 40; n++) {
    const middle = (lower + upper) / 2;
    if (pointAt(curve, middle).x < x) lower = middle;
    else upper = middle;
  }
  return pointAt(curve, (lower + upper) / 2);
}

function transition(path: Curve[], options = base): { center: Curve; before: Curve; after: Curve } {
  const index = path.findIndex(part => part.from.x === options.xOriginalJoin && part.to.x === options.xModifiedJoin);
  expect(index).toBeGreaterThan(0);
  return { center: path[index], before: path[index - 1], after: path[index + 1] };
}

describe('connected omission separator geometry', () => {
  it('uses dedicated omission metrics with room around the wave in a compact row', () => {
    expect(collapsedSeparatorAmplitudePx).toBe(3);
    expect(collapsedSeparatorWavelengthPx).toBe(12);
    expect(collapsedSeparatorStrokeWidthPx).toBe(1);
    expect(collapsedSeparatorRowHeightPx).toBe(18);
    expect(2 * collapsedSeparatorAmplitudePx + collapsedSeparatorStrokeWidthPx).toBeLessThan(collapsedSeparatorRowHeightPx);
  });

  it('creates one open continuous path across both pane and line-number areas', () => {
    const geometry = createOmissionSeparator(base);
    const path = curves(geometry.d);
    expect(geometry.d.match(/M/g)).toHaveLength(1);
    expect(geometry.d).not.toMatch(/[HLVZ]/);
    expect(path[0].from).toEqual({ x: base.xStart, y: base.originalY });
    expect(path.at(-1)!.to.x).toBe(base.xEnd);
    expect(geometry.transitionStart).toBe(base.xOriginalJoin);
    expect(geometry.transitionEnd).toBe(base.xModifiedJoin);
    for (let index = 1; index < path.length; index++) expect(path[index].from).toEqual(path[index - 1].to);
  });

  it.each([[180, 180], [120, 310], [390, 80], [-120, 750], [850, -150]])(
    'joins both waves horizontally to the true omission baselines (%s, %s)', (originalY, modifiedY) => {
      const options = { ...base, originalY, modifiedY };
      const geometry = createOmissionSeparator(options);
      const path = curves(geometry.d);
      const { center, before, after } = transition(path, options);
      expect(before.to).toEqual({ x: base.xOriginalJoin, y: originalY });
      expect(before.second.y).toBe(originalY);
      expect(center.first.y).toBe(originalY);
      expect(center.second.y).toBe(modifiedY);
      expect(center.to).toEqual({ x: base.xModifiedJoin, y: modifiedY });
      expect(after.first.y).toBe(modifiedY);
      expect(geometry.originalY).toBe(originalY);
      expect(geometry.modifiedY).toBe(modifiedY);
      for (let step = 0; step <= 100; step++) {
        const point = pointAt(center, step / 100);
        expect(point.y).toBeGreaterThanOrEqual(Math.min(originalY, modifiedY) - 1e-9);
        expect(point.y).toBeLessThanOrEqual(Math.max(originalY, modifiedY) + 1e-9);
      }
    },
  );

  it('keeps the pane waveform rounded and tangent-continuous, including taper knots', () => {
    const path = curves(createOmissionSeparator(base).d);
    for (let index = 1; index < path.length; index++) {
      const before = path[index - 1], after = path[index];
      const incoming = (before.to.y - before.second.y) / (before.to.x - before.second.x);
      const outgoing = (after.first.y - after.from.y) / (after.first.x - after.from.x);
      expect(Math.abs(incoming - outgoing)).toBeLessThan(.006);
    }
    // Fully developed sine peaks and troughs are six CSS pixels apart.
    expect(atX(path, 3).y).toBeCloseTo(base.originalY + 3, 3);
    expect(atX(path, 9).y).toBeCloseTo(base.originalY - 3, 3);
    expect(atX(path, 543).y).toBeCloseTo(base.modifiedY + 3, 3);
    expect(atX(path, 549).y).toBeCloseTo(base.modifiedY - 3, 3);
  });

  it('retains a common phase through resize and does not restart it at pane boundaries', () => {
    const first = curves(createOmissionSeparator(base).d);
    const resized = curves(createOmissionSeparator({ ...base, xStart: 2.25, xOriginalJoin: 471.75, xModifiedJoin: 527.75, xEnd: 1130 }).d);
    for (const x of [24, 25.5, 27, 39, 80.2, 570, 577.5, 601.25, 800]) {
      expect(atX(first, x).y).toBeCloseTo(atX(resized, x).y, 3);
    }
  });

  it.each([1, 2])('keeps exact shared CSS joins and stroke width at DPR %s', dpr => {
    const options = { ...base, originalY: 120.125, modifiedY: 310.375 };
    const geometry = createOmissionSeparator(options);
    const { center, before, after } = transition(curves(geometry.d), options);
    expect(before.to.y * dpr).toBe(options.originalY * dpr);
    expect(center.from.y * dpr).toBe(options.originalY * dpr);
    expect(center.to.y * dpr).toBe(options.modifiedY * dpr);
    expect(after.from.y * dpr).toBe(options.modifiedY * dpr);
    expect(collapsedSeparatorStrokeWidthPx * dpr).toBe(dpr);
    expect(collapsedSeparatorAmplitudePx * dpr).toBe(3 * dpr);
  });

  it('preserves distinct correspondence geometry even for equal-sized hidden regions', () => {
    // The caller owns canonical region IDs; counts and visible-order indices
    // are deliberately absent from the geometry contract.
    const upper = createOmissionSeparator({ ...base, originalY: 50, modifiedY: 220 });
    const lower = createOmissionSeparator({ ...base, originalY: 260, modifiedY: 430 });
    expect(upper.d).not.toBe(lower.d);
    expect(upper.originalY).toBe(50);
    expect(upper.modifiedY).toBe(220);
    expect(lower.originalY).toBe(260);
    expect(lower.modifiedY).toBe(430);
  });

  it('retains offscreen endpoints and culls only when even the curved stroke cannot enter the viewport', () => {
    for (const [originalY, modifiedY] of [[-100, 300], [150, 700], [-200, 900], [900, -200], [-2, -2], [502, 502]]) {
      expect(omissionIntersectsViewport(originalY, modifiedY, 500)).toBe(true);
      const geometry = createOmissionSeparator({ ...base, originalY, modifiedY });
      expect(geometry.originalY).toBe(originalY);
      expect(geometry.modifiedY).toBe(modifiedY);
    }
    expect(omissionIntersectsViewport(-20, -10, 500)).toBe(false);
    expect(omissionIntersectsViewport(520, 510, 500)).toBe(false);
    expect(omissionIntersectsViewport(520, 510, 500, 10)).toBe(true);
    expect(omissionIntersectsViewport(NaN, 20, 500)).toBe(false);
  });

  it('bounds every painted segment, including highly unequal endpoints and a narrow pane', () => {
    for (const options of [base, { ...base, originalY: -200, modifiedY: 1200 }, { ...base, xStart: 460.25, xEnd: 519 }]) {
      const geometry = createOmissionSeparator(options);
      const halfStroke = collapsedSeparatorStrokeWidthPx / 2;
      for (const curve of curves(geometry.d)) {
        for (let step = 0; step <= 20; step++) {
          const point = pointAt(curve, step / 20);
          expect(point.y - halfStroke).toBeGreaterThanOrEqual(geometry.bounds.top - 1e-9);
          expect(point.y + halfStroke).toBeLessThanOrEqual(geometry.bounds.bottom + 1e-9);
          expect(point.x - halfStroke).toBeGreaterThanOrEqual(geometry.bounds.left - 1e-9);
          expect(point.x + halfStroke).toBeLessThanOrEqual(geometry.bounds.right + 1e-9);
        }
      }
    }
  });

  it('is deterministic and does not mutate input geometry', () => {
    const options = Object.freeze({ ...base });
    expect(createOmissionSeparator(options)).toEqual(createOmissionSeparator(options));
    expect(options).toEqual(base);
    expect(() => createOmissionSeparator({ ...base, modifiedY: Infinity })).toThrow(RangeError);
    expect(() => createOmissionSeparator({ ...base, xOriginalJoin: 800 })).toThrow(RangeError);
  });
});
