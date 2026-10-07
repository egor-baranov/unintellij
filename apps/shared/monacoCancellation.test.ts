import { describe, expect, it, vi } from 'vitest';
import { installMonacoCancellationHandler, isMonacoCancellation } from './monacoCancellation';

const canceled = () => Object.assign(new Error('Canceled'), { name: 'Canceled' });
function rejection(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

describe('Monaco lifecycle cancellation', () => {
  it('recognizes only the exact Error signature emitted for a canceled Monaco task', () => {
    expect(isMonacoCancellation(canceled())).toBe(true);
    for (const reason of [undefined, null, 'Canceled', { name: 'Canceled', message: 'Canceled' }, new Error('Canceled'), Object.assign(new Error('Scan failed'), { name: 'Canceled' }), Object.assign(new Error('Canceled'), { name: 'AbortError' })]) {
      expect(isMonacoCancellation(reason)).toBe(false);
    }
  });

  it('suppresses expected cancellation reporting while retaining other rejection events and observers', () => {
    const target = new EventTarget();
    const dispose = installMonacoCancellationHandler(target);
    const observer = vi.fn();
    target.addEventListener('unhandledrejection', observer);
    const cancellation = rejection(canceled());
    expect(target.dispatchEvent(cancellation)).toBe(false);
    expect(cancellation.defaultPrevented).toBe(true);
    const failure = rejection(new Error('Worker failed'));
    expect(target.dispatchEvent(failure)).toBe(true);
    expect(failure.defaultPrevented).toBe(false);
    expect(observer).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('removes its listener when the host module is disposed and can install again', () => {
    const target = new EventTarget();
    const dispose = installMonacoCancellationHandler(target);
    dispose();
    expect(target.dispatchEvent(rejection(canceled()))).toBe(true);
    const replacement = installMonacoCancellationHandler(target);
    expect(target.dispatchEvent(rejection(canceled()))).toBe(false);
    replacement();
    expect(target.dispatchEvent(rejection(canceled()))).toBe(true);
  });
});
