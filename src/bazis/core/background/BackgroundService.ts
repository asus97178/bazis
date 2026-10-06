import type { HostedService } from "../di";
import { backgroundOptionsOf } from "./decorator";
import { delay } from "./delay";
import { redactSensitive } from "../../library/redaction";

/** Restart-on-crash policy for a long-running {@link BackgroundService}. */
export interface BackgroundRestartPolicy {
  /** Restarts after a crash (not counting the first run). Default: 0 (off). */
  readonly maxRestarts?: number;
  /** Initial backoff before a restart; doubles each time. Default: 500ms. */
  readonly backoffMs?: number;
  /** Backoff cap. Default: 30000ms. */
  readonly maxBackoffMs?: number;
  /** Synchronous diagnostic notification. Errors (including returned rejections) never stop restarts. */
  readonly onError?: (error: unknown, restarts: number) => void;
}

export interface BackgroundServiceOptions {
  /** Startup phase (see {@link HostedService.phase}). Default: 0. */
  readonly phase?: number;
  /** Grace period to await `execute` after abort on stop. Default: 5000ms. */
  readonly stopTimeoutMs?: number;
  /** Restart-on-crash policy. Default: no restart (crash is logged). */
  readonly restart?: BackgroundRestartPolicy;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/**
 * Base class for long-running background work, integrated with the kernel
 * lifecycle as a {@link HostedService}.
 *
 * `start()` is **non-blocking**: it launches {@link execute} in the background
 * (so it never stalls phased startup) and hands it an {@link AbortSignal}.
 * `stop()` aborts that signal and awaits completion within `stopTimeoutMs`.
 * Cooperate by checking `signal.aborted` and awaiting {@link delay}`(ms, signal)`.
 *
 * ```ts
 * class Heartbeat extends BackgroundService {
 *   constructor(private readonly api: HttpClient) { super({ stopTimeoutMs: 2000 }); }
 *   protected async execute(signal: AbortSignal) {
 *     while (!signal.aborted) {
 *       await this.api.post("/heartbeat");
 *       await delay(15_000, signal);
 *     }
 *   }
 * }
 * ```
 */
export abstract class BackgroundService implements HostedService {
  public readonly phase: number;
  private readonly stopTimeoutMs: number;
  private readonly restart: BackgroundRestartPolicy;
  private controller?: AbortController;
  private runPromise?: Promise<void>;

  public constructor(options?: BackgroundServiceOptions) {
    // Explicit `super(...)` options win over `@Background({...})` metadata.
    const resolved = { ...backgroundOptionsOf(this.constructor), ...options };
    this.phase = resolved.phase ?? 0;
    this.stopTimeoutMs = resolved.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.restart = resolved.restart ?? {};
  }

  /** The background workload. Must observe `signal` for cooperative shutdown. */
  protected abstract execute(signal: AbortSignal): void | Promise<void>;

  public start(): void {
    if (this.controller) {
      return;
    }
    this.controller = new AbortController();
    this.runPromise = this.runSupervised(this.controller.signal)
      .catch((error: unknown) => logBackgroundError(this.constructor.name, error));
  }

  public async stop(): Promise<void> {
    if (!this.controller) {
      return;
    }
    this.controller.abort();
    const pending = this.runPromise;
    this.controller = undefined;
    this.runPromise = undefined;
    if (pending) {
      await waitWithTimeout(pending, this.stopTimeoutMs, this.constructor.name);
    }
  }

  /** Runs {@link execute}, restarting on crash per the policy. Never throws. */
  private async runSupervised(signal: AbortSignal): Promise<void> {
    const maxRestarts = Math.max(0, this.restart.maxRestarts ?? 0);
    const baseBackoff = this.restart.backoffMs ?? 500;
    const maxBackoff = this.restart.maxBackoffMs ?? 30_000;
    let restarts = 0;

    for (;;) {
      try {
        await this.execute(signal);
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.reportError(error, restarts);
        if (restarts >= maxRestarts) {
          return;
        }
        restarts += 1;
        await delay(Math.min(baseBackoff * 2 ** (restarts - 1), maxBackoff), signal);
        if (signal.aborted) {
          return;
        }
      }
    }
  }

  private reportError(error: unknown, restarts: number): void {
    if (this.restart.onError) {
      observeDiagnostic(() => this.restart.onError!(error, restarts), this.constructor.name);
    } else {
      logBackgroundError(this.constructor.name, error);
    }
  }
}

export interface PeriodicBackgroundServiceOptions extends BackgroundServiceOptions {
  /** Pause between ticks. */
  readonly intervalMs: number;
  /** Run a tick immediately on start (otherwise wait one interval). Default: true. */
  readonly runImmediately?: boolean;
}

/**
 * Base class for "do X every N ms" tasks. Override {@link tick}; the loop runs
 * it on an interval until shutdown, **without overlap** (each tick is awaited
 * before the next pause). A failing tick is reported via {@link onTickError}
 * and the loop continues (one bad run does not kill the schedule).
 */
export abstract class PeriodicBackgroundService extends BackgroundService {
  private readonly intervalMs: number;
  private readonly runImmediately: boolean;

  public constructor(options?: PeriodicBackgroundServiceOptions) {
    super(options);
    const resolved = { ...backgroundOptionsOf(this.constructor), ...options };
    if (
      typeof resolved.intervalMs !== "number"
      || !Number.isFinite(resolved.intervalMs)
      || resolved.intervalMs <= 0
    ) {
      throw new Error(
        `${this.constructor.name}: intervalMs must be a finite positive number — set it via @Background({ intervalMs }) or super({ intervalMs }).`,
      );
    }
    this.intervalMs = resolved.intervalMs;
    this.runImmediately = resolved.runImmediately ?? true;
  }

  /** A single scheduled run. */
  protected abstract tick(signal: AbortSignal): void | Promise<void>;

  /** Hook for tick failures; default logs. The loop continues regardless. */
  protected onTickError(error: unknown): void {
    logBackgroundError(this.constructor.name, error);
  }

  protected override async execute(signal: AbortSignal): Promise<void> {
    if (!this.runImmediately) {
      await delay(this.intervalMs, signal);
    }
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        observeDiagnostic(() => this.onTickError(error), this.constructor.name);
      }
      if (signal.aborted) {
        return;
      }
      await delay(this.intervalMs, signal);
    }
  }
}

/** Diagnostics are best-effort; even an accidentally async observer cannot own the loop. */
function observeDiagnostic(callback: () => unknown, name: string): void {
  try {
    void Promise.resolve(callback()).catch((error: unknown) => logBackgroundError(name, error));
  } catch (error) {
    logBackgroundError(name, error);
  }
}

function logBackgroundError(name: string, error: unknown): void {
  try { console.error(`[background:${name}]`, redactSensitive(error)); }
  catch { /* A broken diagnostic sink must not terminate the workload supervisor. */ }
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number, name: string): Promise<void> {
  const guarded = promise.catch(() => undefined);
  if (timeoutMs <= 0) {
    await guarded;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[background:${name}] did not stop within ${timeoutMs}ms; continuing shutdown`);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
