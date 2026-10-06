import { createToken, type ServiceResolver } from "../../di";
import type { EventHandler, EventToken } from "./EventToken";
import { awaitAbortable } from "../internal/awaitAbortable";

/** A registered handler plus its dispatch order. */
export interface EventSubscription<T> {
  readonly handle: EventHandler<T>;
  /** Lower runs first; ties keep registration order. Default: 0. */
  readonly order: number;
}

/** Subscriptions are keyed enumerable services (key = event token id). */
export const EVENT_HANDLER = createToken<EventSubscription<never>>("BazisEventHandler");

/** Context handed to {@link PublishOptions.onError}. */
export interface PublishErrorContext<T> {
  readonly event: EventToken<T>;
  readonly payload: T;
}

export interface PublishOptions<T = unknown> {
  /** Cancels waiting and skips remaining handlers. Cancellation rejects even in isolate mode. */
  readonly signal?: AbortSignal;
  /**
   * When true, handler failures never reject `publish` (observe them via
   * {@link onError}). Use for fire-and-forget domain events where a faulty
   * subscriber must not break the publisher. Default: false (failures throw).
   */
  readonly isolate?: boolean;
  /** Per-handler timeout in ms; a slow handler fails with a timeout error. Default: none. */
  readonly handlerTimeoutMs?: number;
  /** Called for every handler failure (including timeouts) before aggregation. */
  readonly onError?: (error: unknown, context: PublishErrorContext<T>) => void;
}

/** Raised when a handler exceeds {@link PublishOptions.handlerTimeoutMs}. */
export class EventHandlerTimeoutError extends Error {
  public constructor(eventName: string, timeoutMs: number) {
    super(`Event "${eventName}" handler exceeded ${timeoutMs}ms.`);
    this.name = "EventHandlerTimeoutError";
  }
}

/**
 * In-process typed event bus on top of DI. Handlers come from
 * `resolveAllKeyed(EVENT_HANDLER, event.id)`, run sequentially in `order`
 * (ties keep registration order), and — by default — every handler runs even
 * when one fails, with failures aggregated and re-thrown.
 *
 * Use {@link publishScoped} to dispatch within a request/DI scope so handlers
 * (e.g. `@OnEvent` methods on scoped services) can use scoped dependencies.
 */
export class EventBus {
  public constructor(private readonly resolver: ServiceResolver) {}

  public publish<T>(event: EventToken<T>, payload: T, options?: PublishOptions<T>): Promise<void> {
    return this.dispatch(this.resolver, event, payload, options);
  }

  /** Publishes within a specific DI scope (e.g. `ctx.services` in an HTTP request). */
  public publishScoped<T>(
    scope: ServiceResolver,
    event: EventToken<T>,
    payload: T,
    options?: PublishOptions<T>,
  ): Promise<void> {
    return this.dispatch(scope, event, payload, options);
  }

  private async dispatch<T>(
    resolver: ServiceResolver,
    event: EventToken<T>,
    payload: T,
    options?: PublishOptions<T>,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const subscriptions = resolver.resolveAllKeyed(EVENT_HANDLER, event.id) as readonly EventSubscription<T>[];
    if (subscriptions.length === 0) {
      return;
    }
    // Array.prototype.sort is stable (V8/Bun): equal orders keep registration order.
    const ordered =
      subscriptions.length === 1 ? subscriptions : [...subscriptions].sort((a, b) => a.order - b.order);

    const errors: unknown[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      options?.signal?.throwIfAborted();
      try {
        await this.invoke(ordered[index]!.handle, payload, event, options?.handlerTimeoutMs, options?.signal);
      } catch (error) {
        options?.signal?.throwIfAborted();
        errors.push(error);
        try {
          options?.onError?.(error, { event, payload });
        } catch (observerError) {
          // Error observation is not an event handler: it must not prevent
          // later subscriptions from running. Report it with handler failures.
          errors.push(observerError);
        }
      }
    }
    options?.signal?.throwIfAborted();
    if (options?.isolate === true || errors.length === 0) {
      return;
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    throw new AggregateError(errors, `Event "${event.name}" handlers failed.`);
  }

  private async invoke<T>(
    handle: EventHandler<T>,
    payload: T,
    event: EventToken<T>,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const work = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return handle(payload);
    });
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await awaitAbortable(work, signal);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new EventHandlerTimeoutError(event.name, timeoutMs)), timeoutMs);
    });
    try {
      await awaitAbortable(Promise.race([work, timeout]), signal);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
