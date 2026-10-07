import type { HostedService, HostedServiceDiagnostics } from "../di";
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

  /** The application logger, passed by the kernel; console until then. */
  private diagnostics?: HostedServiceDiagnostics;

  public constructor(options?: BackgroundServiceOptions) {
    // Explicit `super(...)` options win over `@Background({...})` metadata.
    const resolved = { ...backgroundOptionsOf(this.constructor), ...options };
    this.phase = resolved.phase ?? 0;
    this.stopTimeoutMs = resolved.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.restart = resolved.restart ?? {};
  }

  /** The background workload. Must observe `signal` for cooperative shutdown. */
  protected abstract execute(signal: AbortSignal): void | Promise<void>;

  public useDiagnostics(diagnostics: HostedServiceDiagnostics): void {
    this.diagnostics = diagnostics;
  }

  /** Reports a failure of this service: the application logger, or the console without one. */
  protected reportFailure(message: string, error: unknown, fields: Readonly<Record<string, unknown>> = {}): void {
    report(this.diagnostics, "error", this.constructor.name, message, { ...fields, error: redactSensitive(error) });
  }

  public start(): void {
    if (this.controller) {
      return;
    }
    this.controller = new AbortController();
    this.runPromise = this.runSupervised(this.controller.signal)
      .catch((error: unknown) => this.reportFailure("supervisor failed", error));
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
      await waitWithTimeout(pending, this.stopTimeoutMs, () => report(this.diagnostics, "warn", this.constructor.name,
        `did not stop within ${this.stopTimeoutMs}ms: shutdown continues, but its unfinished work keeps the process alive until it ends`,
        { stopTimeoutMs: this.stopTimeoutMs }));
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
          // Without this line the service would just go quiet.
          report(this.diagnostics, "error", this.constructor.name, maxRestarts === 0
            ? "stopped after a crash and will not run again (no restart policy)"
            : `stopped after ${maxRestarts} restart${maxRestarts === 1 ? "" : "s"} and will not run again`, { restarts });
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
      observeDiagnostic(() => this.restart.onError!(error, restarts), (failure) => this.reportFailure("onError callback failed", failure));
    } else {
      this.reportFailure("crashed", error, { restarts });
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
    this.reportFailure("tick failed", error);
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
        observeDiagnostic(() => this.onTickError(error), (failure) => this.reportFailure("onTickError failed", failure));
      }
      if (signal.aborted) {
        return;
      }
      await delay(this.intervalMs, signal);
    }
  }
}

/** Diagnostics are best-effort; even an accidentally async observer cannot own the loop. */
function observeDiagnostic(callback: () => unknown, onFailure: (error: unknown) => void): void {
  try {
    void Promise.resolve(callback()).catch(onFailure);
  } catch (error) {
    onFailure(error);
  }
}

/** One line per event: "background Crasher crashed" with the service name in the fields. */
function report(
  diagnostics: HostedServiceDiagnostics | undefined,
  level: "error" | "warn",
  name: string,
  message: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    if (diagnostics) {
      diagnostics[level](`background ${name} ${message}`, { service: name, ...fields });
      return;
    }
    const { error, ...rest } = fields;
    const details = error === undefined ? (Object.keys(rest).length ? [rest] : []) : [error];
    (level === "error" ? console.error : console.warn)(`[background:${name}] ${message}`, ...details);
  } catch { /* A broken diagnostic sink must not terminate the workload supervisor. */ }
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number, onTimeout: () => void): Promise<void> {
  const guarded = promise.catch(() => undefined);
  if (timeoutMs <= 0) {
    await guarded;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
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
