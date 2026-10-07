/** One in-flight refresh plus one trailing request, scoped to a repository session. */
export class RepositoryRefresh<T> {
  private session?: { id: string; running: boolean; pending: boolean };

  constructor(private readonly callbacks: {
    load: (id: string) => Promise<T>;
    accept: (value: T) => void;
    error: (error: unknown) => void;
    busy: (value: boolean) => void;
  }) {}

  setRepository(id?: string): void {
    if (this.session?.id === id) return;
    this.session = id ? { id, running: false, pending: false } : undefined;
  }

  request(id = this.session?.id): void {
    const session = this.session;
    if (!session || session.id !== id) return;
    session.pending = true;
    if (!session.running) void this.drain(session);
  }

  private async drain(session: NonNullable<RepositoryRefresh<T>['session']>): Promise<void> {
    session.running = true;
    this.callbacks.busy(true);
    try {
      while (this.session === session && session.pending) {
        session.pending = false;
        try {
          const value = await this.callbacks.load(session.id);
          if (this.session === session) this.callbacks.accept(value);
        } catch (error) {
          if (this.session === session) this.callbacks.error(error);
        }
      }
    } finally {
      session.running = false;
      if (this.session === session) this.callbacks.busy(false);
    }
  }
}

/** Bounded recovery for reads racing a write; further filesystem events still retry. */
export class StaleReadRecovery {
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  schedule(retry: () => void): boolean {
    this.cancel();
    if (this.attempts >= 5) return false;
    this.timer = setTimeout(() => { this.timer = undefined; this.attempts++; retry(); }, Math.min(150 * 2 ** this.attempts, 2000));
    return true;
  }
  cancel(): void { clearTimeout(this.timer); this.timer = undefined; }
  reset(): void { this.cancel(); this.attempts = 0; }
}
