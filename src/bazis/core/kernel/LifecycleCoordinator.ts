import { validateOptionsOnStart, type HostedService } from "../di";
import type { Token } from "../di";
import { LIFECYCLE_HOOK } from "./lifecycleHooks";
import { LOGGER } from "./logging/Logger";
import type { LifecycleHook } from "./types";
import { ShutdownTimeoutError, StartupFailuresError, type StartupFailure } from "./errors";
import { awaitAbortable } from "./internal/awaitAbortable";
import { resolveHostedServices, validateHostedServicePlan } from "../di/extensions/hosted-service";
import { awaitShutdown } from "./internal/awaitShutdown";

interface LifecycleResolver {
  resolveAll<T>(token: Token<T>): readonly T[];
  tryResolve?<T>(token: Token<T>): T | undefined;
}

/**
 * Orchestrates the boot/shutdown sequence:
 * options fail-fast -> onInit hooks -> hosted services by ascending phase ->
 * onBootstrap hooks; shutdown runs everything in reverse. A failed start rolls
 * back already-started services. The overall shutdown time budget is owned by
 * the {@link Kernel}, which bounds the whole graceful-stop sequence.
 */
export class LifecycleCoordinator {
  private readonly pending = new Set<string>();
  private readonly timings: StartupBatchTiming[] = [];
  private readonly failed: string[] = [];

  /** Hosted services whose start failed, for the failure screen. */
  public get failedServiceNames(): readonly string[] {
    return this.failed;
  }

  /** The hosted services whose `start` is running now, for the startup timeout. */
  public get startingServiceName(): string | undefined {
    return this.pending.size === 0 ? undefined : [...this.pending].join(", ");
  }

  /** The same as a list, for the waiting indicator of the startup screen. */
  public get startingServiceNames(): readonly string[] {
    return [...this.pending];
  }

  /** Wall time of every started batch, in start order. */
  public get startTimings(): readonly StartupBatchTiming[] {
    return this.timings;
  }

  private hooks: readonly LifecycleHook[] = [];
  /** Hosted services in actual start order (stop iterates in reverse). */
  private readonly started: HostedService[] = [];
  private hostedCount = 0;
  private hookWork?: Promise<void>;
  private rollbackWork?: Promise<void>;
  private rollbackError?: unknown;
  private rollbackStartedAt?: number;

  public constructor(private readonly resolver: LifecycleResolver) {}

  public get startedHostedCount(): number {
    return this.hostedCount;
  }

  public get hookCount(): number {
    return this.hooks.length;
  }

  /** @internal The host must join actual cleanup before disposing hook dependencies. */
  public waitForRollback(): Promise<void> {
    return this.rollbackWork ?? Promise.resolve();
  }

  /** @internal Completed rollback failure, distinct from a deadline ending observation. */
  public get rollbackFailure(): unknown {
    return this.rollbackError;
  }

  /** @internal Container disposal uses the remaining part of the same deadline. */
  public get rollbackElapsedMs(): number {
    return this.rollbackStartedAt === undefined ? 0 : performance.now() - this.rollbackStartedAt;
  }

