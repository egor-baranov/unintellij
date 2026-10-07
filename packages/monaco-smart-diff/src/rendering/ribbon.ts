import type { HunkSideGeometry } from './geometry';

/** Shared paint thickness for the empty-pane marker and its connector endpoint. */
export const emptySideMarkerThicknessPx = 4;

export interface RibbonOptions {
  original: HunkSideGeometry;
  modified: HunkSideGeometry;
  /** All X/Y values are in the root overlay's local CSS coordinates. */
  gutterLeft: number;
  viewportWidth: number;
  gutterWidth?: number;
  numberWidth?: number;
  devicePixelRatio?: number;
  /** Root overlay's screen-space CSS Y origin, before conversion to device pixels. */
  screenOriginY?: number;
  /** Screen-space CSS pixels per overlay-local CSS pixel (for a scaled host). */
  scaleY?: number;
}

export interface PaintRange { top: number; bottom: number }
export interface RibbonGeometry {
  d: string;
  /** Paint extents only. The caller retains the zero-height semantic boundary. */
  original: PaintRange;
  modified: PaintRange;
  left: number;
  right: number;
  transitionStart: number;
  transitionEnd: number;
  controlOffset: number;
}

function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

function paintRange(side: HunkSideGeometry, pixelsPerLocalUnit: number, originInPixels: number): PaintRange {
  if (side.kind === 'block') return { top: side.top, bottom: side.bottom };
  // Center the shared marker strip on the boundary, snapping BOTH edges together in
  // actual device coordinates. Snapping independent edges can erase a hairline
  // at fractional scales. The connector consumes these same two paint edges.
  // Let the viewport clip at its edges rather than displacing the marker center.
  const thicknessInPixels = Math.max(1, Math.round(emptySideMarkerThicknessPx * pixelsPerLocalUnit));
  const topInPixels = Math.round(originInPixels + side.top * pixelsPerLocalUnit - thicknessInPixels / 2);
  return {
    top: (topInPixels - originInPixels) / pixelsPerLocalUnit,
    bottom: (topInPixels + thicknessInPixels - originInPixels) / pixelsPerLocalUnit,
  };
}

/** One closed filled ribbon owns the empty-pane marker, number cells, and
 * connector. Only boundary PAINT has finite thickness; no model/layout height
 * is introduced. Nonempty sides stop at the code edge and retain Monaco's exact
 * rendered boundaries so they join the full-line background without overlap. */
export function createRibbon(options: RibbonOptions): RibbonGeometry {
  const {
    original, modified, gutterLeft, viewportWidth,
    gutterWidth = 152, numberWidth = 48, screenOriginY = 0,
  } = options;
  const dpr = positive(options.devicePixelRatio);
  const pixelsPerLocalUnit = dpr * positive(options.scaleY);
  const originalPaint = paintRange(original, pixelsPerLocalUnit, screenOriginY * dpr);
  const modifiedPaint = paintRange(modified, pixelsPerLocalUnit, screenOriginY * dpr);
  const left = original.kind === 'boundary' ? 0 : gutterLeft;
  const right = modified.kind === 'boundary' ? viewportWidth : gutterLeft + gutterWidth;
  const transitionStart = gutterLeft + numberWidth;
  const transitionEnd = gutterLeft + gutterWidth - numberWidth;
  const controlOffset = (transitionEnd - transitionStart) * .42;
  const firstControl = transitionStart + controlOffset;
  const secondControl = transitionEnd - controlOffset;
  // Both boundaries use the same monotonic X curve and horizontal endpoint
  // tangents. Their separation is a convex blend of the endpoint thicknesses,
  // so they cannot cross even when the counterpart is far above or below.
  const d = `M ${left} ${originalPaint.top} H ${transitionStart} C ${firstControl} ${originalPaint.top} ${secondControl} ${modifiedPaint.top} ${transitionEnd} ${modifiedPaint.top} H ${right} V ${modifiedPaint.bottom} H ${transitionEnd} C ${secondControl} ${modifiedPaint.bottom} ${firstControl} ${originalPaint.bottom} ${transitionStart} ${originalPaint.bottom} H ${left} Z`;
  return { d, original: originalPaint, modified: modifiedPaint, left, right, transitionStart, transitionEnd, controlOffset };
}
