/** Omission paint has its own metrics: it must never inherit change-marker thickness. */
export const collapsedSeparatorAmplitudePx = 3;
export const collapsedSeparatorWavelengthPx = 12;
export const collapsedSeparatorStrokeWidthPx = 1;
export const collapsedSeparatorRowHeightPx = 18;

export interface OmissionSeparatorOptions {
  /** One common overlay-local CSS coordinate system, including both number columns. */
  xStart: number;
  xOriginalJoin: number;
  xModifiedJoin: number;
  xEnd: number;
  /** Actual rendered view-zone baselines. Offscreen values must not be clamped. */
  originalY: number;
  modifiedY: number;
}

export interface OmissionSeparatorGeometry {
  /** A single open path owns both waves and the central connection. */
  d: string;
  originalY: number;
  modifiedY: number;
  transitionStart: number;
  transitionEnd: number;
  /** Conservative control-hull paint bounds, including half the stroke. */
  bounds: { left: number; right: number; top: number; bottom: number };
}

const period = collapsedSeparatorWavelengthPx;
const quarter = period / 4;
const angularFrequency = 2 * Math.PI / period;

/** Upper bound for every pane-wave control point. The Hermite intervals are at
 * most a quarter wavelength; |envelope'| <= 1.5 / period. Keeping this bound in
 * the cheap culler ensures even a curved segment at a viewport edge survives. */
const waveControlExtent = collapsedSeparatorAmplitudePx * (1 + (2 * Math.PI + 1.5) / 12);

export function omissionIntersectsViewport(originalY: number, modifiedY: number, viewportHeight: number, buffer = 0): boolean {
  if (![originalY, modifiedY, viewportHeight, buffer].every(Number.isFinite) || viewportHeight < 0) return false;
  const paintMargin = waveControlExtent + collapsedSeparatorStrokeWidthPx / 2 + Math.max(0, buffer);
  return Math.max(originalY, modifiedY) + paintMargin >= 0
    && Math.min(originalY, modifiedY) - paintMargin <= viewportHeight;
}

/** Rounded sinusoid with a C1 envelope. The phase comes from the shared X
 * coordinate, never from a pane/DOM boundary. The last wavelength fades to a
 * horizontal baseline at the center, so attaching the cubic introduces no kink. */
function waveAt(x: number, y: number, join: number, side: 'original' | 'modified'): { y: number; slope: number } {
  const direction = side === 'original' ? -1 : 1;
  const distance = direction * (x - join);
  const t = Math.min(1, Math.max(0, distance / period));
  const envelope = t * t * (3 - 2 * t);
  const envelopeSlope = t > 0 && t < 1 ? direction * 6 * t * (1 - t) / period : 0;
  const phase = angularFrequency * x;
  return {
    y: y + collapsedSeparatorAmplitudePx * envelope * Math.sin(phase),
    slope: collapsedSeparatorAmplitudePx * (envelopeSlope * Math.sin(phase) + envelope * angularFrequency * Math.cos(phase)),
  };
}

/** Produce one continuous boundary without changing document or view-zone
 * geometry. Fractional baselines are retained at every DPR: independently
 * snapping pieces would move their joins, while SVG scales this one stroke as
 * a unit (1 CSS px at DPR 1, 2 physical pixels at DPR 2). */
export function createOmissionSeparator(options: OmissionSeparatorOptions): OmissionSeparatorGeometry {
  const { xStart, xOriginalJoin, xModifiedJoin, xEnd, originalY, modifiedY } = options;
  if (!Object.values(options).every(Number.isFinite)
    || xStart > xOriginalJoin || xOriginalJoin > xModifiedJoin || xModifiedJoin > xEnd) {
    throw new RangeError('Omission coordinates must be finite and ordered left to right.');
  }
  let top = Math.min(originalY, modifiedY), bottom = Math.max(originalY, modifiedY);
  const commands: string[] = [];
  const include = (...ys: number[]) => { top = Math.min(top, ...ys); bottom = Math.max(bottom, ...ys); };
  // Three decimals retain sub-device-pixel accuracy while keeping per-frame
  // path updates compact. The same formatting is used on both sides of joins.
  const n = (value: number) => String(Math.round(value * 1000) / 1000);
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    commands.push(`C ${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x)} ${n(y)}`);
    include(y1, y2, y);
  };
  const wave = (start: number, end: number, baseline: number, join: number, side: 'original' | 'modified') => {
    let x = start;
    let point = waveAt(x, baseline, join, side);
    while (x < end) {
      // Shared quarter-wave knots, plus each envelope boundary. The latter
      // prevents a cubic from straddling the full-amplitude/taper transition.
      const phaseKnot = (Math.floor(x / quarter) + 1) * quarter;
      const taperKnot = side === 'original' ? join - period : join + period;
      const nextX = Math.min(end, phaseKnot, taperKnot > x ? taperKnot : Infinity);
      const nextPoint = waveAt(nextX, baseline, join, side);
      const thirdWidth = (nextX - x) / 3;
      cubic(x + thirdWidth, point.y + thirdWidth * point.slope,
        nextX - thirdWidth, nextPoint.y - thirdWidth * nextPoint.slope, nextX, nextPoint.y);
      x = nextX;
      point = nextPoint;
    }
  };
  const first = waveAt(xStart, originalY, xOriginalJoin, 'original');
  commands.push(`M ${n(xStart)} ${n(first.y)}`);
  include(first.y);
  wave(xStart, xOriginalJoin, originalY, xOriginalJoin, 'original');
  const controlOffset = (xModifiedJoin - xOriginalJoin) * .42;
  cubic(xOriginalJoin + controlOffset, originalY, xModifiedJoin - controlOffset, modifiedY, xModifiedJoin, modifiedY);
  wave(xModifiedJoin, xEnd, modifiedY, xModifiedJoin, 'modified');
  // Include path-coordinate rounding in the conservative paint bounds.
  const halfStroke = collapsedSeparatorStrokeWidthPx / 2 + .0005;
  return {
    d: commands.join(' '), originalY, modifiedY,
    transitionStart: xOriginalJoin, transitionEnd: xModifiedJoin,
    bounds: { left: xStart - halfStroke, right: xEnd + halfStroke, top: top - halfStroke, bottom: bottom + halfStroke },
  };
}
