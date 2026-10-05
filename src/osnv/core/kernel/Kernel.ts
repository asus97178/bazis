import type { DiContainer } from "../di";
import { ApplicationLifetime } from "./ApplicationLifetime";
import type { Configuration } from "./config/Configuration";
import { Environment } from "./Environment";
import { EventBus } from "./events/EventBus";
import { APPLICATION_STARTED, APPLICATION_STOPPING } from "./events/kernelEvents";
import { HealthService } from "./health/HealthService";
import type { HealthReport } from "./health/HealthCheckContracts";
import { LifecycleCoordinator } from "./LifecycleCoordinator";
import { LOGGER } from "./logging/Logger";
import { ShutdownTimeoutError, StartupAbortedError, StartupTimeoutError } from "./errors";
import type { UnhandledErrorPolicy } from "./types";
import { redactSensitive } from "../../library/redaction";
import { validateTimeout } from "./internal/validateTimeout";
import { awaitShutdown } from "./internal/awaitShutdown";
import { reportDiagnosticFailure } from "./internal/reportDiagnosticFailure";

export interface KernelTimings {
  readonly configMs: number;
  readonly containerMs: number;
  readonly buildStartedAt: number;
}

export interface KernelRuntimeOptions {
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly signals: readonly NodeJS.Signals[];
  readonly unhandledErrorPolicy: UnhandledErrorPolicy;
  readonly startupReport: boolean;
}

interface StopRequest {
  readonly exitCode: number;
  readonly signal?: string;
}

type KernelState = "created" | "starting" | "started" | "stopping" | "stopped";

/**
 * Immutable application kernel: boots the lifecycle, waits for a shutdown
 * trigger (signal, lifetime.stop(), unhandled error) and shuts everything
 * down gracefully within the configured timeout.
 */
export class Kernel {
  private state: KernelState = "created";
  private readonly coordinator: LifecycleCoordinator;
  private stopRequested?: StopRequest;
  private notifyStopRequested?: (request: StopRequest) => void;
  private startupMs = 0;
  private startPromise?: Promise<void>;
  private runPromise?: Promise<number>;
  private stopPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private startupCleanupFailure?: unknown;
  private startupAbort?: AbortController;

  public constructor(
    public readonly container: DiContainer,
    public readonly environment: Environment,
    public readonly configuration: Configuration,
    public readonly lifetime: ApplicationLifetime,
    private readonly timings: KernelTimings,
    private readonly options: KernelRuntimeOptions,
  ) {
    validateTimeout("startupTimeoutMs", options.startupTimeoutMs);
    validateTimeout("shutdownTimeoutMs", options.shutdownTimeoutMs);
    this.options = Object.freeze({ ...options, signals: Object.freeze([...new Set(options.signals)]) });
    this.coordinator = new LifecycleCoordinator(container);
    lifetime.onStopRequested((exitCode) => this.requestStop({ exitCode }));
  }

  public get isStarted(): boolean {
    return this.state === "started";
  }

  public start(): Promise<void> {
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    if (this.state !== "created") {
      return Promise.resolve();
    }
    this.state = "starting";
    this.startupAbort = new AbortController();
    this.startPromise = this.startCore(this.startupAbort);
    return this.startPromise;
  }

