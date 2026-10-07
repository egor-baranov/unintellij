import { useLayoutEffect, useRef } from 'react';
import type { DesktopBridge } from '../../desktop/src/bridge';
import { isApplicationActionId } from './contracts';
import { ApplicationActionRegistry, type ApplicationActions } from './registry';
export type { ApplicationActions } from './registry';

let notify: (() => void) | undefined;
const registry = new ApplicationActionRegistry(() => notify?.());
export function useApplicationActions(actions: ApplicationActions): void {
  const current = useRef(actions); current.current = actions;
  // Reconcile after every commit so availability follows the real active tab,
  // while closures always call the current render rather than a stale snapshot.
  useLayoutEffect(() => registry.register(Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, {
    ...action, run: () => current.current[id as keyof ApplicationActions]?.run(),
  }]))));
}

const modalOpen = () => !!document.querySelector('dialog[open], [aria-modal="true"]');
export function installApplicationMenu(bridge: DesktopBridge, onError: (message: string) => void): () => void {
  let disposed = false, scheduled = false, previous = '', unavailable = false;
  const publish = () => {
    if (scheduled || disposed || unavailable) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed || unavailable) return;
      registry.setBlocked(modalOpen());
      const state = registry.state(), serialized = JSON.stringify(state);
      if (serialized === previous) return;
      previous = serialized;
      void bridge.updateApplicationMenuState(state).catch(cause => {
        if (disposed || unavailable) return;
        const message = String(cause);
        // A rebuilt preload can outlive an old development main process. Only
        // this absent handler requires a restart; ordinary IPC errors stay visible.
        if (/No handler registered for ['"]application:menu-state['"]/.test(message)) {
          unavailable = true;
          onError('unintellij was updated. Restart the application to load the new desktop features.');
        } else onError(message);
      });
    });
  };
  notify = publish;
  const unsubscribe = bridge.subscribeToApplicationActions(id => {
    if (disposed || !isApplicationActionId(id)) return;
    registry.setBlocked(modalOpen());
    void registry.execute(id).catch(cause => { if (!disposed) onError(cause instanceof Error ? cause.message : String(cause)); });
  });
  const observer = new MutationObserver(() => registry.setBlocked(modalOpen()));
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
  publish();
  return () => { disposed = true; if (notify === publish) notify = undefined; unsubscribe(); observer.disconnect(); };
}
