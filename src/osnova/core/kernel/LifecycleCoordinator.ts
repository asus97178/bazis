import { validateOptionsOnStart, type HostedService } from "../di";
import type { Token } from "../di";
import { LIFECYCLE_HOOK } from "./lifecycleHooks";
import type { LifecycleHook } from "./types";
import { ShutdownTimeoutError } from "./errors";
import { awaitAbortable } from "./internal/awaitAbortable";
import { resolveHostedServices, validateHostedServicePlan } from "../di/extensions/hosted-service";
import { awaitShutdown } from "./internal/awaitShutdown";

interface LifecycleResolver {
  resolveAll<T>(token: Token<T>): readonly T[];
}

/**
 * Orchestrates the boot/shutdown sequence:
 * options fail-fast -> onInit hooks -> hosted services by ascending phase ->
 * onBootstrap hooks; shutdown runs everything in reverse. A failed start rolls
 * back already-started services. The overall shutdown time budget is owned by
 * the {@link Kernel}, which bounds the whole graceful-stop sequence.
 */
export class LifecycleCoordinator {
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

  public async start(signal?: AbortSignal, rollbackTimeoutMs = 0): Promise<void> {
    signal?.throwIfAborted();
    validateOptionsOnStart(this.resolver);
    const hosted = resolveHostedServices(this.resolver);
    const validation = validateHostedServicePlan(hosted, signal);
    if (validation) await awaitAbortable(validation, signal);
    this.hooks = this.resolver.resolveAll(LIFECYCLE_HOOK);

    try {
      for (let index = 0; index < this.hooks.length; index += 1) {
        await this.invokeHook(() => (this.hooks[index] as LifecycleHook).onInit?.(), signal);
      }

      const phases = groupByPhase(hosted);
      for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
        const group = phases[phaseIndex] as HostedService[];
        for (let index = 0; index < group.length; index += 1) {
          const service = group[index] as HostedService;
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
