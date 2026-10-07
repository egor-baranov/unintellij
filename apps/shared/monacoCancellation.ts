/** Matches the cancellation signature used by the pinned Monaco 0.55 runtime.
 * Ordinary errors mentioning cancellation and similarly shaped objects are
 * deliberately excluded so genuine unhandled failures remain observable. */
export function isMonacoCancellation(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled';
}

export function installMonacoCancellationHandler(target: EventTarget): () => void {
  const onRejection = (event: Event) => {
    // Monaco's word highlighter does not consume its Delayer.trigger promise.
    // Disposing an editor while its occurrence scan is pending rejects that
    // promise with Canceled. Treat this expected lifecycle cancellation like
    // Monaco's own error handler, while keeping occurrence highlighting on.
    if (isMonacoCancellation((event as PromiseRejectionEvent).reason)) event.preventDefault();
  };
  target.addEventListener('unhandledrejection', onRejection);
  return () => target.removeEventListener('unhandledrejection', onRejection);
}
