import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import type { WorkflowEngine } from "./WorkflowEngine";

/** One `timer` job: a `timerCatch` step or a boundary timer is due. A closed token drops it. */
export class TimerStep {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
  ) {}

  async run(job: WfJob): Promise<void> {
    const fired = job.instanceId === null || job.tokenId === null
      ? null
      : await this.engine.inStep(job.instanceId, async (step) => {
        await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
        return await this.engine.timerFired(step, job.tokenId!);
      });
    if (fired === null) await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
  }
}
