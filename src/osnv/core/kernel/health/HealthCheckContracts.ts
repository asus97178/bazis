import { createToken, type ServiceCollection } from "../../di";

export interface HealthCheckResult {
  readonly healthy: boolean;
  readonly details?: string;
}

export interface HealthCheck {
  readonly name: string;
  /** Shared by concurrent reports of one HealthService; signal aborts when all observers leave. */
  check(signal?: AbortSignal): HealthCheckResult | Promise<HealthCheckResult>;
}

export interface HealthCheckOptions {
  readonly timeoutMs?: number;
  readonly checkTimeoutMs?: number;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export interface HealthReportEntry {
  readonly name: string;
  readonly healthy: boolean;
  readonly details?: string;
  readonly durationMs: number;
}

export interface HealthReport {
  readonly healthy: boolean;
  readonly checks: readonly HealthReportEntry[];
}

/** Enumerable token: register any number of checks. */
export const HEALTH_CHECK = createToken<HealthCheck>("OsnvHealthCheck");

export function addHealthCheck(services: ServiceCollection, factory: () => HealthCheck): void {
  services.addSingleton({
    provide: HEALTH_CHECK,
    useFactory: factory,
    deps: [],
  });
}
