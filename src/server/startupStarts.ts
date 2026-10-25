/**
 * Startup work that must not run before the HTTP listener is bound. Providers (including CLI providers) call back
 * through `/api/internal/provider-tools`, so a provider run started during startup reconciliation would race the
 * listener. Work is keyed by the stable run it belongs to, kept in insertion order, and released exactly once.
 */
export class DeferredStartupStarts {
  private readonly pending = new Map<string, () => void>();
  private flushed = false;

  /** Whether the one flush has happened. Later work runs immediately instead of being queued. */
  get isFlushed(): boolean {
    return this.flushed;
  }

  /**
   * Queues a callback under its stable run key. A repeated key is ignored: the same run is never started twice by
   * startup. Once flushed, the callback runs immediately.
   */
  defer(key: string, start: () => void): void {
    if (this.flushed) {
      start();
      return;
    }
    if (this.pending.has(key)) return;
    this.pending.set(key, start);
  }

  /**
   * Runs every queued callback once, in insertion order. Every callback is attempted even when one throws; the first
   * error is rethrown after all attempts. A second flush is a no-op.
   */
  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const queued = [...this.pending.values()];
    this.pending.clear();
    let firstError: unknown;
    let failed = false;
    for (const start of queued) {
      try {
        start();
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    }
    if (failed) throw firstError;
  }
}
