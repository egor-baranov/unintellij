import { describe, expect, it } from 'vitest';
import { changeDialogBounds, clampDialogBounds, defaultDialogBounds, type DialogBounds, type DialogGesture } from './dialogBounds';

const viewport = { width: 1400, height: 1000 };
const start: DialogBounds = { left: 200, top: 120, width: 700, height: 500 };
const gestures: Exclude<DialogGesture, 'move'>[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const right = (bounds: DialogBounds) => bounds.left + bounds.width;
const bottom = (bounds: DialogBounds) => bounds.top + bounds.height;

describe('Find in Files dialog geometry', () => {
  it('opens centered at 85% of a normal viewport', () => {
    expect(defaultDialogBounds(viewport)).toEqual({ left: 105, top: 75, width: 1190, height: 850 });
  });

  it.each([{ width: 760, height: 900 }, { width: 1000, height: 540 }, { width: 640, height: 480 }])('fills a compact viewport within the inset (%j)', size => {
    expect(defaultDialogBounds(size)).toEqual({ left: 10, top: 10, width: size.width - 20, height: size.height - 20 });
  });

  it('moves without resizing and stops at every viewport edge', () => {
    expect(changeDialogBounds(start, 'move', 35, 60, viewport)).toEqual({ ...start, left: 235, top: 180 });
    expect(changeDialogBounds(start, 'move', -10000, -10000, viewport)).toEqual({ ...start, left: 10, top: 10 });
    expect(changeDialogBounds(start, 'move', 10000, 10000, viewport)).toEqual({ ...start, left: 690, top: 490 });
  });

  it.each(gestures)('resizes %s from the initial pointer coordinates and keeps untouched edges fixed', gesture => {
    const resized = changeDialogBounds(start, gesture, 30, 40, viewport);
    expect(resized.left).toBe(start.left + (gesture.includes('w') ? 30 : 0));
    expect(right(resized)).toBe(right(start) + (gesture.includes('e') ? 30 : 0));
    expect(resized.top).toBe(start.top + (gesture.includes('n') ? 40 : 0));
    expect(bottom(resized)).toBe(bottom(start) + (gesture.includes('s') ? 40 : 0));
  });

  it.each(gestures)('enforces minimum size without moving the opposite %s resize anchor', gesture => {
    const dx = gesture.includes('w') ? 10000 : -10000;
    const dy = gesture.includes('n') ? 10000 : -10000;
    const resized = changeDialogBounds(start, gesture, dx, dy, viewport);
    if (gesture.includes('w')) { expect(resized.width).toBe(560); expect(right(resized)).toBe(right(start)); }
    else { expect(resized.left).toBe(start.left); expect(resized.width).toBe(gesture.includes('e') ? 560 : start.width); }
    if (gesture.includes('n')) { expect(resized.height).toBe(360); expect(bottom(resized)).toBe(bottom(start)); }
    else { expect(resized.top).toBe(start.top); expect(resized.height).toBe(gesture.includes('s') ? 360 : start.height); }
  });

  it.each(gestures)('enforces maximum size at the viewport edge without moving the opposite %s anchor', gesture => {
    const dx = gesture.includes('w') ? -10000 : 10000;
    const dy = gesture.includes('n') ? -10000 : 10000;
    const resized = changeDialogBounds(start, gesture, dx, dy, viewport);
    expect(resized.left).toBe(gesture.includes('w') ? 10 : start.left);
    expect(right(resized)).toBe(gesture.includes('e') ? viewport.width - 10 : right(start));
    expect(resized.top).toBe(gesture.includes('n') ? 10 : start.top);
    expect(bottom(resized)).toBe(gesture.includes('s') ? viewport.height - 10 : bottom(start));
  });

  it('shrinks the minimum to fit a small viewport for every gesture', () => {
    const tiny = { width: 400, height: 250 };
    const expected = { left: 10, top: 10, width: 380, height: 230 };
    expect(defaultDialogBounds(tiny)).toEqual(expected);
    expect(clampDialogBounds(start, tiny)).toEqual(expected);
    for (const gesture of ['move', ...gestures] as DialogGesture[]) {
      expect(changeDialogBounds(start, gesture, 10000, -10000, tiny)).toEqual(expected);
    }
  });

  it('keeps a moved dialog reachable when the application window shrinks', () => {
    const moved = { left: 680, top: 480, width: 700, height: 500 };
    expect(clampDialogBounds(moved, { width: 1000, height: 800 })).toEqual({ left: 290, top: 290, width: 700, height: 500 });
    expect(clampDialogBounds(moved, { width: 620, height: 430 })).toEqual({ left: 10, top: 10, width: 600, height: 410 });
  });

  it('retains fractional CSS pixels rather than accumulating rounding during dragging', () => {
    expect(changeDialogBounds(start, 'nw', 0.25, 0.75, viewport)).toEqual({ left: 200.25, top: 120.75, width: 699.75, height: 499.25 });
    expect(start).toEqual({ left: 200, top: 120, width: 700, height: 500 });
  });

  it('keeps geometry finite for transient invalid measurements', () => {
    expect(changeDialogBounds(start, 'move', Number.NaN, Number.POSITIVE_INFINITY, viewport)).toEqual(start);
    expect(clampDialogBounds({ left: NaN, top: Infinity, width: NaN, height: -10 }, viewport)).toEqual({ left: 10, top: 10, width: 560, height: 360 });
    for (const size of [{ width: 0, height: 0 }, { width: -1, height: NaN }, { width: 12, height: 8 }]) {
      const bounds = defaultDialogBounds(size);
      expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
      expect(bounds.width).toBeGreaterThanOrEqual(0);
      expect(bounds.height).toBeGreaterThanOrEqual(0);
      expect(right(bounds)).toBeLessThanOrEqual(Math.max(0, size.width));
    }
  });
});
