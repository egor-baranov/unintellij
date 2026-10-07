import type { Comparison, DiffRequest, DiffResponse } from './model';
import { defaultDiffResultCache } from './result-cache';

/** This subset is also convenient for consumer-supplied worker factories. */
export interface DiffWorker {
  onmessage: ((event: MessageEvent<DiffResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: DiffRequest): void;
  terminate(): void;
}
export interface DiffWorkerClientOptions {
  workerFactory?: () => DiffWorker;
  onResult(comparison: Comparison): void;
  onError(message: string): void;
  onTimeout?(request: DiffRequest): void;
  /** Includes worker startup. Tests may shorten this; default is >= 2 seconds. */
  watchdogMs?: number;
}

export class DiffWorkerClient {
  private worker: DiffWorker | undefined;
  private active: DiffRequest | undefined;
  private pending: DiffRequest | undefined;
  private latest: DiffRequest | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly options: DiffWorkerClientOptions) {}

  /** One active request and at most one pending request, replaced by newer work. */
  compute(request: DiffRequest): void {
    if (this.disposed) return;
    this.latest = request;
    this.pending = request;
    this.drain();
  }

  /** Invalidate in-flight data immediately when models or selections change. */
  invalidate(): void {
    this.latest = undefined;
    this.pending = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.stopWorker();
  }

  private stopWorker(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = undefined;
    this.active = undefined;
  }

  private isLatest(request: Pick<DiffRequest, 'requestId' | 'originalVersion' | 'modifiedVersion'>): boolean {
    return this.latest?.requestId === request.requestId && this.latest.originalVersion === request.originalVersion && this.latest.modifiedVersion === request.modifiedVersion;
  }

  private drain(): void {
    if (this.disposed || this.active || !this.pending) return;
    const request = this.pending;
    this.pending = undefined;
    // A host-supplied worker can implement different diff semantics. Only the
    // bundled worker participates in the shared exact-input result cache.
    const cached = !this.options.workerFactory ? defaultDiffResultCache.get(request) : undefined;
    if (cached) {
      queueMicrotask(() => {
        if (!this.disposed && this.latest === request) this.options.onResult(cached);
      });
      return;
    }
    try {
      if (!this.worker) {
        const worker: DiffWorker = this.options.workerFactory?.() ?? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'smart-diff' });
        this.worker = worker;
        worker.onmessage = event => {
          if (worker !== this.worker || !this.active || this.disposed) return;
          const response = event.data;
          const responseId = response.type === 'result' ? response.comparison.requestId : response.requestId;
          // A mismatched response cannot complete a different active request.
          if (responseId !== this.active.requestId) return;
          const completed = this.active;
          this.active = undefined;
          clearTimeout(this.timer);
          this.timer = undefined;
          if (this.isLatest(completed)) {
            if (response.type === 'result' && this.isLatest(response.comparison)) {
              if (!this.options.workerFactory) defaultDiffResultCache.put(completed, response.comparison);
              this.options.onResult(response.comparison);
            }
            else if (response.type === 'error') this.options.onError(response.error);
          }
          this.drain();
        };
        worker.onerror = event => {
          if (worker !== this.worker || this.disposed) return;
          const failed = this.active;
          this.stopWorker();
          if (failed && this.isLatest(failed)) this.options.onError(event.message || 'Diff worker failed to load. Check the worker URL and Content Security Policy.');
          this.drain();
        };
      }
      this.active = request;
      const watchdogMs = this.options.watchdogMs ?? Math.max(2_000, request.maxComputationTimeMs > 0 ? request.maxComputationTimeMs * 2 + 500 : 10_000);
      this.timer = setTimeout(() => {
        this.stopWorker();
        if (this.isLatest(request)) {
          if (this.options.onTimeout) this.options.onTimeout(request);
          else this.options.onError('Diff computation timed out; increase maxComputationTimeMs and retry.');
        }
        this.drain();
      }, watchdogMs);
      this.worker.postMessage(request);
    } catch (error) {
      this.stopWorker();
      if (this.isLatest(request)) this.options.onError(error instanceof Error ? error.message : String(error));
      this.drain();
    }
  }
}
