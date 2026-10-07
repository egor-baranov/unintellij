import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffWorkerClient, type DiffWorker } from './client';
import { computeComparison } from './engine';
import type { DiffRequest, DiffResponse } from './model';
import { defaultDiffResultCache } from './result-cache';

class FakeWorker implements DiffWorker {
  onmessage: ((event: MessageEvent<DiffResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: DiffRequest[] = [];
  terminate = vi.fn();
  postMessage(request: DiffRequest): void { this.posted.push(request); }
  reply(request: DiffRequest): void { this.onmessage?.(new MessageEvent('message', { data: { type: 'result', comparison: computeComparison(request) } })); }
}

const request = (requestId: number): DiffRequest => ({ requestId, originalVersion: requestId, modifiedVersion: requestId, original: 'before', modified: `after ${requestId}`, ignoreTrimWhitespace: false, maxComputationTimeMs: 10 });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); defaultDiffResultCache.clear(); });

describe('reopening bundled-worker comparisons', () => {
  it('reuses completed work across disposed viewers without starting another worker', async () => {
    const workers: FakeWorker[] = [];
    const WorkerConstructor = vi.fn(function () { const worker = new FakeWorker(); workers.push(worker); return worker; });
    vi.stubGlobal('Worker', WorkerConstructor);
    const firstResult = vi.fn();
    const first = new DiffWorkerClient({ onResult: firstResult, onError: vi.fn() });
    first.compute(request(1)); workers[0].reply(request(1)); first.dispose();
    expect(firstResult).toHaveBeenCalledOnce();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const secondResult = vi.fn();
    const second = new DiffWorkerClient({ onResult: secondResult, onError: vi.fn() });
    const reopened = { ...request(1), requestId: 10, originalVersion: 20, modifiedVersion: 30 };
    second.compute(reopened);
    expect(secondResult).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(secondResult).toHaveBeenCalledOnce();
    expect(secondResult.mock.calls[0][0]).toMatchObject({ requestId: 10, originalVersion: 20, modifiedVersion: 30 });
    expect(WorkerConstructor).toHaveBeenCalledOnce();
    second.dispose();
  });

  it('rejects queued cached results after invalidation, disposal, or a newer request', async () => {
    defaultDiffResultCache.put(request(1), computeComparison(request(1)));
    for (const cancel of ['invalidate', 'dispose', 'replace'] as const) {
      const onResult = vi.fn();
      const client = new DiffWorkerClient({ onResult, onError: vi.fn() });
      client.compute(request(1));
      if (cancel === 'replace') client.compute({ ...request(1), requestId: 2 });
      else client[cancel]();
      await Promise.resolve();
      if (cancel === 'replace') {
        expect(onResult).toHaveBeenCalledOnce();
        expect(onResult.mock.calls[0][0].requestId).toBe(2);
      } else expect(onResult).not.toHaveBeenCalled();
      client.dispose();
    }
  });

  it('isolates custom worker factories from both cache reads and writes', async () => {
    defaultDiffResultCache.put(request(1), computeComparison(request(1)));
    const worker = new FakeWorker(), onResult = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => worker, onResult, onError: vi.fn() });
    client.compute(request(1));
    await Promise.resolve();
    expect(worker.posted).toEqual([request(1)]);
    expect(onResult).not.toHaveBeenCalled();
    worker.reply(request(1));
    client.compute(request(2)); worker.reply(request(2));
    expect(defaultDiffResultCache.get(request(2))).toBeUndefined();
    client.dispose();
  });
});

describe('worker lifecycle and latest-only coalescing', () => {
  it('keeps only the latest pending request and rejects superseded results', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => worker, onResult, onError: vi.fn() });
    client.compute(request(1));
    client.compute(request(2));
    client.compute(request(3));
    expect(worker.posted.map(item => item.requestId)).toEqual([1]);
    worker.reply(request(1));
    expect(onResult).not.toHaveBeenCalled();
    expect(worker.posted.map(item => item.requestId)).toEqual([1, 3]);
    worker.reply(request(3));
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].requestId).toBe(3);
    client.dispose();
  });

  it('rejects invalidated file selections and mismatched document versions', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => worker, onResult, onError: vi.fn() });
    client.compute(request(1));
    client.invalidate();
    worker.reply(request(1));
    expect(onResult).not.toHaveBeenCalled();
    client.compute(request(2));
    worker.reply({ ...request(2), originalVersion: 999 });
    expect(onResult).not.toHaveBeenCalled();
    client.dispose();
  });

  it('does not let an unrelated response finish an active request', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => worker, onResult, onError: vi.fn() });
    client.compute(request(1));
    worker.reply(request(0));
    expect(onResult).not.toHaveBeenCalled();
    worker.reply(request(1));
    expect(onResult).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('terminates a synchronous computation on watchdog and runs only the newest request', () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const onTimeout = vi.fn();
    const onResult = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, watchdogMs: 100, onTimeout, onResult, onError: vi.fn() });
    client.compute(request(1));
    client.compute(request(2));
    vi.advanceTimersByTime(100);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[0].onmessage).toBeNull();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(workers[1].posted.map(item => item.requestId)).toEqual([2]);
    workers[1].reply(request(2));
    expect(onResult).toHaveBeenCalledOnce();
    client.compute(request(3));
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledWith(request(3));
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes workers, pending work and timers without callbacks after unmount', () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const onError = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => worker, watchdogMs: 50, onResult, onError });
    client.compute(request(1));
    client.compute(request(2));
    const queuedHandler = worker.onmessage;
    client.dispose();
    client.dispose();
    client.compute(request(3));
    queuedHandler?.(new MessageEvent('message', { data: { type: 'result', comparison: computeComparison(request(1)) } }));
    vi.advanceTimersByTime(100);
    expect(worker.posted).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports worker creation failures rather than falling back to the UI thread', () => {
    const onError = vi.fn();
    const client = new DiffWorkerClient({ workerFactory: () => { throw new Error('CSP blocks worker'); }, onResult: vi.fn(), onError });
    client.compute(request(1));
    expect(onError).toHaveBeenCalledWith('CSP blocks worker');
    client.dispose();
  });
});
