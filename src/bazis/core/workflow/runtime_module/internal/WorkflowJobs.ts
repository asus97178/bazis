import type { ServiceProvider } from "../../../di";
import { WorkflowClock } from "../../contracts/WorkflowClock";
import { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import { ChildCalls } from "./ChildCalls";
import { RunLimits } from "./RunLimits";
import { EventDelivery } from "./EventDelivery";
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

  /**
   * Takes up to `batchSize` due jobs with `FOR UPDATE SKIP LOCKED` and a lease, so
   * instances never take one job twice. {@link run} renews the lease of each as it starts.
   */
  async claim(batchSize: number): Promise<WfJob[]> {
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      const now = scope.resolve(WorkflowClock).now();
      return await db.transactionScope(async () => {
        const jobs = await db.jobs
          .where((j) => j.dueAt.lte(now).and(j.lockedUntil.isNull().or(j.lockedUntil.lt(now))))
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

  /**
   * The lease of a claimed job starts when the job does: a batch runs one job after
   * another, and a job that waited for the ones before it longer than a lease may
   * have been taken by another worker. `false` then: the job is not this worker's.
   */
  private async begin(job: WfJob): Promise<boolean> {
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      const lockedUntil = new Date(scope.resolve(WorkflowClock).now().getTime() + LEASE_MS);
      const held = job.lockedUntil;
      const { affectedRows } = await db.jobs.asNoTracking()
        .where((j) => j.id.eq(job.id).and(held === null ? j.lockedUntil.isNull() : j.lockedUntil.eq(held)))
        .executeUpdate({ lockedUntil });
      if (affectedRows === 0) return false;
      job.lockedUntil = lockedUntil;
      return true;
    } finally {
      await scope.dispose();
    }
  }

  /** Gives back claimed jobs that will not run, a stopping worker's: they are free at once, and the claim does not count as an attempt. */
  async release(jobs: readonly WfJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const scope = this.services.createScope();
    try {
      const db = scope.resolve(RuntimeDbContext);
      for (const job of jobs) {
        const held = job.lockedUntil;
        if (held === null) continue;
        await db.jobs.asNoTracking().where((j) => j.id.eq(job.id).and(j.lockedUntil.eq(held))).executeUpdate({ lockedUntil: null, attempts: Math.max(job.attempts - 1, 0) });
      }
    } finally {
      await scope.dispose();
    }
  }

  async run(job: WfJob, signal: AbortSignal): Promise<void> {
    if (!await this.begin(job).catch((error: unknown) => { this.report("job could not begin", error, { job: job.id }); return false; })) return;
    const scope = this.services.createScope();
    try {
      switch (job.kind) {
        case "timer":
          await scope.resolve(TimerStep).run(job);
          break;
        case "loop":
          await scope.resolve(TimerStep).continueLoop(job);
          break;
        case "schedule":
          await scope.resolve(Schedules).fire(job);
          break;
        case "call":
          await scope.resolve(ChildCalls).call(job);
          break;
        case "returned":
          await scope.resolve(ChildCalls).returned(job);
          break;
        case "cancelChildren":
          await scope.resolve(ChildCalls).cancelChildren(job);
          break;
        case "runTimeout":
          await scope.resolve(RunLimits).runTimeout(job);
          break;
        case "release":
          await scope.resolve(RunLimits).release(job);
          break;
        case "errorHandler":
          await scope.resolve(RunLimits).errorHandler(job);
          break;
        case "event":
          await scope.resolve(EventDelivery).deliverLater(job);
          break;
        case "eventStart":
          await scope.resolve(EventDelivery).startLater(job);
          break;
        default:
          await scope.resolve(ToolStep).run(job, signal);
      }
    } catch (error) {
      this.report("job failed", error, { job: job.id, instance: job.instanceId, attempts: job.attempts });
      await this.giveUpOrDelay(job, error).catch((failure: unknown) => this.report("job failure handling failed", failure, { job: job.id }));
    } finally {
      await scope.dispose();
    }
  }

  /** Matches the scheduled starts against the published versions and gives a free place to whoever still waits for one. */
  async reconcile(): Promise<void> {
    const scope = this.services.createScope();
    try {
      await scope.resolve(Schedules).reconcile();
      await scope.resolve(RunLimits).releaseWaiting();
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
        if (token && token.status === "waiting" && step.instance.status === "running") await engine.fail(step, token, "job_failed", message.slice(0, 1000));
      });
    } finally {
      await scope.dispose();
    }
  }
}
