import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateProfilerProcesses, measureProfilerLoopDelay, profilerEventLoopUtilization, profilerGpuDevice, ProfilerService, scanProfilerDisk, type ProfilerMetric, type ProfilerServiceOptions } from './profiler';
import type { ProfilerSnapshot } from '../../shared/profiler/types';

const roots: string[] = [];
const services: ProfilerService[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-profiler-'));
  roots.push(root);
  return root;
}
function metric(pid: number, overrides: Partial<ProfilerMetric> = {}): ProfilerMetric {
  return { pid, creationTime: pid * 100, type: 'Browser', cpu: { percentCPUUsage: 12.5, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 100 }, ...overrides };
}
const readyDisk: ProfilerSnapshot['disk'] = { bytes: 123, files: 2, sampledAt: 100, status: 'ready' };
function serviceFixture(overrides: Partial<ProfilerServiceOptions> = {}) {
  let now = 0;
  const getAppMetrics = vi.fn(() => [metric(1), metric(2, { type: 'GPU' })]);
  const getGPUInfo = vi.fn(async () => ({ gpuDevice: [{ active: true, deviceString: 'Test GPU' }], secret: 'never forwarded' }));
  const scanDisk = vi.fn(async () => readyDisk);
  const service = new ProfilerService({
    roots: ['/app-data'], getAppMetrics, getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }), getGPUInfo, scanDisk,
    now: () => now, monotonicNow: () => now, logicalCpuCount: 8, measureLoopDelay: async () => 2.5, ...overrides,
  });
  services.push(service);
  return { service, getAppMetrics, getGPUInfo, scanDisk, advance: (milliseconds: number) => { now += milliseconds; } };
}
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

describe('profiler process measurements', () => {
  it('does not report Electron all-zero event-loop counters as measured idle', () => {
    const zero = { active: 0, idle: 0, utilization: 0 };
    expect(profilerEventLoopUtilization(zero, undefined)).toBeNull();
    expect(profilerEventLoopUtilization(zero, zero)).toBeNull();
    expect(profilerEventLoopUtilization({ active: 10, idle: 30, utilization: 0.25 }, zero)).toBe(0.25);
    expect(profilerEventLoopUtilization({ active: 10, idle: 30, utilization: 0.25 }, { active: 10, idle: 10, utilization: 0.5 })).toBe(0);
  });

  it('uses null for first CPU intervals and converts KiB working sets to bytes', () => {
    const first = aggregateProfilerProcesses([metric(1), metric(2, { type: 'GPU' })], new Set(), 8);
    expect(first.cpuPercent).toBeNull();
    expect(first.processes.map(item => item.cpuPercent)).toEqual([null, null]);
    expect(first.memoryBytes).toBe(200 * 1024);
  });

  it('converts Electron whole-machine CPU to one-core=100% without capping multi-core use', () => {
    const records = [metric(1), metric(2, { cpu: { percentCPUUsage: 25, idleWakeupsPerSecond: 0 } })];
    const result = aggregateProfilerProcesses([...records, records[0]], new Set(['1:100', '2:200']), 8);
    expect(result.processes.map(item => item.cpuPercent)).toEqual([100, 200]);
    expect(result.cpuPercent).toBe(300);
    expect(result.memoryBytes).toBe(200 * 1024);
  });

  it('restarts the baseline for a reused PID and keeps unavailable Linux memory unknown', () => {
    const result = aggregateProfilerProcesses([metric(1, { creationTime: 101, memory: undefined })], new Set(['1:100']), 8);
    expect(result.processes[0]).toMatchObject({ pid: 1, createdAt: 101, cpuPercent: null, memoryBytes: null });
    expect(result.cpuPercent).toBeNull();
    expect(result.memoryBytes).toBeNull();
  });

  it('does not turn invalid or incomplete measurements into convincing totals', () => {
    const records = [metric(1), metric(2, { cpu: { percentCPUUsage: -1, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: NaN } })];
    const result = aggregateProfilerProcesses(records, new Set(['1:100', '2:200']), 8);
    expect(result.processes[0].cpuPercent).toBe(100);
    expect(result.processes[1]).toMatchObject({ cpuPercent: null, memoryBytes: null });
    expect(result.cpuPercent).toBeNull();
    expect(result.memoryBytes).toBeNull();
    expect(aggregateProfilerProcesses([], new Set(), 8)).toMatchObject({ cpuPercent: null, memoryBytes: null });
  });

  it('reduces GPU information to a bounded selected-device description', () => {
    expect(profilerGpuDevice({ gpuDevice: [{ deviceString: 'Inactive' }, { active: true, vendorString: 'Example', deviceString: '\u0000Graphics\n' }], driver: 'private extra data' })).toBe('Example Graphics');
    expect(profilerGpuDevice({ gpuDevice: [{ vendorId: 0x8086, deviceId: 0x1234 }] })).toBe('GPU 0x8086:0x1234');
    expect(profilerGpuDevice({ gpuDevice: [{ deviceString: 'x'.repeat(500) }] })).toHaveLength(120);
    expect(profilerGpuDevice({ gpuDevice: 'unexpected' })).toBeNull();
  });
});

