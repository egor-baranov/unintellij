import { computeComparison } from './engine';
import type { DiffRequest, DiffResponse } from './model';

// No cancellation messages: the engine computes synchronously in this worker.
// The client invalidates obsolete responses and terminates on a hard watchdog.
self.onmessage = (event: MessageEvent<DiffRequest>) => {
  let response: DiffResponse;
  try {
    response = { type: 'result', comparison: computeComparison(event.data) };
  } catch (error) {
    response = { type: 'error', requestId: event.data.requestId, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
