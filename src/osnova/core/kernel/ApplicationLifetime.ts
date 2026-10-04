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

  public get isStarted(): boolean {
    return this.startedFlag;
  }

  public get isStopping(): boolean {
    return this.stoppingFlag;
  }

  public onStarted(callback: LifetimeCallback): void {
    this.startedCallbacks.push(callback);
  }

  public onStopping(callback: LifetimeCallback): void {
    this.stoppingCallbacks.push(callback);
  }

  public onStopped(callback: LifetimeCallback): void {
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
    await runCallbacks(this.stoppedCallbacks);
  }
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