  private async startCore(abortController: AbortController): Promise<void> {
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let coordinatorStarted = false;
    let startupDisposal: Promise<void> | undefined;
    if (this.options.startupTimeoutMs > 0) {
      startupTimer = setTimeout(
        () => abortController.abort(new StartupTimeoutError(this.options.startupTimeoutMs)),
        this.options.startupTimeoutMs,
      );
    }
    try {
      await this.coordinator.start(abortController.signal, this.options.shutdownTimeoutMs);
      coordinatorStarted = true;
      this.startupMs = performance.now() - this.timings.buildStartedAt;
      await this.lifetime.notifyStarted(abortController.signal);
      await this.container.resolve(EventBus).publish(
        APPLICATION_STARTED,
        { environment: this.environment.name, startupMs: this.startupMs },
        { signal: abortController.signal },
      );
      abortController.signal.throwIfAborted();
      if (this.options.startupReport) this.printStartupReport();
      abortController.signal.throwIfAborted();
      this.state = "started";
    } catch (error) {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (error instanceof ShutdownTimeoutError || this.coordinator.rollbackFailure !== undefined) {
        this.startupCleanupFailure = error;
      }
      try {
        if (coordinatorStarted) {
          await this.beginShutdown(this.stopRequested ?? { exitCode: 1 });
        } else {
          const disposal = startupDisposal = this.disposeAfterRollback();
          if (error instanceof ShutdownTimeoutError) {
            // Actual hook cleanup still owns its dependencies. Keep disposal
            // sequenced after it, but do not grant a second shutdown budget.
            void disposal.catch(() => reportDiagnosticFailure("startup.cleanup"));
          } else {
            await awaitShutdown(disposal, this.options.shutdownTimeoutMs, this.coordinator.rollbackElapsedMs);
          }
        }
      } catch (cleanupError) {
        if (cleanupError instanceof ShutdownTimeoutError) {
          // The facade must still force exit when cleanup left live handles.
          cleanupError.cause = error;
          this.startupCleanupFailure = cleanupError;
          void startupDisposal?.catch(() => reportDiagnosticFailure("startup.cleanup"));
          throw cleanupError;
        }
        if (this.coordinator.rollbackFailure !== undefined && cleanupError === this.coordinator.rollbackFailure) {
          // The coordinator's AggregateError already includes startup and rollback.
          this.startupCleanupFailure = error;
          throw error;
        }
        const failure = new AggregateError([error, cleanupError], "Startup failed and disposal also failed.", { cause: error });
        this.startupCleanupFailure = failure;
        throw failure;
      } finally {
        this.state = "stopped";
      }
      throw error;
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (this.startupAbort === abortController) this.startupAbort = undefined;
    }
  }

  private async disposeAfterRollback(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.coordinator.waitForRollback(); }
    catch (error) { errors.push(error); }
    try { await this.container.dispose(); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Startup cleanup failed.");
  }

  public stop(request: StopRequest = { exitCode: 0 }): Promise<void> {
    // `stop()` is also a public shutdown trigger. If `run()` is currently
    // waiting, wake it with the same request so it can remove its process
    // handlers and return the requested exit code after joining this shutdown.
    this.requestStop(request);
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    if (this.state === "starting" && this.startPromise !== undefined) {
      this.stopPromise = this.stopAfterStart(request);
      return this.stopPromise;
    }
    this.stopPromise = this.beginShutdown(request);
    return this.stopPromise;
  }

  private async stopAfterStart(request: StopRequest): Promise<void> {
    try {
      await this.startPromise!;
    } catch {
      // Failed startup already disposes the container (and, after services came
      // up, runs the shutdown sequence). Join that cleanup instead of masking
      // the original start failure with another stop attempt.
    }
    await this.beginShutdown(request);
  }

