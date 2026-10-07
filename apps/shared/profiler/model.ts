import type { ProfilerSnapshot } from './types';

export const PROFILER_HISTORY_MS = 120_000;
export const PROFILER_MAX_SAMPLES = 121;
export const PROFILER_SAMPLE_MS = 1_000;

export function appendProfilerSnapshot(history: readonly ProfilerSnapshot[], sample: ProfilerSnapshot): ProfilerSnapshot[] {
  if (!Number.isFinite(sample.timestamp)) return [...history];
  if (history.length && sample.timestamp < history[history.length - 1].timestamp) return [sample];
  return [...history.filter(item => item.timestamp >= sample.timestamp - PROFILER_HISTORY_MS && item.timestamp < sample.timestamp), sample].slice(-PROFILER_MAX_SAMPLES);
}

export function measuredValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatProfilerBytes(value: number | null | undefined): string {
  const bytes = measuredValue(value);
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length, Math.floor(Math.log2(bytes) / 10));
  const amount = bytes / 1024 ** exponent;
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[exponent - 1]}`;
}

export function formatProfilerPercent(value: number | null | undefined): string {
  const percent = measuredValue(value);
  return percent === null ? 'Unavailable' : `${percent.toFixed(1)}%`;
}

export function formatProfilerMilliseconds(value: number | null | undefined): string {
  const milliseconds = measuredValue(value);
  return milliseconds === null ? 'Unavailable' : `${milliseconds.toFixed(1)} ms`;
}

/** Every chart starts at zero; CPU totals are intentionally allowed above 100%. */
export function profilerAxisMaximum(values: readonly (number | null)[], unit: 'bytes' | 'percent' | 'milliseconds'): number {
  const minimum = unit === 'bytes' ? 1024 * 1024 : unit === 'percent' ? 100 : 10;
  const largest = values.reduce<number>((max, value) => Math.max(max, measuredValue(value) ?? 0), minimum);
  if (unit === 'bytes') return 2 ** Math.ceil(Math.log2(largest));
  const magnitude = 10 ** Math.floor(Math.log10(largest));
  return ([1, 2, 5, 10].find(step => step * magnitude >= largest) ?? 10) * magnitude;
}

export interface ProfilerPoint { timestamp: number; value: number | null }
export interface ProfilerChartPoint { x: number; y: number; timestamp: number; value: number }
export interface ProfilerChartSegment { path: string; points: ProfilerChartPoint[] }

/** Null samples and pauses form gaps, never a fabricated zero or a connecting line. */
export function profilerChartSegments(
  samples: readonly ProfilerPoint[],
  end: number,
  maximum: number,
  bounds = { left: 53, top: 8, width: 259, height: 64 },
): ProfilerChartSegment[] {
  const segments: ProfilerChartSegment[] = [];
  let points: ProfilerChartPoint[] = [];
  const flush = () => {
    if (points.length) segments.push({ points, path: points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ') });
    points = [];
  };
  const start = end - PROFILER_HISTORY_MS;
  for (const sample of samples) {
    const value = measuredValue(sample.value);
    if (!Number.isFinite(sample.timestamp) || sample.timestamp < start || sample.timestamp > end || value === null) { flush(); continue; }
    const previous = points[points.length - 1];
    if (previous && (sample.timestamp - previous.timestamp > PROFILER_SAMPLE_MS * 2.5 || sample.timestamp <= previous.timestamp)) flush();
    points.push({
      x: bounds.left + (sample.timestamp - start) / PROFILER_HISTORY_MS * bounds.width,
      y: bounds.top + bounds.height * (1 - Math.min(1, value / Math.max(1, maximum))),
      timestamp: sample.timestamp, value,
    });
  }
  flush();
  return segments;
}
