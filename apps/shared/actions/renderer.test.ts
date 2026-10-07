import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../desktop/src/bridge';
import { ApplicationActionRegistry } from './registry';
import { installApplicationMenu } from './renderer';

describe('application menu publishing failures', () => {
  let modal = false;
  let changed: () => void;
  let dispose: (() => void) | undefined;
  const disconnected = vi.fn();

  beforeEach(() => {
    modal = false;
    disconnected.mockClear();
    vi.stubGlobal('document', { body: {}, querySelector: () => modal ? {} : null });
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: () => void) { changed = callback; }
      observe() {}
      disconnect() { disconnected(); }
    });
    // Drive real publisher scheduling with the same availability transition a
    // focused editor/modal causes, without needing a mounted React application.
    vi.spyOn(ApplicationActionRegistry.prototype, 'state').mockImplementation(() => ({ 'file.save': { enabled: !modal } }));
  });
  afterEach(() => {
    dispose?.(); dispose = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('reports one actionable restart notice and stops publishing to an absent handler', async () => {
    const update = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'application:menu-state': Error: No handler registered for 'application:menu-state'"));
    const error = vi.fn(), unsubscribe = vi.fn();
    dispose = installApplicationMenu({ updateApplicationMenuState: update, subscribeToApplicationActions: () => unsubscribe } as unknown as DesktopBridge, error);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith('unintellij was updated. Restart the application to load the new desktop features.');
    modal = true; changed();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(update).toHaveBeenCalledOnce();
    dispose(); dispose = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it.each(['Untrusted IPC sender', "No handler registered for 'another:operation'"])(
    'keeps ordinary failures visible and does not disable future updates: %s', async message => {
      const update = vi.fn().mockRejectedValue(new Error(message)), error = vi.fn();
      dispose = installApplicationMenu({ updateApplicationMenuState: update, subscribeToApplicationActions: () => () => {} } as unknown as DesktopBridge, error);
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(error).toHaveBeenLastCalledWith(`Error: ${message}`);
      modal = true; changed();
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      expect(error).toHaveBeenCalledTimes(2);
    });

  it('does not surface a late failure after the menu subscription is disposed', async () => {
    let reject!: (error: Error) => void;
    const update = vi.fn(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise; })), error = vi.fn();
    dispose = installApplicationMenu({ updateApplicationMenuState: update, subscribeToApplicationActions: () => () => {} } as unknown as DesktopBridge, error);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    dispose(); dispose = undefined;
    reject(new Error("No handler registered for 'application:menu-state'"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(error).not.toHaveBeenCalled();
  });
});
