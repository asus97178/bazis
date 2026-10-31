import { BackgroundService, delay } from "../../../background";
import type { ServiceProvider } from "../../../di";
import { WorkflowClock } from "../../contracts/WorkflowClock";
import type { ConfigView } from "../../../kernel";
import type { workflowRuntimeConfig } from "../config/Runtime.config";
import { WorkflowJobs } from "../internal/WorkflowJobs";

/** How often the scheduled starts are matched against the published versions. */
const RECONCILE_MS = 60_000;

/**
 * Takes due jobs of `bazis_wf_run_jobs` every `worker.intervalMs`, up to
 * `worker.batchSize` at a time ({@link WorkflowJobs}). A full batch is
 * followed by the next one at once.
 */
export class WorkflowWorker extends BackgroundService {
  private readonly jobs: WorkflowJobs;

  constructor(
    private readonly services: ServiceProvider,
    private readonly config: ConfigView<WorkflowSettings>,
  ) {
    super();
    this.jobs = new WorkflowJobs(services, (message, error, fields) => this.reportFailure(message, error, fields));
  }

  protected override async execute(signal: AbortSignal): Promise<void> {
    if (!this.config.get("worker.enabled") || this.services.resolve(WorkflowClock).manual === true) return;
    const intervalMs = this.config.get("worker.intervalMs");
    const batchSize = this.config.get("worker.batchSize");
    let reconciledAt = 0;
    while (!signal.aborted) {
      if (Date.now() - reconciledAt >= RECONCILE_MS) {
        reconciledAt = Date.now();
        await this.jobs.reconcile();
      }
      let claimed = 0;
      try {
        const jobs = await this.jobs.claim(batchSize);
        claimed = jobs.length;
        for (const job of jobs) {
          if (signal.aborted) return;
          await this.jobs.run(job, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.reportFailure("claiming jobs failed", error);
      }
      if (claimed < batchSize) await delay(intervalMs, signal);
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
