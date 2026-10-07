import { lstat, opendir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { ProcessMetric } from 'electron';
import { appendProfilerSnapshot, PROFILER_SAMPLE_MS } from '../../shared/profiler/model';
import type { ProfilerProcess, ProfilerSnapshot } from '../../shared/profiler/types';

type DiskSnapshot = ProfilerSnapshot['disk'];
// Electron 41 omits memory on Linux despite declaring it required.
export type ProfilerMetric = Omit<ProcessMetric, 'memory'> & { memory?: Partial<ProcessMetric['memory']> };

export interface ProfilerServiceOptions {
  /** Fixed app userData/sessionData directories; never repository or installation paths. */
  roots: readonly string[];
  getAppMetrics(): readonly ProfilerMetric[];
  getGPUFeatureStatus(): { gpu_compositing?: string };
  getGPUInfo(): Promise<unknown>;
  now?: () => number;
  monotonicNow?: () => number;
  logicalCpuCount?: number;
  scanDisk?: (roots: readonly string[], signal: AbortSignal) => Promise<DiskSnapshot>;
  measureLoopDelay?: (signal: AbortSignal) => Promise<number | null>;
}

export interface DiskScanOptions {
  signal?: AbortSignal;
  maxEntries?: number;
  maxDurationMs?: number;
  maxDepth?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

const SAMPLE_INTERVAL_MS = PROFILER_SAMPLE_MS;
const IDLE_INTERVAL_MS = 5_000;
const DISK_INTERVAL_MS = 30_000;
const GPU_REASON = 'Electron does not expose GPU utilization or dedicated video memory. GPU process RAM is host memory; its CPU is processor activity, not GPU utilization.';
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const processIdentity = (metric: Pick<ProfilerMetric, 'pid' | 'creationTime'>) => `${metric.pid}:${metric.creationTime}`;
const cleanText = (value: unknown, length = 120): string | null => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) || null : null;
const sumKnown = (values: (number | null)[]): number | null => values.length && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;

/** A one-shot scheduling probe; it leaves no timer behind after completion or disposal. */
export function measureProfilerLoopDelay(signal?: AbortSignal, monotonicNow: () => number = () => performance.now()): Promise<number | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const started = monotonicNow();
    const finish = (delay: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(delay);
    };
    const abort = () => finish(null);
    const timer = setTimeout(() => {
      const elapsed = monotonicNow() - started;
      finish(nonnegative(elapsed) ? Math.max(0, elapsed - 20) : null);
    }, 20);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function profilerEventLoopUtilization(current: EventLoopUtilization, previous: EventLoopUtilization | undefined): number | null {
  // Electron's embedded Node loop can expose all-zero lifetime counters even
  // while Chromium's main loop is busy. That is unavailable, not measured idle.
  if (!previous || !nonnegative(current.active) || !nonnegative(current.idle) || current.active + current.idle === 0) return null;
  const active = current.active - previous.active;
  const idle = current.idle - previous.idle;
  return nonnegative(active) && nonnegative(idle) && active + idle > 0 ? active / (active + idle) : null;
}

/** CPU is core-equivalent percent: one fully busy logical core is 100%. */
export function aggregateProfilerProcesses(metrics: readonly ProfilerMetric[], previousIdentities: ReadonlySet<string>, logicalCpuCount: number): {
  processes: ProfilerProcess[]; cpuPercent: number | null; memoryBytes: number | null;
} {
  const cores = Number.isFinite(logicalCpuCount) ? Math.max(1, Math.floor(logicalCpuCount)) : 1;
  const seen = new Set<string>();
  const processes: ProfilerProcess[] = [];
  for (const metric of metrics) {
    const identity = processIdentity(metric);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const cpu = metric.cpu?.percentCPUUsage;
    const memory = metric.memory?.workingSetSize;
    processes.push({
      pid: metric.pid, createdAt: metric.creationTime, type: metric.type,
      name: cleanText(metric.name) ?? cleanText(metric.serviceName) ?? metric.type,
      // Electron divides Chromium CPU usage by processor count. Undo that for
      // the one-core=100% convention (electron_api_app.cc, v41.10.7).
      cpuPercent: previousIdentities.has(identity) && nonnegative(cpu) ? cpu * cores : null,
      memoryBytes: nonnegative(memory) ? memory * 1024 : null,
    });
  }
  return { processes, cpuPercent: sumKnown(processes.map(item => item.cpuPercent)), memoryBytes: sumKnown(processes.map(item => item.memoryBytes)) };
}

function uniqueRoots(roots: readonly string[]): string[] {
  const resolved = [...new Set(roots.map(root => path.resolve(root)))].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return resolved.filter((root, index) => !resolved.slice(0, index).some(parent => {
    const relative = path.relative(parent, root);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }));
}

/** Logical file sizes, not allocated blocks; bounded, streaming, and no symlink traversal. */
export async function scanProfilerDisk(roots: readonly string[], options: DiskScanOptions = {}): Promise<DiskSnapshot> {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 25_000));
  const maxDurationMs = Math.max(0, options.maxDurationMs ?? 2_000);
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 64));
  const started = monotonicNow();
  let entries = 0, bytes = 0, files = 0, observed = false, failures = 0;
  let stopReason: string | undefined;
  const canContinue = () => {
    if (stopReason) return false;
    if (options.signal?.aborted) stopReason = 'Scan cancelled.';
    else if (entries >= maxEntries) stopReason = `Scan limited to ${maxEntries} entries.`;
    else if (monotonicNow() - started >= maxDurationMs) stopReason = 'Scan time limit reached.';
    return !stopReason;
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (!canContinue()) return;
    if (depth > maxDepth) { failures++; return; }
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(directory, { bufferSize: 32 });
      observed = true;
      while (canContinue()) {
        const entry = await handle.read();
        if (!entry) break;
        entries++;
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directory, entry.name);
        try {
          // Recheck the entry: it may have changed since opendir read it.
          const stat = await lstat(fullPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) await walk(fullPath, depth + 1);
          else if (stat.isFile()) {
            if (!Number.isSafeInteger(bytes + stat.size)) { stopReason = 'File sizes exceeded the supported measurement range.'; break; }
            bytes += stat.size;
            files++;
          }
        } catch { failures++; }
      }
    } catch { failures++; }
    finally { if (handle) await handle.close().catch(() => { failures++; }); }
  };
  for (const root of uniqueRoots(roots)) {
    if (!canContinue()) break;
    try {
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { failures++; continue; }
      await walk(root, 0);
    } catch (error) {
      // An app cache directory that has not been created occupies zero bytes.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') observed = true;
      else failures++;
    }
  }
  const reason = [stopReason, failures ? `${failures} paths could not be fully measured (including depth limits or skipped roots).` : undefined].filter(Boolean).join(' ');
  return {
    bytes: observed ? bytes : null, files, sampledAt: now(),
    status: !observed ? 'unavailable' : reason ? 'partial' : 'ready',
    ...(reason ? { reason } : !observed ? { reason: 'No app data directories are available.' } : {}),
  };
}

