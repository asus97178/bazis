import { BackgroundService, delay } from "../../../background";
import type { ServiceProvider } from "../../../di";
import type { ConfigView } from "../../../kernel";
import type { workflowRuntimeConfig } from "../config/Runtime.config";
import { ToolStep } from "../internal/ToolStep";
import { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";

/** How long a claimed job belongs to this worker; if it dies, another one takes the job after that. */
const LEASE_MS = 5 * 60_000;


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
    while (!signal.aborted) {
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
      await scope.resolve(ToolStep).run(job, signal);
    } catch (error) {
      this.reportFailure("job failed", error, { job: job.id, instance: job.instanceId });
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
          .where((j) => j.kind.eq("tool").and(j.dueAt.lte(now)).and(j.lockedUntil.isNull().or(j.lockedUntil.lt(now))))
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
