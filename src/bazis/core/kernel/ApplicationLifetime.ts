import { awaitAbortable } from "./internal/awaitAbortable";

type LifetimeCallback = () => void | Promise<void>;

/**
 * Injectable application lifetime (.NET IHostApplicationLifetime):
 * subscriptions to lifecycle moments plus programmatic shutdown from any
 * service via `stop(exitCode)`.
 */
export class ApplicationLifetime {
  private readonly startedCallbacks: LifetimeCallback[] = [];
  private readonly stoppingCallbacks: LifetimeCallback[] = [];
  private readonly stoppedCallbacks: LifetimeCallback[] = [];
  private readonly stopRequestListeners: ((exitCode: number) => void)[] = [];
  private startedFlag = false;
  private stoppingFlag = false;
  private stoppedFlag = false;

  public get isStarted(): boolean {
    return this.startedFlag;
  }

  public get isStopping(): boolean {
    return this.stoppingFlag;
  }

  /**
   * Runs `callback` once the application has started. A subscription made
   * after that moment (for example in a service first created by a request)
   * runs right away, like .NET's ApplicationStarted; a failure of such a late
   * callback is an unhandled error (logged, graceful stop with exit code 1).
   */
  public onStarted(callback: LifetimeCallback): void {
    if (this.startedFlag) {
      runLate(callback);
      return;
    }
    this.startedCallbacks.push(callback);
  }

  /** Runs `callback` when graceful shutdown begins; right away if it already has. */
  public onStopping(callback: LifetimeCallback): void {
    if (this.stoppingFlag) {
      runLate(callback);
      return;
    }
    this.stoppingCallbacks.push(callback);
  }

  /** Runs `callback` after the application has stopped; right away if it already has. */
  public onStopped(callback: LifetimeCallback): void {
    if (this.stoppedFlag) {
      runLate(callback);
      return;
    }
    this.stoppedCallbacks.push(callback);
  }

  /** Requests graceful shutdown of the application. */
  public stop(exitCode = 0): void {
    for (let index = 0; index < this.stopRequestListeners.length; index += 1) {
      (this.stopRequestListeners[index] as (exitCode: number) => void)(exitCode);
    }
  }

  /** @internal Kernel subscribes to programmatic stop requests. */
  public onStopRequested(listener: (exitCode: number) => void): void {
    this.stopRequestListeners.push(listener);
  }

  /** @internal */
  public async notifyStarted(signal?: AbortSignal): Promise<void> {
    this.startedFlag = true;
    await runCallbacks(this.startedCallbacks, signal);
  }

  /** @internal */
  public async notifyStopping(): Promise<void> {
    this.stoppingFlag = true;
    await runCallbacks(this.stoppingCallbacks);
  }

  /** @internal */
  public async notifyStopped(): Promise<void> {
    this.stoppedFlag = true;
    await runCallbacks(this.stoppedCallbacks);
  }
}

// A late subscription runs on its own: a rejection surfaces as an unhandled
// error instead of disappearing silently.
function runLate(callback: LifetimeCallback): void {
  void Promise.resolve().then(callback);
}

// A failing subscriber must not break the rest of the lifecycle chain:
// run everything, then report all failures at once.
async function runCallbacks(callbacks: readonly LifetimeCallback[], signal?: AbortSignal): Promise<void> {
  const errors: unknown[] = [];
  for (let index = 0; index < callbacks.length; index += 1) {
    signal?.throwIfAborted();
    try {
      await awaitAbortable(Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return (callbacks[index] as LifetimeCallback)();
      }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(error);
    }
  }
  signal?.throwIfAborted();
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Lifetime callbacks failed.");
  }
}
