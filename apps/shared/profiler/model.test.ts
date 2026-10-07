import { describe, expect, it } from 'vitest';
import type { ProfilerSnapshot } from './types';
import { appendProfilerSnapshot, formatProfilerBytes, formatProfilerMilliseconds, formatProfilerPercent, measuredValue, profilerAxisMaximum, profilerChartSegments, PROFILER_MAX_SAMPLES } from './model';

const snapshot = (timestamp: number) => ({ timestamp, eventLoopDelayMs: null } as ProfilerSnapshot);

describe('profiler history', () => {
  it('bounds both elapsed history and sample count', () => {
    let history: ProfilerSnapshot[] = [];
    for (let timestamp = 0; timestamp <= 300_000; timestamp += 1_000) history = appendProfilerSnapshot(history, snapshot(timestamp));
    expect(history).toHaveLength(121);
    expect(history[0].timestamp).toBe(180_000);
    for (let timestamp = 300_001; timestamp <= 301_000; timestamp++) history = appendProfilerSnapshot(history, snapshot(timestamp));
    expect(history).toHaveLength(PROFILER_MAX_SAMPLES);
  });

  it('replaces duplicate timestamps, resets on a backwards clock, and ignores invalid time', () => {
    const first = snapshot(1_000), replacement = snapshot(1_000);
    const history = appendProfilerSnapshot([first], replacement);
    expect(history).toEqual([replacement]);
    expect(history[0]).toBe(replacement);
    expect(appendProfilerSnapshot(history, snapshot(500))).toEqual([snapshot(500)]);
    expect(appendProfilerSnapshot(history, snapshot(NaN))).toEqual(history);
  });
});

describe('profiler chart geometry', () => {
  it('keeps null values and pauses as separate segments', () => {
    const points = [{ timestamp: 1_000, value: 10 }, { timestamp: 2_000, value: null }, { timestamp: 3_000, value: 20 }, { timestamp: 4_000, value: 30 }, { timestamp: 9_000, value: 40 }];
    const segments = profilerChartSegments(points, 9_000, 100);
    expect(segments.map(segment => segment.points.map(point => point.timestamp))).toEqual([[1_000], [3_000, 4_000], [9_000]]);
    expect(segments[1].path).toContain(' L');
    expect(segments[0].path).not.toContain('L');
  });

  it('uses the full two-minute time axis and a zero baseline', () => {
    const segments = profilerChartSegments([{ timestamp: 0, value: 0 }, { timestamp: 120_000, value: 100 }], 120_000, 100, { left: 10, top: 20, width: 240, height: 80 });
    expect(segments[0].points[0]).toMatchObject({ x: 10, y: 100 });
    expect(segments[1].points[0]).toMatchObject({ x: 250, y: 20 });
  });

  it('does not paint invalid or out-of-window values', () => {
    const values = [{ timestamp: -1, value: 5 }, { timestamp: 1, value: NaN }, { timestamp: 2, value: -1 }, { timestamp: 3, value: Infinity }, { timestamp: 120_001, value: 6 }];
    expect(profilerChartSegments(values, 120_000, 100)).toEqual([]);
  });

  it('allows multicore CPU totals above 100 and meaningful memory scales', () => {
    expect(profilerAxisMaximum([null, 0, 25], 'percent')).toBe(100);
    expect(profilerAxisMaximum([250, 431], 'percent')).toBe(500);
    expect(profilerAxisMaximum([900], 'percent')).toBe(1_000);
    expect(profilerAxisMaximum([null, 0], 'bytes')).toBe(1024 * 1024);
    expect(profilerAxisMaximum([800 * 1024 * 1024], 'bytes')).toBe(1024 ** 3);
  });

  it('scales timer delay independently of percentages while preserving a zero baseline', () => {
    expect(profilerAxisMaximum([null, 0, 0.3], 'milliseconds')).toBe(10);
    expect(profilerAxisMaximum([12.8], 'milliseconds')).toBe(20);
    expect(profilerAxisMaximum([237], 'milliseconds')).toBe(500);
    const segment = profilerChartSegments([{ timestamp: 1_000, value: 0 }, { timestamp: 2_000, value: 10 }], 2_000, 10);
    expect(segment[0].points.map(point => point.y)).toEqual([72, 8]);
  });
});

describe('profiler measurement formatting', () => {
  it('keeps missing data distinct from measured zero', () => {
    expect(formatProfilerBytes(null)).toBe('Unavailable');
    expect(formatProfilerPercent(undefined)).toBe('Unavailable');
    expect(formatProfilerMilliseconds(null)).toBe('Unavailable');
    expect(formatProfilerBytes(0)).toBe('0 B');
    expect(formatProfilerPercent(0)).toBe('0.0%');
    expect(formatProfilerMilliseconds(0)).toBe('0.0 ms');
    expect(measuredValue(NaN)).toBeNull();
    expect(measuredValue(-1)).toBeNull();
  });

  it('uses binary byte units and unclamped percentage values', () => {
    expect(formatProfilerBytes(1024)).toBe('1.0 KiB');
    expect(formatProfilerBytes(1.5 * 1024 ** 2)).toBe('1.5 MiB');
    expect(formatProfilerBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
    expect(formatProfilerPercent(251.24)).toBe('251.2%');
  });

  it('formats fractional timer delay in milliseconds without inventing unavailable values', () => {
    expect(formatProfilerMilliseconds(0.46)).toBe('0.5 ms');
    expect(formatProfilerMilliseconds(127.34)).toBe('127.3 ms');
    expect(formatProfilerMilliseconds(NaN)).toBe('Unavailable');
    expect(formatProfilerMilliseconds(-1)).toBe('Unavailable');
  });
});
