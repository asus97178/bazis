import { BackgroundService, delay } from "../../../background";
import type { ServiceProvider } from "../../../di";
import type { ConfigView } from "../../../kernel";
import type { workflowRuntimeConfig } from "../config/Runtime.config";
import { Schedules } from "../internal/Schedules";
import { TimerStep } from "../internal/TimerStep";
import { ToolStep } from "../internal/ToolStep";
import { WorkflowEngine } from "../internal/WorkflowEngine";
import { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";

/** How long a claimed job belongs to this worker; if it dies, another one takes the job after that. */
const LEASE_MS = 5 * 60_000;
/** A job that keeps failing outside its Tool (the database, a lost version) fails its step after this many tries. */
const MAX_JOB_ATTEMPTS = 5;
/** How often the scheduled starts are matched against the published versions. */
const RECONCILE_MS = 60_000;


/**
 * Takes due jobs of `bazis_wf_run_jobs` every `worker.intervalMs`, up to
 * `worker.batchSize` at a time, with `FOR UPDATE SKIP LOCKED` and a lease, so
 * application instances never take one job twice. A full batch is followed by
 * the next one at once. Every job runs in its own DI scope.
 */
export class WorkflowWorker extends BackgroundService {
  constructor(
    private readonly services: ServiceProvider,
    private readonly config: ConfigView<WorkflowSettings>,
  ) {
    super();
  }

  protected override async execute(signal: AbortSignal): Promise<void> {
    if (!this.config.get("worker.enabled")) return;
    const intervalMs = this.config.get("worker.intervalMs");
    const batchSize = this.config.get("worker.batchSize");
    let reconciledAt = 0;
    while (!signal.aborted) {
      if (Date.now() - reconciledAt >= RECONCILE_MS) {
        reconciledAt = Date.now();
        await this.reconcile();
      }
      let claimed = 0;
      try {
        const jobs = await this.claim(batchSize);
        claimed = jobs.length;
        for (const job of jobs) {
          if (signal.aborted) return;
          await this.run(job, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.reportFailure("claiming jobs failed", error);
      }
      if (claimed < batchSize) await delay(intervalMs, signal);
    }
  }

  private async run(job: WfJob, signal: AbortSignal): Promise<void> {
    const scope = this.services.createScope();
    try {
      if (job.kind === "timer") await scope.resolve(TimerStep).run(job);
      else if (job.kind === "schedule") await scope.resolve(Schedules).fire(job);
      else await scope.resolve(ToolStep).run(job, signal);
    } catch (error) {
      this.reportFailure("job failed", error, { job: job.id, instance: job.instanceId, attempts: job.attempts });
      await this.giveUpOrDelay(job, error).catch((failure: unknown) => this.reportFailure("job failure handling failed", failure, { job: job.id }));
    } finally {
      await scope.dispose();
    }
  }

  private async reconcile(): Promise<void> {
    const scope = this.services.createScope();
    try {
      await scope.resolve(Schedules).reconcile();
    } catch (error) {
      this.reportFailure("scheduled starts could not be planned", error);
    } finally {
      await scope.dispose();
    }
  }

  /** A job that failed outside its Tool waits a minute per try, then fails its step for a person to retry. */
  private async giveUpOrDelay(job: WfJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      if (job.attempts < MAX_JOB_ATTEMPTS || job.instanceId === null || job.tokenId === null) {
        await db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ dueAt: new Date(Date.now() + job.attempts * 60_000), lockedUntil: null, lastError: message.slice(0, 1000) });
        return;
      }
      const engine = scope.resolve(WorkflowEngine);
      await engine.inStep(job.instanceId, async (step) => {
        await db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
        const token = step.tokens.find((t) => t.id === job.tokenId);
        if (token && token.status === "waiting" && step.instance.status === "running") engine.fail(step, token, "job_failed", message.slice(0, 1000));
      });
    } finally {
      await scope.dispose();
    }
  }

  private async claim(batchSize: number): Promise<WfJob[]> {
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      return await db.transactionScope(async () => {
        const now = new Date();
        const jobs = await db.jobs
          .where((j) => j.kind.in(["tool", "timer", "schedule"]).and(j.dueAt.lte(now)).and(j.lockedUntil.isNull().or(j.lockedUntil.lt(now))))
          .orderBy((j) => j.id)
          .take(batchSize)
          .forUpdate({ skipLocked: true })
          .toList();
        for (const job of jobs) {
          job.lockedUntil = new Date(now.getTime() + LEASE_MS);
          job.attempts += 1;
        }
        await db.saveChanges();
        return jobs;
      });
    } finally {
      await scope.dispose();
    }
  }
}

/** The resolved settings of {@link workflowRuntimeConfig}. */
export interface WorkflowSettings {
  readonly "worker.enabled": boolean;
  readonly "worker.intervalMs": number;
  readonly "worker.batchSize": number;
  readonly "retention.enabled": boolean;
  readonly "retention.intervalMs": number;
  readonly "retention.batchSize": number;
}
