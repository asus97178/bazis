export type FulfilledFn<V> = (value: V) => V | Promise<V>;
export type RejectedFn = (error: unknown) => unknown;

interface Handler<V> {
  readonly fulfilled: FulfilledFn<V>;
  readonly rejected?: RejectedFn;
}

/**
 * axios-style interceptor registry. `use` returns an id usable with `eject`.
 * Request interceptors run last-registered-first; response interceptors run
 * first-registered-first (matching axios semantics) — ordering is applied by
 * the client, this class just stores handlers stably.
 */
export class InterceptorManager<V> {
  private readonly handlers = new Map<number, Handler<V>>();
  private nextId = 0;

  public use(fulfilled: FulfilledFn<V>, rejected?: RejectedFn): number {
    const id = this.nextId;
    this.nextId += 1;
    this.handlers.set(id, rejected !== undefined ? { fulfilled, rejected } : { fulfilled });
    return id;
  }

  public eject(id: number): void {
    this.handlers.delete(id);
  }

  public clear(): void {
    this.handlers.clear();
  }

  /** Registered handlers in insertion order. */
  public toArray(): readonly Handler<V>[] {
    return [...this.handlers.values()];
  }
}

export type { Handler };