  /**
   * `infrastructureOnly` starts only hosted services with a negative phase
   * (connections and the database schema) and no lifecycle hooks.
   */
  public async start(signal?: AbortSignal, rollbackTimeoutMs = 0, infrastructureOnly = false): Promise<void> {
    signal?.throwIfAborted();
    validateOptionsOnStart(this.resolver);
    const resolved = resolveHostedServices(this.resolver);
    const hosted = infrastructureOnly ? resolved.filter((service) => (service.phase ?? 0) < 0) : resolved;
    // Background failures go to the application logger, like HTTP errors.
    const logger = this.resolver.tryResolve?.(LOGGER);
    if (logger) for (const service of hosted) service.useDiagnostics?.(logger);
    const validation = validateHostedServicePlan(hosted, signal);
    if (validation) await awaitAbortable(validation, signal);
    this.hooks = infrastructureOnly ? [] : this.resolver.resolveAll(LIFECYCLE_HOOK);

    try {
      for (let index = 0; index < this.hooks.length; index += 1) {
        const hook = this.hooks[index] as LifecycleHook;
        if (hook.onInit === undefined) continue;
        // A hung onInit is named by the startup timeout, like a hosted service.
        const name = `hook ${hook.constructor?.name ?? "LifecycleHook"}.onInit`;
        this.pending.add(name);
        try {
          await this.invokeHook(() => hook.onInit?.(), signal);
        } finally {
          this.pending.delete(name);
        }
      }

      const phases = groupByPhase(hosted);
      for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
        for (const batch of batchesOf(phases[phaseIndex] as HostedService[])) {
          if (batch.length > 1) {
            await this.startBatch(batch, signal);
            continue;
          }
          // One service starts inline: a failed start reaches the rollback
          // below before a late stop of an abandoned start is scheduled.
          const service = batch[0] as HostedService;
          const name = serviceName(service);
          const startedAt = performance.now();
          this.pending.add(name);
          const starting = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return service.start(signal);
          });
          try {
            await awaitAbortable(starting, signal);
          } catch (error) {
            this.failed.push(name);
            if (signal?.aborted) {
              // A legacy service may ignore the signal and finish after startup
              // has already been cancelled. Observe it and stop it immediately
              // so the late listener/connection cannot escape rollback.
              void starting.then(() => service.stop()).catch(() => undefined);
            }
            throw error;
          } finally {
            this.pending.delete(name);
            this.timings.push(Object.freeze({ names: Object.freeze([name]), phase: service.phase ?? 0, ms: performance.now() - startedAt }));
          }
          this.started.push(service);
        }
      }
      this.hostedCount = this.started.length;

      for (let index = 0; index < this.hooks.length; index += 1) {
        await this.invokeHook(() => (this.hooks[index] as LifecycleHook).onBootstrap?.(), signal);
      }
    } catch (error) {
      try {
        this.rollbackStartedAt = performance.now();
        this.rollbackWork = this.rollbackStart(error);
        await awaitShutdown(this.rollbackWork, rollbackTimeoutMs);
      } catch (cleanupError) {
        if (cleanupError instanceof ShutdownTimeoutError) {
          cleanupError.cause = error;
          throw cleanupError;
        }
        throw new AggregateError([error, cleanupError], "Startup failed and rollback also failed.", { cause: error });
      }
      throw error;
    }
  }

  /**
   * Starts one service, or several `concurrentStart` services together. Every
   * failure of the batch is reported at once: three unreachable connections
   * are three problems on one screen, not three restarts.
   */
  private async startBatch(batch: readonly HostedService[], signal?: AbortSignal): Promise<void> {
    const names = batch.map(serviceName);
    for (const name of names) this.pending.add(name);
    const startedAt = performance.now();
    const results = await Promise.allSettled(batch.map((service) => this.startService(service, signal)));
    for (const name of names) this.pending.delete(name);
    this.timings.push(Object.freeze({ names: Object.freeze(names), phase: batch[0]?.phase ?? 0, ms: performance.now() - startedAt }));
    const failures: StartupFailure[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") this.started.push(batch[index] as HostedService);
      else {
        failures.push(Object.freeze({ name: names[index] as string, error: result.reason }));
        this.failed.push(names[index] as string);
      }
    });
    if (failures.length === 0) return;
    // A timeout or a stop request aborts every pending start with one reason.
    if (signal?.aborted || failures.length === 1) throw (failures[0] as StartupFailure).error;
    throw new StartupFailuresError(failures);
  }

  private async startService(service: HostedService, signal?: AbortSignal): Promise<void> {
    const starting = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return service.start(signal);
    });
    try {
      await awaitAbortable(starting, signal);
    } catch (error) {
      if (signal?.aborted) {
        // A legacy service may ignore the signal and finish after startup
        // has already been cancelled. Observe it and stop it immediately
        // so the late listener/connection cannot escape rollback.
        void starting.then(() => service.stop()).catch(() => undefined);
      }
      throw error;
    }
  }

  private invokeHook(callback: () => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    this.hookWork = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return callback();
    });
    return awaitAbortable(this.hookWork, signal);
  }

  /**
   * Stops hosted services (reverse start order), then runs `onShutdown` and
   * `onDestroy` hooks (reverse). Unbounded by design — the Kernel races the
   * whole shutdown sequence against the configured timeout.
   */
  public async stopServices(signal?: string): Promise<void> {
    const errors: unknown[] = [];

    for (let index = this.started.length - 1; index >= 0; index -= 1) {
      try {
        await (this.started[index] as HostedService).stop();
      } catch (error) {
        errors.push(error);
      }
    }
    this.started.length = 0;

    for (let index = this.hooks.length - 1; index >= 0; index -= 1) {
      try {
        await (this.hooks[index] as LifecycleHook).onShutdown?.(signal);
      } catch (error) {
        errors.push(error);
      }
    }
    for (let index = this.hooks.length - 1; index >= 0; index -= 1) {
      try {
        await (this.hooks[index] as LifecycleHook).onDestroy?.();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Shutdown finished with errors.");
    }
  }

  // The deadline bounds the caller, not this work. An in-flight hook may still
  // acquire resources and use hosted services: join it before tearing them down.
  private async rollbackStart(startError: unknown): Promise<void> {
    const errors: unknown[] = [];
    try { await this.hookWork; }
    catch (error) { if (error !== startError) errors.push(error); }
    for (let index = this.started.length - 1; index >= 0; index -= 1) {
      try {
        await (this.started[index] as HostedService).stop();
      } catch (error) {
        errors.push(error);
      }
    }
    this.started.length = 0;
    this.hostedCount = 0;
    for (let index = this.hooks.length - 1; index >= 0; index -= 1) {
      try {
        await (this.hooks[index] as LifecycleHook).onDestroy?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      this.rollbackError = new AggregateError(errors, "Startup rollback failed.");
      throw this.rollbackError;
    }
  }
}

export interface StartupBatchTiming {
  readonly names: readonly string[];
  readonly phase: number;
  readonly ms: number;
}

function serviceName(service: HostedService): string {
  return service.diagnosticName ?? service.constructor?.name ?? "HostedService";
}

/** Neighbouring `concurrentStart` services start together; the rest one by one, in order. */
function batchesOf(group: readonly HostedService[]): HostedService[][] {
  const batches: HostedService[][] = [];
  for (const service of group) {
    const last = batches.at(-1);
    if (service.concurrentStart === true && last !== undefined && last[0]?.concurrentStart === true) last.push(service);
    else batches.push([service]);
  }
  return batches;
}

/** Groups by ascending `phase` (default 0), keeping registration order inside a group. */
function groupByPhase(services: readonly HostedService[]): HostedService[][] {
  const byPhase = new Map<number, HostedService[]>();
  for (let index = 0; index < services.length; index += 1) {
    const service = services[index] as HostedService;
    const phase = service.phase ?? 0;
    const group = byPhase.get(phase);
    if (group) {
      group.push(service);
    } else {
      byPhase.set(phase, [service]);
    }
  }
  return [...byPhase.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
}