/** Only the selected GPU's short device description crosses the IPC boundary. */
export function profilerGpuDevice(info: unknown): string | null {
  if (!info || typeof info !== 'object') return null;
  const devices = (info as { gpuDevice?: unknown }).gpuDevice;
  if (!Array.isArray(devices)) return null;
  const candidates = devices.filter((device): device is Record<string, unknown> => !!device && typeof device === 'object');
  const device = candidates.find(item => item.active === true) ?? candidates[0];
  if (!device) return null;
  const description = cleanText(device.deviceString);
  const vendor = cleanText(device.vendorString);
  if (description) return vendor && !description.toLowerCase().includes(vendor.toLowerCase()) ? `${vendor} ${description}`.slice(0, 160) : description;
  if (vendor) return vendor;
  const hex = (value: unknown) => nonnegative(value) && Number.isInteger(value) ? `0x${value.toString(16)}` : null;
  const vendorId = hex(device.vendorId), deviceId = hex(device.deviceId);
  return vendorId && deviceId ? `GPU ${vendorId}:${deviceId}` : null;
}

/** A single startup sampler and bounded history are shared by all windows. */
export class ProfilerService {
  private readonly roots: readonly string[];
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly logicalCpuCount: number;
  private readonly controller = new AbortController();
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private history: ProfilerSnapshot[] = [];
  private historyGeneration = 0;
  private cache: ProfilerSnapshot | undefined;
  private inFlight: Promise<ProfilerSnapshot> | undefined;
  private sampledAt = -Infinity;
  private previousIdentities = new Set<string>();
  private previousLoop: EventLoopUtilization | undefined;
  private disk: DiskSnapshot = { bytes: null, sampledAt: null, status: 'measuring', files: 0 };
  private diskStartedAt = -Infinity;
  private diskInFlight = false;
  private gpuStartedAt = -Infinity;
  private gpuInFlight = false;
  private gpuDevice: string | null = null;
  private gpuLoaded = false;

