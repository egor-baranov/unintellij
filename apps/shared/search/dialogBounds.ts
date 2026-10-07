export interface DialogBounds { left: number; top: number; width: number; height: number }
export interface DialogViewport { width: number; height: number }
export type DialogGesture = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const DIALOG_VIEWPORT_INSET = 10;
export const DIALOG_MIN_WIDTH = 560;
export const DIALOG_MIN_HEIGHT = 360;

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function limits(viewport: DialogViewport) {
  const width = Math.max(0, finite(viewport.width, 0));
  const height = Math.max(0, finite(viewport.height, 0));
  // Extremely small/temporarily hidden windows cannot retain a full 10px inset.
  const left = Math.min(DIALOG_VIEWPORT_INSET, width / 2);
  const top = Math.min(DIALOG_VIEWPORT_INSET, height / 2);
  const right = width - left;
  const bottom = height - top;
  return {
    left, top, right, bottom,
    maxWidth: right - left, maxHeight: bottom - top,
    minWidth: Math.min(DIALOG_MIN_WIDTH, right - left),
    minHeight: Math.min(DIALOG_MIN_HEIGHT, bottom - top),
  };
}

/** Keep the complete dialog reachable after moving or resizing the application window. */
export function clampDialogBounds(bounds: DialogBounds, viewport: DialogViewport): DialogBounds {
  const frame = limits(viewport);
  const width = clamp(finite(bounds.width, frame.minWidth), frame.minWidth, frame.maxWidth);
  const height = clamp(finite(bounds.height, frame.minHeight), frame.minHeight, frame.maxHeight);
  return {
    left: clamp(finite(bounds.left, frame.left), frame.left, frame.right - width),
    top: clamp(finite(bounds.top, frame.top), frame.top, frame.bottom - height),
    width, height,
  };
}

export function defaultDialogBounds(viewport: DialogViewport): DialogBounds {
  const frame = limits(viewport);
  const compact = viewport.width <= 760 || viewport.height <= 540;
  const width = compact ? frame.maxWidth : viewport.width * 0.85;
  const height = compact ? frame.maxHeight : viewport.height * 0.85;
  return clampDialogBounds({ left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, height }, viewport);
}

/** Resize the dragged edges only. Min/max constraints preserve the opposite anchor. */
export function changeDialogBounds(start: DialogBounds, gesture: DialogGesture, dx: number, dy: number, viewport: DialogViewport): DialogBounds {
  const bounds = clampDialogBounds(start, viewport);
  const frame = limits(viewport);
  const horizontal = finite(dx, 0);
  const vertical = finite(dy, 0);
  if (gesture === 'move') {
    return {
      ...bounds,
      left: clamp(bounds.left + horizontal, frame.left, frame.right - bounds.width),
      top: clamp(bounds.top + vertical, frame.top, frame.bottom - bounds.height),
    };
  }
  let left = bounds.left;
  let right = left + bounds.width;
  let top = bounds.top;
  let bottom = top + bounds.height;
  if (gesture.includes('w')) left = clamp(left + horizontal, frame.left, right - frame.minWidth);
  if (gesture.includes('e')) right = clamp(right + horizontal, left + frame.minWidth, frame.right);
  if (gesture.includes('n')) top = clamp(top + vertical, frame.top, bottom - frame.minHeight);
  if (gesture.includes('s')) bottom = clamp(bottom + vertical, top + frame.minHeight, frame.bottom);
  return { left, top, width: right - left, height: bottom - top };
}
