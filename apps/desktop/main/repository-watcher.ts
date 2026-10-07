import { watch, type FSWatcher } from 'node:fs';

export interface RepositoryWatchPath {
  path: string;
  /** Directory identity, so an atomic replacement reattaches the watch. */
  identity: string;
  kind: 'working' | 'git';
}
export interface RepositoryWatchState {
  /** Full snapshot digest, useful for diagnostics and consumers with a fixed scope. */
  signature: string;
  paths: RepositoryWatchPath[];
  /** Repository-wide facts, independent of which files the user has opened. */
  baseSignature?: string;
  /** Newly observed paths establish a baseline; only changes to known paths notify. */
  fingerprints?: Record<string, string>;
}
export type DirectoryWatch = (directory: string, options: { persistent: boolean }, listener: (event: string, filename: string | null) => void) => FSWatcher;

/** Persistent, bounded directory watches with a nonoverlapping polling fallback.
 * A signature probe does not replace Git comparison capabilities. Only a real
 * state change sends a renderer notification, including when fs.watch is absent.
 */
export class RepositoryWatcher {
  private readonly watches = new Map<string, { identity: string; handle: FSWatcher }>();
  private signature?: string;
  private fingerprints?: Record<string, string>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly poll: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private pending = false;
  private disposed = false;
  private firstEvent = 0;

  constructor(
    private readonly readState: () => Promise<RepositoryWatchState>,
    private readonly onChange: () => void,
    private readonly options: { debounceMs?: number; pollMs?: number; watch?: DirectoryWatch } = {},
  ) {
    this.poll = setInterval(() => { void this.check(); }, options.pollMs ?? 3000);
    this.poll.unref();
  }

  /** Coalesces probes, retaining one trailing request if a change arrives mid-read. */
  check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) { this.pending = true; return this.running; }
    const work = async () => {
      try {
        const state = await this.readState();
        if (this.disposed) return;
        this.reconcile(state.paths);
        this.accept(state.baseSignature ?? state.signature, state.fingerprints);
      } catch (error) {
        if (!this.disposed) this.accept(`error:${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.running = work().finally(() => {
      this.running = undefined;
      // A continuous writer cannot keep callers waiting for an endless drain.
      if (this.pending && !this.disposed) { this.pending = false; this.schedule(); }
    });
    return this.running;
  }

  private accept(signature: string, fingerprints?: Record<string, string>) {
    const changed = this.signature !== undefined && (this.signature !== signature
      || Boolean(fingerprints && this.fingerprints && Object.entries(fingerprints).some(([key, value]) =>
        Object.hasOwn(this.fingerprints!, key) && this.fingerprints![key] !== value)));
    this.signature = signature;
    this.fingerprints = fingerprints;
    if (changed) this.onChange();
  }

  private schedule() {
    if (this.disposed) return;
    this.firstEvent ||= Date.now();
    if (this.timer) clearTimeout(this.timer);
    // Continuous writes must not postpone updates forever.
    const delay = Math.min(this.options.debounceMs ?? 180, Math.max(0, 800 - (Date.now() - this.firstEvent)));
    this.timer = setTimeout(() => { this.timer = undefined; this.firstEvent = 0; void this.check(); }, delay);
    this.timer.unref();
  }

  private reconcile(paths: RepositoryWatchPath[]) {
    const wanted = new Map(paths.slice(0, 512).map(item => [item.path, item]));
    for (const [directory, current] of this.watches) {
      if (wanted.get(directory)?.identity === current.identity) continue;
      current.handle.close();
      this.watches.delete(directory);
    }
    for (const [directory, target] of wanted) {
      if (this.watches.has(directory)) continue;
      try {
        const handle = (this.options.watch ?? watch)(directory, { persistent: false }, (_event, filename) => {
          const name = filename?.toString();
          // These paths cannot affect the comparison; in particular our own
          // read-only Git probes must never trigger an index.lock refresh loop.
          if (target.kind === 'git' && name && (name.endsWith('.lock') || ['objects', 'logs'].includes(name.split(/[\\/]/)[0]))) return;
          this.schedule();
        });
        handle.on('error', () => {
          handle.close();
          if (this.watches.get(directory)?.handle === handle) this.watches.delete(directory);
          this.schedule();
        });
        this.watches.set(directory, { identity: target.identity, handle });
      } catch { /* Polling retries unavailable/replaced directories automatically. */ }
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.poll);
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.watches.values()) entry.handle.close();
    this.watches.clear();
  }
}
