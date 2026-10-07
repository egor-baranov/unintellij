import { automaticSavingPaused, dirtyKeys, getBuffer, saveBuffer, subscribeEditing } from './store';

export const AUTO_SAVE_DELAY_MS = 1000;
interface PendingSave { text: string; version: string; timer: ReturnType<typeof setTimeout> }

/** One scheduler for shared working-file buffers, independent of mounted tabs.
 * Uses the same capability/version-checked write as manual saving. A failed or
 * conflicted buffer stays dirty and requires an explicit user resolution. */
export class AutoSaveController {
  private enabled = false;
  private disposed = false;
  private pending = new Map<string, PendingSave>();
  private unsubscribe = subscribeEditing(() => this.reconcile());

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.reconcile();
  }

  private clear(key: string): void {
    const pending = this.pending.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  private reconcile(): void {
    const eligible = new Set<string>();
    if (this.enabled && !this.disposed) for (const key of dirtyKeys()) {
      const buffer = getBuffer(key);
      if (!buffer?.dirty || buffer.saving || buffer.error || buffer.incoming || !buffer.source.editable || automaticSavingPaused(key)) continue;
      eligible.add(key);
      const { text } = buffer, { version } = buffer.source.editable;
      const pending = this.pending.get(key);
      // Saves/refreshes of other buffers must not postpone this file's deadline.
      if (pending?.text === text && pending.version === version) continue;
      this.clear(key);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        const current = getBuffer(key);
        if (!this.enabled || this.disposed || !current?.dirty || current.saving || current.error || current.incoming || automaticSavingPaused(key)) return;
        if (current.text !== text || current.source.editable?.version !== version) { this.reconcile(); return; }
        // saveBuffer emits on completion, scheduling a follow-up when typing
        // continued in flight, and blocks concurrent writes to the same file.
        void saveBuffer(key);
      }, AUTO_SAVE_DELAY_MS);
      this.pending.set(key, { text, version, timer });
    }
    for (const key of this.pending.keys()) if (!eligible.has(key)) this.clear(key);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const key of this.pending.keys()) this.clear(key);
  }
}
