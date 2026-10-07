import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryRefresh, StaleReadRecovery } from './refresh';

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const requests: ReturnType<typeof pending<string>>[] = [];
  const callbacks = {
    load: vi.fn(() => { const request = pending<string>(); requests.push(request); return request.promise; }),
    accept: vi.fn(), error: vi.fn(), busy: vi.fn(),
  };
  const refresh = new RepositoryRefresh(callbacks);
  refresh.setRepository('one');
  return { refresh, requests, ...callbacks };
}

describe('automatic repository refresh', () => {
  it('coalesces a burst without dropping changes that arrive during a refresh', async () => {
    const f = fixture(); f.refresh.request();
    for (let index = 0; index < 50; index++) f.refresh.request('one');
    expect(f.load).toHaveBeenCalledTimes(1);
    f.requests[0].resolve('first'); await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(2);
    f.requests[1].resolve('latest'); await Promise.resolve();
    expect(f.accept.mock.calls).toEqual([['first'], ['latest']]);
    expect(f.busy.mock.calls).toEqual([[true], [false]]);
  });
  it('ignores late results, failures and notifications belonging to a previous repository', async () => {
    const f = fixture(); f.refresh.request();
    f.refresh.setRepository('two'); f.refresh.request('one'); f.refresh.request();
    f.requests[1].resolve('two'); await Promise.resolve();
    f.requests[0].reject(new Error('late')); await Promise.resolve();
    expect(f.accept.mock.calls).toEqual([['two']]); expect(f.error).not.toHaveBeenCalled();
    expect(f.load.mock.calls).toHaveLength(2);
  });
  it('retains a queued retry after an error and invalidates work on disposal', async () => {
    const f = fixture(); f.refresh.request(); f.refresh.request();
    f.requests[0].reject('temporary error'); await Promise.resolve();
    expect(f.error).toHaveBeenCalledWith('temporary error'); expect(f.load).toHaveBeenCalledTimes(2);
    f.refresh.setRepository(); f.requests[1].resolve('discarded'); await Promise.resolve();
    expect(f.accept).not.toHaveBeenCalled();
  });
});

describe('stale read recovery', () => {
  afterEach(() => vi.useRealTimers());
  it('backs off, stops a persistent race, and resets after a successful read', () => {
    vi.useFakeTimers(); const recovery = new StaleReadRecovery(), retry = vi.fn();
    for (let index = 0; index < 5; index++) { expect(recovery.schedule(retry)).toBe(true); vi.runAllTimers(); }
    expect(recovery.schedule(retry)).toBe(false); expect(retry).toHaveBeenCalledTimes(5);
    recovery.reset(); expect(recovery.schedule(retry)).toBe(true); vi.runAllTimers();
    expect(retry).toHaveBeenCalledTimes(6);
  });
  it('cancels delayed work when a tab unmounts or a newer snapshot starts loading', () => {
    vi.useFakeTimers(); const recovery = new StaleReadRecovery(), retry = vi.fn();
    for (let index = 0; index < 10; index++) { expect(recovery.schedule(retry)).toBe(true); recovery.cancel(); }
    vi.runAllTimers(); expect(retry).not.toHaveBeenCalled();
    expect(recovery.schedule(retry)).toBe(true); vi.runAllTimers(); expect(retry).toHaveBeenCalledTimes(1);
  });
});
