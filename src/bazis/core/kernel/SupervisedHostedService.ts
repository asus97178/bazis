import type { HostedService, HostedServiceDiagnostics, HostedServicePlanValidator } from "../di";
import { validateHostedServicePlan, registerHostedServiceWrapper, type HostedServicePlanAdmission } from "../di/extensions/hosted-service";
import { awaitAbortable } from "./internal/awaitAbortable";
import { reportDiagnosticFailure } from "./internal/reportDiagnosticFailure";

export interface RestartPolicy {
  /** Total start attempts, including the first one. Default: 3. */
  readonly maxAttempts?: number;
  /** Initial pause before a retry; doubles each attempt. Default: 100ms. */
  readonly backoffMs?: number;
  /** Backoff cap. Default: 5000ms. */
  readonly maxBackoffMs?: number;
  /** Startup phase override; defaults to the concrete service's phase. */
  readonly phase?: number;
  /** Diagnostic notification before a retry; throws/returned rejections cannot stop recovery. */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Restart-with-backoff supervisor for hosted service startup: a transient
 * start failure (DB not up yet, port busy) retries with exponential backoff
 * instead of killing the whole application.
 * The factory only constructs a service: hosts call it during plan admission.
 * Validators see the complete plan of real service instances before startup.
 */
export class SupervisedHostedService implements HostedService {
  public get phase(): number { return this.admittedPhase ?? this.policy.phase ?? 0; }
  public readonly planValidator: HostedServicePlanValidator = {
    validate: (plan, signal) => validateHostedServicePlan(plan, signal),
  };
  private inner?: HostedService;
  private prepared?: HostedService;
  private admission?: HostedServicePlanAdmission;
  private admittedPhase?: number;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private diagnostics?: HostedServiceDiagnostics;

  public constructor(
    private readonly factory: () => HostedService,
    private readonly policy: RestartPolicy = {},
  ) {
    registerHostedServiceWrapper(this, {
      explicitPhase: policy.phase,
      prepare: () => this.inner ?? (this.prepared ??= this.factory()),
      bind: admission => { this.admission = admission; this.admittedPhase = admission.phase; },
    });
  }

  /** Passed on to every attempt's service before it starts. */
  public useDiagnostics(diagnostics: HostedServiceDiagnostics): void {
    this.diagnostics = diagnostics;
  }

  public start(signal?: AbortSignal): Promise<void> {
    if (this.stopping) {
      const stopping = this.stopping;
      return stopping.then(() => {
        if (this.stopping === stopping) this.stopping = undefined;
        return this.start(signal);
      });
    }
    return this.starting ??= Promise.resolve().then(() => this.startAttempts(signal));
  }

  private async startAttempts(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.admission) await validateHostedServicePlan([this], signal);
    signal?.throwIfAborted();
    const maxAttempts = Math.max(1, this.policy.maxAttempts ?? 3);
    const initialBackoff = this.policy.backoffMs ?? 100;
    const maxBackoff = this.policy.maxBackoffMs ?? 5_000;

    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      const service = this.prepared!;
      this.prepared = undefined;
      try {
        signal?.throwIfAborted();
        if (this.diagnostics) service.useDiagnostics?.(this.diagnostics);
        await service.start(signal);
        signal?.throwIfAborted();
        this.inner = service;
        return;
      } catch (error) {
        try {
          await service.stop();
        } catch (cleanupError) {
          this.inner = service;
          throw new SupervisedCleanupError(error, cleanupError);
        }
        signal?.throwIfAborted();
        if (error instanceof SupervisedCleanupError) throw error;
        if (attempt >= maxAttempts) {
          throw error;
        }
        this.notifyRetry(attempt, error);
        const backoff = Math.min(initialBackoff * 2 ** (attempt - 1), maxBackoff);
        await waitForRetry(backoff, signal);
        signal?.throwIfAborted();
        // Construction and admission errors are configuration failures, not
        // another started attempt. Never retry an unvalidated replacement.
        const candidate = this.factory();
        await this.admission!.replace(candidate, signal);
        signal?.throwIfAborted();
        this.prepared = candidate;
      }
    }
  }

  private notifyRetry(attempt: number, error: unknown): void {
    try {
      void Promise.resolve(this.policy.onRetry?.(attempt, error))
        .catch(() => reportDiagnosticFailure("supervised.onRetry"));
    } catch {
      reportDiagnosticFailure("supervised.onRetry");
    }
  }

  public stop(): Promise<void> {
    return this.stopping ??= this.stopInner();
  }

  private async stopInner(): Promise<void> {
    await this.starting?.catch(() => {});
    if (this.inner) {
      await this.inner.stop();
      this.inner = undefined;
    }
    this.prepared = undefined;
    this.admission = undefined;
    this.starting = undefined;
  }
}

class SupervisedCleanupError extends AggregateError {
  public constructor(startError: unknown, cleanupError: unknown) {
    super([startError, cleanupError], "Supervised service startup and cleanup failed; retry is unsafe.", { cause: startError });
    this.name = "SupervisedCleanupError";
  }
}

async function waitForRetry(backoffMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await awaitAbortable(new Promise<void>(resolve => { timer = setTimeout(resolve, backoffMs); }), signal);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Sugar for `addHostedService(services, supervised(() => new Worker(), { ... }))`. */
export function supervised(factory: () => HostedService, policy?: RestartPolicy): () => HostedService {
  return () => new SupervisedHostedService(factory, policy);
}