  private beginShutdown(request: StopRequest): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    if (this.state === "stopped") {
      if (this.startupCleanupFailure !== undefined) return Promise.reject(this.startupCleanupFailure);
      return Promise.resolve();
    }
    this.state = "stopping";
    this.shutdownPromise = this.stopCore(request);
    return this.shutdownPromise;
  }

  private async stopCore(request: StopRequest): Promise<void> {
    // The whole graceful-stop sequence — lifetime notifications, the STOPPING
    // event, hosted services/hooks and disposal — is bounded by one budget. A
    // single hanging callback or handler must not wedge shutdown forever.
    const work = this.runShutdownSequence(request);
    try {
      await awaitShutdown(work, this.options.shutdownTimeoutMs);
    } finally {
      this.state = "stopped";
    }
  }

  private async runShutdownSequence(request: StopRequest): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.lifetime.notifyStopping();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.container.resolve(EventBus).publish(APPLICATION_STOPPING, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        exitCode: request.exitCode,
      });
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.coordinator.stopServices(request.signal);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await this.container.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await this.lifetime.notifyStopped();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Kernel shutdown finished with errors.");
    }
  }

  /** Starts, blocks until a shutdown trigger, stops gracefully. Returns the exit code. */
  public run(): Promise<number> {
    if (this.runPromise !== undefined) return this.runPromise;
    const completion = Promise.withResolvers<number>();
    this.runPromise = completion.promise;
    void this.runCore().then(completion.resolve, completion.reject);
    return this.runPromise;
  }

  private async runCore(): Promise<number> {
    const cleanups: (() => void)[] = [];
    try {
      this.installSignalHandlers(cleanups);
      this.installUnhandledErrorHandlers(cleanups);
      try {
        await this.start();
      } catch (error) {
        const request = this.stopRequested;
        if (request === undefined || !(error instanceof StartupAbortedError)) {
          throw error;
        }
        await this.stop(request);
        return request.exitCode;
      }

      const request = await new Promise<StopRequest>((resolve) => {
        // lifetime.stop() or a process signal may have fired during start().
        if (this.stopRequested) {
          resolve(this.stopRequested);
          return;
        }
        this.notifyStopRequested = resolve;
      });
      await this.stop(request);
      return request.exitCode;
    } finally {
      for (let index = 0; index < cleanups.length; index += 1) {
        (cleanups[index] as () => void)();
      }
      this.notifyStopRequested = undefined;
    }
  }

  public health(options?: import("./health/HealthCheckContracts").HealthCheckOptions): Promise<HealthReport> {
    return this.container.resolve(HealthService).check(options);
  }

  private requestStop(request: StopRequest): void {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = request;
    if (this.state === "starting") {
      this.startupAbort?.abort(new StartupAbortedError());
    }
    this.notifyStopRequested?.(request);
  }

  private installSignalHandlers(cleanups: (() => void)[]): void {
    for (let index = 0; index < this.options.signals.length; index += 1) {
      const signal = this.options.signals[index] as NodeJS.Signals;
      const handler = (): void => {
        // Second signal: the operator insists — exit immediately.
        if (this.stopRequested) {
          process.exit(130);
        }
        this.requestStop({ exitCode: 0, signal });
      };
      process.on(signal, handler);
      cleanups.push(() => process.off(signal, handler));
    }
  }

  private installUnhandledErrorHandlers(cleanups: (() => void)[]): void {
    if (this.options.unhandledErrorPolicy !== "shutdown") {
      return;
    }
    const onUnhandled = (error: unknown): void => {
      this.logUnhandledError(error);
      if (this.stopRequested) {
        // Already shutting down and still failing: stop pretending.
        process.exit(1);
      }
      this.requestStop({ exitCode: 1 });
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUnhandled);
    });
  }

  private logUnhandledError(error: unknown): void {
    const redacted = redactSensitive(error);
    let logger;
    try {
      logger = this.container.tryResolve(LOGGER);
    } catch {
      logger = undefined;
    }
    if (logger !== undefined) {
      try {
        logger.error("Unhandled error, shutting down", { error: redacted });
        return;
      } catch {
        // A broken logger must not prevent the shutdown request.
      }
    }
    console.error("[osnv] Unhandled error, shutting down:", redacted);
  }

  private printStartupReport(): void {
    const logger = this.container.tryResolve(LOGGER);
    const fields = {
      environment: this.environment.name,
      debug: this.environment.debug,
      configKeys: this.configuration.keys().length,
      configMs: Number(this.timings.configMs.toFixed(1)),
      containerMs: Number(this.timings.containerMs.toFixed(1)),
      hostedServices: this.coordinator.startedHostedCount,
      hooks: this.coordinator.hookCount,
      startupMs: Number(this.startupMs.toFixed(1)),
    };
    if (logger) {
      logger.info("osnv started", fields);
      return;
    }
    console.log(`[osnv] started ${JSON.stringify(fields)}`);
  }
}