describe('one-shot main-loop delay probe', () => {
  it('measures actual scheduling lateness and leaves no recurring timer', async () => {
    vi.useFakeTimers();
    let elapsed = 100;
    const pending = measureProfilerLoopDelay(undefined, () => elapsed);
    expect(vi.getTimerCount()).toBe(1);
    elapsed = 157;
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe(37);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its pending timer on disposal and does not start when already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = measureProfilerLoopDelay(controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(await measureProfilerLoopDelay(controller.signal)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('bounded app-data disk measurements', () => {
  it('streams only configured roots, deduplicates nested roots, and skips file and directory symlinks', async () => {
    const parent = await fixture();
    const userData = path.join(parent, 'user-data');
    const sessionData = path.join(userData, 'session');
    const unrelated = path.join(parent, 'repository');
    await mkdir(sessionData, { recursive: true });
    await mkdir(unrelated);
    await writeFile(path.join(userData, 'settings.json'), 'abc');
    await writeFile(path.join(sessionData, 'cache'), '12345');
    await writeFile(path.join(unrelated, 'source.ts'), 'not app data');
    await symlink(unrelated, path.join(userData, 'linked-repo'));
    await symlink(path.join(unrelated, 'source.ts'), path.join(userData, 'linked-file'));
    const disk = await scanProfilerDisk([sessionData, userData, userData], { now: () => 123 });
    expect(disk).toEqual({ bytes: 8, files: 2, sampledAt: 123, status: 'ready' });
  });

  it('bounds entry count and returns the measured subset explicitly as partial', async () => {
    const root = await fixture();
    await Promise.all(['a', 'b', 'c', 'd'].map(name => writeFile(path.join(root, name), '1234567890')));
    const disk = await scanProfilerDisk([root], { maxEntries: 2 });
    expect(disk).toMatchObject({ bytes: 20, files: 2, status: 'partial' });
    expect(disk.reason).toContain('2 entries');
  });

  it('bounds elapsed time and recursion depth without claiming a complete size', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'cache'), 'nested');
    await writeFile(path.join(root, 'settings'), 'root');
    const depth = await scanProfilerDisk([root], { maxDepth: 0 });
    expect(depth).toMatchObject({ bytes: 4, files: 1, status: 'partial' });
    let elapsed = 0;
    const timed = await scanProfilerDisk([root], { maxDurationMs: 4, monotonicNow: () => elapsed++ });
    expect(timed.status).toBe('partial');
    expect(timed.reason).toContain('time limit');
  });

  it('treats an uncreated cache as empty, skips symlink roots, and preserves other measured roots on failures', async () => {
    const parent = await fixture();
    const data = path.join(parent, 'data');
    const alias = path.join(parent, 'alias');
    await mkdir(data);
    await writeFile(path.join(data, 'file'), 'data');
    await symlink(data, alias);
    expect(await scanProfilerDisk([path.join(parent, 'not-created')])).toMatchObject({ bytes: 0, files: 0, status: 'ready' });
    expect(await scanProfilerDisk([alias])).toMatchObject({ bytes: null, files: 0, status: 'unavailable' });
    expect(await scanProfilerDisk([data, path.join(data, 'file') + '-missing', alias])).toMatchObject({ bytes: 4, files: 1, status: 'partial' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable descendants as partial and continues other files', async () => {
    const root = await fixture();
    const blocked = path.join(root, 'blocked');
    await mkdir(blocked);
    await writeFile(path.join(blocked, 'secret'), 'unreadable');
    await writeFile(path.join(root, 'settings'), 'ok');
    await chmod(blocked, 0);
    try { expect(await scanProfilerDisk([root])).toMatchObject({ bytes: 2, files: 1, status: 'partial' }); }
    finally { await chmod(blocked, 0o700); }
  });

  it('cooperatively cancels without publishing an empty completed measurement', async () => {
    const root = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await scanProfilerDisk([root], { signal: controller.signal })).toMatchObject({ bytes: null, files: 0, status: 'unavailable', reason: 'Scan cancelled.' });
  });
});

describe('shared profiler service', () => {
  it('collects from startup and continues without a panel or snapshot reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { service, getAppMetrics, scanDisk } = serviceFixture({ now: Date.now, monotonicNow: Date.now });
    expect(service.readHistory()).toEqual([]);
    expect(getAppMetrics).not.toHaveBeenCalled();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.readHistory()).toHaveLength(1);
    expect(service.readHistory()[0].cpuPercent).toBeNull();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(service.readHistory().map(sample => sample.timestamp)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(service.readHistory().at(-1)?.cpuPercent).toBe(200);
    expect(getAppMetrics).toHaveBeenCalledTimes(5);
    expect(scanDisk).toHaveBeenCalledTimes(1);
  });

  it('starts only one unreferenced timer and coalesces reads without duplicating history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { service, getAppMetrics } = serviceFixture({ now: Date.now, monotonicNow: Date.now });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    service.start();
    service.start();
    await Promise.all([service.readSnapshot(), service.readSnapshot()]);
    expect(service.readHistory()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(timeout.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    service.start();
    await service.readSnapshot();
    expect(service.readHistory()).toHaveLength(2);
    expect(getAppMetrics).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    timeout.mockRestore();
  });

  it('keeps history bounded to two minutes and detached from returned snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { service } = serviceFixture({ now: Date.now, monotonicNow: Date.now });
    service.start();
    await vi.advanceTimersByTimeAsync(125_000);
    const history = service.readHistory();
    expect(history).toHaveLength(121);
    expect(history[0].timestamp).toBe(5_000);
    expect(history.at(-1)?.timestamp).toBe(125_000);
    history[0].processes[0].name = 'Changed by a reader';
    history[0].disk.bytes = 999;
    history.pop();
    const snapshot = await service.readSnapshot();
    snapshot.gpu.device = 'Changed by a snapshot reader';
    const unchanged = service.readHistory();
    expect(unchanged).toHaveLength(121);
    expect(unchanged[0].processes[0].name).toBe('Browser');
    expect(unchanged[0].disk.bytes).toBe(123);
    expect(unchanged.at(-1)?.gpu.device).toBe('Test GPU');
  });

  it('does not overlap a slow sample and clears history without publishing pre-clear work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish: ((delay: number) => void) | undefined;
    const measureLoopDelay = vi.fn().mockResolvedValue(2.5).mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const { service, getAppMetrics } = serviceFixture({ now: Date.now, monotonicNow: Date.now, measureLoopDelay });
    service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(service.readHistory()).toEqual([]);
    service.clearHistory();
    finish!(20);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.readHistory()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.readHistory().map(sample => sample.timestamp)).toEqual([3_001]);
    service.clearHistory();
    expect(service.readHistory()).toEqual([]);
    // A still-cached snapshot must not resurrect a cleared sample.
    await service.readSnapshot();
    expect(service.readHistory()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.readHistory().map(sample => sample.timestamp)).toEqual([4_001]);
  });

  it('recovers the startup sampling loop after a failed measurement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const now = vi.fn().mockImplementation(Date.now).mockImplementationOnce(() => { throw new Error('measurement failed'); });
    const { service, getAppMetrics } = serviceFixture({ now, monotonicNow: Date.now });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.readHistory()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.readHistory().map(sample => sample.timestamp)).toEqual([1_000]);
    expect(getAppMetrics).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops collection on disposal and ignores a pending sample completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish: ((delay: number) => void) | undefined;
    const measureLoopDelay = vi.fn().mockResolvedValue(2.5).mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const { service, getAppMetrics } = serviceFixture({ now: Date.now, monotonicNow: Date.now, measureLoopDelay });
    service.start();
    await vi.advanceTimersByTimeAsync(500);
    service.dispose();
    finish!(20);
    await vi.advanceTimersByTimeAsync(5_000);
    service.start();
    expect(service.readHistory()).toEqual([]);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.readSnapshot()).rejects.toThrow('disposed');
  });

  it('clears an already scheduled timer and history on disposal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { service, getAppMetrics } = serviceFixture({ now: Date.now, monotonicNow: Date.now });
    service.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.readHistory()).toHaveLength(3);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.readHistory()).toEqual([]);
    expect(getAppMetrics).toHaveBeenCalledTimes(3);
  });

  it('coalesces simultaneous window reads and advances CPU/event-loop intervals only once a second', async () => {
    const { service, getAppMetrics, getGPUInfo, advance } = serviceFixture();
    const [first, same] = await Promise.all([service.readSnapshot(), service.readSnapshot()]);
    expect(same).toBe(first);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ cpuPercent: null, eventLoopUtilization: null, eventLoopDelayMs: 2.5, disk: { status: 'measuring' }, gpu: { cpuPercent: null, utilizationPercent: null } });
    await settle();
    advance(999);
    expect(await service.readSnapshot()).toBe(first);
    advance(1);
    const next = await service.readSnapshot();
    expect(getAppMetrics).toHaveBeenCalledTimes(2);
    expect(getGPUInfo).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ cpuPercent: 200, memoryBytes: 200 * 1024, disk: readyDisk, gpu: { status: 'enabled', device: 'Test GPU', cpuPercent: 100, processMemoryBytes: 100 * 1024, utilizationPercent: null } });
    expect(next.eventLoopUtilization).toBeGreaterThanOrEqual(0);
    expect(next.eventLoopUtilization).toBeLessThanOrEqual(1);
    expect(next.heapUsedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(next)).not.toContain('never forwarded');
  });

  it('coalesces an asynchronous probe across concurrent windows, even past the cache interval', async () => {
    let finish: ((delay: number) => void) | undefined;
    const measureLoopDelay = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const { service, getAppMetrics, advance } = serviceFixture({ measureLoopDelay });
    const first = service.readSnapshot();
    advance(1_500);
    const second = service.readSnapshot();
    expect(first).toBe(second);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(measureLoopDelay).toHaveBeenCalledTimes(1);
    finish!(123.4);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left.eventLoopDelayMs).toBe(123.4);
  });

  it('retains other measurements if the optional timer probe is unavailable', async () => {
    const { service } = serviceFixture({ measureLoopDelay: async () => { throw new Error('probe unavailable'); } });
    expect(await service.readSnapshot()).toMatchObject({ eventLoopDelayMs: null, memoryBytes: 200 * 1024 });
  });

  it('disposes an in-flight timer probe without publishing its eventual result', async () => {
    vi.useFakeTimers();
    const { service } = serviceFixture({ measureLoopDelay: measureProfilerLoopDelay });
    const pending = service.readSnapshot();
    expect(vi.getTimerCount()).toBe(1);
    service.dispose();
    expect((await pending).eventLoopDelayMs).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.readSnapshot()).rejects.toThrow('disposed');
  });

  it('preserves on-demand disk measurement compatibility until explicitly started', async () => {
    let finish: ((disk: ProfilerSnapshot['disk']) => void) | undefined;
    const scanDisk = vi.fn(() => new Promise<ProfilerSnapshot['disk']>(resolve => { finish = resolve; }));
    const { service, advance } = serviceFixture({ scanDisk });
    await service.readSnapshot();
    await settle();
    advance(30_000);
    await service.readSnapshot();
    expect(scanDisk).toHaveBeenCalledTimes(1);
    finish!(readyDisk);
    await settle();
    advance(1_000);
    await service.readSnapshot();
    await settle();
    expect(scanDisk).toHaveBeenCalledTimes(2);
    finish!(readyDisk);
    await settle();
    advance(120_000);
    await settle();
    expect(scanDisk).toHaveBeenCalledTimes(2);
  });

  it('warms up CPU and event-loop measurements again after a gap between legacy reads', async () => {
    const { service, advance } = serviceFixture();
    await service.readSnapshot();
    advance(1_000);
    expect((await service.readSnapshot()).cpuPercent).toBe(200);
    advance(5_001);
    expect(await service.readSnapshot()).toMatchObject({ cpuPercent: null, eventLoopUtilization: null, eventLoopDelayMs: 2.5, gpu: { cpuPercent: null } });
    advance(1_000);
    const resumed = await service.readSnapshot();
    expect(resumed.cpuPercent).toBe(200);
    expect(resumed.eventLoopUtilization).not.toBeNull();
  });

  it('keeps completed disk data cached and handles scanner failures without rejecting sampling', async () => {
    const scanDisk = vi.fn().mockResolvedValueOnce(readyDisk).mockRejectedValueOnce(new Error('denied'));
    const { service, advance } = serviceFixture({ scanDisk });
    await service.readSnapshot();
    await settle();
    advance(29_000);
    expect((await service.readSnapshot()).disk).toEqual(readyDisk);
    expect(scanDisk).toHaveBeenCalledTimes(1);
    advance(1_000);
    await service.readSnapshot();
    await settle();
    advance(1_000);
    expect((await service.readSnapshot()).disk).toMatchObject({ bytes: null, status: 'unavailable' });
  });

  it('resets identities after metric failure and does not treat a reused PID as a sampled process', async () => {
    const getAppMetrics = vi.fn().mockReturnValueOnce([metric(1)]).mockReturnValueOnce([metric(1, { creationTime: 101 })]).mockImplementationOnce(() => { throw new Error('not ready'); }).mockReturnValue([metric(1, { creationTime: 101 })]);
    const { service, advance } = serviceFixture({ getAppMetrics });
    await service.readSnapshot();
    advance(1_000);
    expect((await service.readSnapshot()).cpuPercent).toBeNull();
    advance(1_000);
    expect(await service.readSnapshot()).toMatchObject({ processes: [], cpuPercent: null, memoryBytes: null });
    advance(1_000);
    expect((await service.readSnapshot()).cpuPercent).toBeNull();
  });

  it('survives unavailable GPU discovery and rate-limits retries on later samples', async () => {
    const getGPUInfo = vi.fn().mockRejectedValueOnce(new Error('GPU unavailable')).mockResolvedValue({ gpuDevice: [{ deviceString: 'Recovered GPU' }] });
    const { service, advance } = serviceFixture({ getGPUInfo, getGPUFeatureStatus: () => { throw new Error('not ready'); } });
    await service.readSnapshot();
    await settle();
    advance(1_000);
    expect((await service.readSnapshot()).gpu).toMatchObject({ status: 'unavailable', device: null, utilizationPercent: null });
    expect(getGPUInfo).toHaveBeenCalledTimes(1);
    advance(29_000);
    await service.readSnapshot();
    await settle();
    advance(1_000);
    expect((await service.readSnapshot()).gpu.device).toBe('Recovered GPU');
    expect(getGPUInfo).toHaveBeenCalledTimes(2);
  });

  it('aborts pending disk work on disposal', async () => {
    let signal: AbortSignal | undefined;
    const scanDisk = vi.fn((_roots: readonly string[], currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<ProfilerSnapshot['disk']>(resolve => currentSignal.addEventListener('abort', () => resolve({ bytes: null, files: 0, sampledAt: 0, status: 'unavailable' }), { once: true }));
    });
    const { service } = serviceFixture({ scanDisk });
    await service.readSnapshot();
    await settle();
    service.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(service.readSnapshot()).rejects.toThrow('disposed');
  });
});
