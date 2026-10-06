import type { ServiceResolver } from "../../di";
import { redactSensitiveText } from "../../../library/redaction";
import { awaitAbortable } from "../internal/awaitAbortable";
import { KernelError } from "../errors";
import { HEALTH_CHECK, type HealthCheck, type HealthCheckOptions, type HealthCheckResult, type HealthReport, type HealthReportEntry } from "./HealthCheckContracts";

interface ActiveCheck {
  readonly controller: AbortController;
  readonly work: Promise<HealthCheckResult>;
  observers: number;
  settled: boolean;
}

/** Bounded concurrent checks; report order matches registration order. */
export class HealthService {
  private readonly active = new WeakMap<HealthCheck, ActiveCheck>();

  public constructor(private readonly resolver: ServiceResolver) {}

  public async check(options: HealthCheckOptions = {}): Promise<HealthReport> {
    const timeoutMs = bounded(options.timeoutMs ?? 5000, "timeoutMs", 2147483647);
    const checkTimeoutMs = bounded(options.checkTimeoutMs ?? 1000, "checkTimeoutMs", 2147483647);
    const concurrency = bounded(options.concurrency ?? 4, "concurrency", 1024);
    const checks = this.resolver.resolveAll(HEALTH_CHECK);
    const entries: HealthReportEntry[] = new Array(checks.length);
    const report = new AbortController();
    const timer = setTimeout(() => report.abort(new Error("Health report timed out.")), timeoutMs);
    const reportSignal = options.signal ? AbortSignal.any([options.signal, report.signal]) : report.signal;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < checks.length) {
        const index = next++;
        const check = checks[index]!;
        const startedAt = performance.now();
        const deadline = new AbortController();
        const checkTimer = setTimeout(() => deadline.abort(new Error("Health check timed out.")), checkTimeoutMs);
        const signal = AbortSignal.any([reportSignal, deadline.signal]);
        try {
          signal.throwIfAborted();
          const result = await this.observe(check, signal);
          entries[index] = {
            name: check.name, healthy: result.healthy === true,
            ...(result.details === undefined ? {} : { details: redactSensitiveText(result.details) }),
            durationMs: performance.now() - startedAt,
          };
        } catch (error) {
          entries[index] = { name: check.name, healthy: false, details: redactSensitiveText(error instanceof Error ? error.message : String(error)), durationMs: performance.now() - startedAt };
        } finally { clearTimeout(checkTimer); }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(concurrency, checks.length) }, worker)); }
    finally { clearTimeout(timer); }
    return { healthy: entries.every(entry => entry.healthy), checks: entries };
  }

  /** A deadline ends observation; it cannot prove that arbitrary user work stopped. */
  private async observe(check: HealthCheck, signal: AbortSignal): Promise<HealthCheckResult> {
    signal.throwIfAborted();
    let active = this.active.get(check);
    if (active?.controller.signal.aborted) {
      throw new KernelError("Previous health check is still running after cancellation.");
    }
    if (active === undefined) {
      const controller = new AbortController();
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return check.check(controller.signal);
      });
      active = { controller, work, observers: 0, settled: false };
      this.active.set(check, active);
      const owned = active;
      const settle = () => {
        owned.settled = true;
        if (this.active.get(check) === owned) this.active.delete(check);
      };
      // Observe late rejection too, including after every report timed out.
      void work.then(settle, settle);
    }
    active.observers++;
    try {
      return await awaitAbortable(active.work, signal);
    } finally {
      active.observers--;
      if (active.observers === 0 && !active.settled) {
        active.controller.abort(signal.reason ?? new Error("Health check has no active observers."));
      }
    }
  }
}
function bounded(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new KernelError(`Health ${name} must be an integer from 1 to ${max}.`);
  return value;
}