  constructor(private readonly options: ProfilerServiceOptions) {
    this.roots = uniqueRoots(options.roots);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.logicalCpuCount = options.logicalCpuCount ?? (os.cpus().length || 1);
  }

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    void this.collect();
  }

  /** Reading an open panel never starts or resets the collection interval. */
  readHistory(): ProfilerSnapshot[] {
    return structuredClone(this.history);
  }

  clearHistory(): void {
    this.historyGeneration++;
    this.history = [];
  }

  private async collect(): Promise<void> {
    try { await this.readSnapshot(); }
    catch { /* A failed sample leaves a gap; a later interval can recover. */ }
    if (this.controller.signal.aborted) return;
    // Schedule from the start of the sample, without overlapping a slow probe
    // or creating catch-up samples when the app has been suspended.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.collect();
    }, Math.max(1, SAMPLE_INTERVAL_MS - (this.monotonicNow() - this.sampledAt)));
    this.timer.unref();
  }

  readSnapshot(): Promise<ProfilerSnapshot> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('Profiler service is disposed.'));
    if (this.inFlight) return this.inFlight;
    const sampledAt = this.monotonicNow();
    if (this.cache && sampledAt - this.sampledAt < SAMPLE_INTERVAL_MS) return Promise.resolve(this.cache);
    // After suspension (or a gap between legacy reads), reset the CPU baseline.
    if (sampledAt - this.sampledAt > IDLE_INTERVAL_MS) {
      this.previousIdentities.clear();
      this.previousLoop = undefined;
    }
    this.sampledAt = sampledAt;
    const generation = this.historyGeneration;
    this.inFlight = this.sample(sampledAt).then(snapshot => {
      if (!this.controller.signal.aborted && generation === this.historyGeneration) {
        this.history = appendProfilerSnapshot(this.history, structuredClone(snapshot));
      }
      return snapshot;
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async sample(sampledAt: number): Promise<ProfilerSnapshot> {
    this.refreshDisk(sampledAt);
    this.refreshGpu(sampledAt);
    let metrics: readonly ProfilerMetric[] = [];
    try { metrics = this.options.getAppMetrics(); } catch { /* Unknown remains null. */ }
    const aggregate = aggregateProfilerProcesses(metrics, this.previousIdentities, this.logicalCpuCount);
    this.previousIdentities = new Set(metrics.map(processIdentity));
    const loop = performance.eventLoopUtilization();
    const loopDelta = profilerEventLoopUtilization(loop, this.previousLoop);
    this.previousLoop = loop.active + loop.idle > 0 ? loop : undefined;
    const heap = process.memoryUsage();
    const gpuProcesses = aggregate.processes.filter(item => item.type === 'GPU');
    let gpuStatus = 'unavailable';
    try { gpuStatus = cleanText(this.options.getGPUFeatureStatus().gpu_compositing) ?? 'unavailable'; } catch { /* GPU discovery may not be ready. */ }
    const snapshot: ProfilerSnapshot = {
      timestamp: this.now(), uptimeSeconds: process.uptime(), ...aggregate,
      heapUsedBytes: heap.heapUsed, heapTotalBytes: heap.heapTotal,
      eventLoopUtilization: loopDelta, eventLoopDelayMs: null,
      systemMemory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
      disk: { ...this.disk },
      gpu: {
        status: gpuStatus, device: this.gpuDevice,
        processMemoryBytes: sumKnown(gpuProcesses.map(item => item.memoryBytes)),
        cpuPercent: sumKnown(gpuProcesses.map(item => item.cpuPercent)),
        utilizationPercent: null, reason: GPU_REASON,
      },
    };
    try {
      const delay = await (this.options.measureLoopDelay ?? measureProfilerLoopDelay)(this.controller.signal);
      if (!this.controller.signal.aborted && nonnegative(delay)) snapshot.eventLoopDelayMs = delay;
    } catch { /* An unavailable timer probe must not discard other measurements. */ }
    if (!this.controller.signal.aborted) this.cache = snapshot;
    return snapshot;
  }

  private refreshDisk(now: number) {
    if (this.diskInFlight || now - this.diskStartedAt < DISK_INTERVAL_MS) return;
    this.diskInFlight = true;
    this.diskStartedAt = now;
    this.disk = { ...this.disk, status: 'measuring' };
    const scan = this.options.scanDisk ?? ((roots, signal) => scanProfilerDisk(roots, { signal }));
    void Promise.resolve().then(() => scan(this.roots, this.controller.signal)).then(disk => {
      if (!this.controller.signal.aborted) this.disk = disk;
    }, () => {
      if (!this.controller.signal.aborted) this.disk = { bytes: null, files: 0, sampledAt: this.now(), status: 'unavailable', reason: 'App data measurement failed.' };
    }).finally(() => { this.diskInFlight = false; });
  }

  private refreshGpu(now: number) {
    if (this.gpuLoaded || this.gpuInFlight || now - this.gpuStartedAt < DISK_INTERVAL_MS) return;
    this.gpuInFlight = true;
    this.gpuStartedAt = now;
    void Promise.resolve().then(() => this.options.getGPUInfo()).then(info => {
      if (!this.controller.signal.aborted) { this.gpuDevice = profilerGpuDevice(info); this.gpuLoaded = true; }
    }, () => { /* Retry on a later sample, respecting the discovery interval. */ }).finally(() => { this.gpuInFlight = false; });
  }

  dispose() {
    this.controller.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearHistory();
    this.cache = undefined;
  }
}
