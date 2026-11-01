import type { ServiceProvider } from "../../../di";
import { WorkflowClock } from "../../contracts/WorkflowClock";
import { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import { Schedules } from "./Schedules";
import { TimerStep } from "./TimerStep";
import { LEASE_MS, ToolStep } from "./ToolStep";
import { WorkflowEngine } from "./WorkflowEngine";

/** A job that keeps failing outside its Tool (the database, a lost version) fails its step after this many tries. */
const MAX_JOB_ATTEMPTS = 5;

/** Where a failure goes: the worker's log. */
export type JobFailureReport = (message: string, error: unknown, fields?: Readonly<Record<string, unknown>>) => void;

/**
 * Claiming and running jobs of `bazis_wf2_run_jobs`: the work of the worker, and
 * of `drain` in tests. Every job runs in its own DI scope.
 */
export class WorkflowJobs {
  constructor(
    private readonly services: ServiceProvider,
    private readonly report: JobFailureReport,
  ) {}

  /** Takes up to `batchSize` due jobs with `FOR UPDATE SKIP LOCKED` and a lease, so instances never take one job twice. */
  async claim(batchSize: number): Promise<WfJob[]> {
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      const now = scope.resolve(WorkflowClock).now();
      return await db.transactionScope(async () => {
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

  async run(job: WfJob, signal: AbortSignal): Promise<void> {
    const scope = this.services.createScope();
    try {
      if (job.kind === "timer") await scope.resolve(TimerStep).run(job);
      else if (job.kind === "schedule") await scope.resolve(Schedules).fire(job);
      else await scope.resolve(ToolStep).run(job, signal);
    } catch (error) {
      this.report("job failed", error, { job: job.id, instance: job.instanceId, attempts: job.attempts });
      await this.giveUpOrDelay(job, error).catch((failure: unknown) => this.report("job failure handling failed", failure, { job: job.id }));
    } finally {
      await scope.dispose();
    }
  }

  /** Matches the scheduled starts against the published versions. */
  async reconcile(): Promise<void> {
    const scope = this.services.createScope();
    try {
      await scope.resolve(Schedules).reconcile();
    } catch (error) {
      this.report("scheduled starts could not be planned", error);
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
        const now = scope.resolve(WorkflowClock).now();
        await db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ dueAt: new Date(now.getTime() + job.attempts * 60_000), lockedUntil: null, lastError: message.slice(0, 1000) });
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
}
