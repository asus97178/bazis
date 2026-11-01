import { inputSpecOf, validateForm } from "../../../../library/workflow";
import { WorkflowError } from "../../contracts/WorkflowError";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import type { WorkflowEngine } from "./WorkflowEngine";

/** How many waiting instances of a process one pass looks at. */
const RELEASE_BATCH = 1000;

/** What a whole run is limited by and what follows its failure: `runTimeout`, `maxConcurrent`, `sameKey: "queue"`, `errorHandler`. */
export class RunLimits {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
  ) {}

  /** The run's time is out. A `failed` instance waits for a person; its retry plans the job again. */
  async runTimeout(job: WfJob): Promise<void> {
    const done = job.instanceId === null ? null : await this.engine.inStep(job.instanceId, async (step) => {
      await this.dropJob(job);
      if (step.instance.status === "running") await this.engine.timeOut(step);
      return true;
    });
    if (done === null) await this.dropJob(job);
  }

  /** A place may have come free: instances of the process that wait for one start, oldest first. */
  async release(job: WfJob): Promise<void> {
    await this.releaseProcess((job.payload as { processKey: string }).processKey);
    await this.dropJob(job);
  }

  /** Every process with waiting instances: the safety net for what no ending instance tells, such as a new version without a limit. */
  async releaseWaiting(): Promise<void> {
    const rows = await this.db.instances.asNoTracking().where((i) => i.status.eq("pending")).select((i) => ({ processKey: i.processKey })).toList();
    for (const key of new Set(rows.map((row) => row.processKey))) await this.releaseProcess(key);
  }

  private async releaseProcess(processKey: string): Promise<void> {
    const waiting = await this.db.instances.asNoTracking().where((i) => i.processKey.eq(processKey).and(i.status.eq("pending"))).orderBy((i) => i.id).take(RELEASE_BATCH).toList();
    if (waiting.length === 0) return;
    // Graphs live in the Definitions store, out of reach inside the transaction; `inStep` finds them cached.
    const graphs = new Map(await Promise.all(waiting.map(async (row) => [row.id, await this.engine.graphOf(row.versionId)] as const)));
    await this.db.transactionScope(async () => {
      await this.engine.lockProcess(processKey);
      let running = await this.engine.runningOf(processKey);
      for (const row of waiting) {
        const { maxConcurrent, sameKey } = graphs.get(row.id)!.document.settings ?? {};
        if (maxConcurrent !== undefined && running >= maxConcurrent) continue;
        if (sameKey === "queue" && row.businessKey !== null && await this.keyTaken(processKey, row.businessKey, row.id)) continue;
        const released = await this.engine.inStep(row.id, async (step) => {
          if (step.instance.status !== "pending") return false;
          await this.engine.release(step);
          return true;
        });
        if (released === true) running += 1;
      }
    });
  }

  /** Whether an instance older than this one still works on the key: it goes first. */
  private async keyTaken(processKey: string, businessKey: string, id: string): Promise<boolean> {
    const same = await this.db.instances.asNoTracking()
      .where((i) => i.processKey.eq(processKey).and(i.businessKey.eq(businessKey)).and(i.status.in(["pending", "running", "failed"])).and(i.id.lt(id)))
      .count();
    return same > 0;
  }

  /** An `errorHandler` job: the handler starts with `$event` telling what happened. What keeps it from starting goes to the history of the instance that failed. */
  async errorHandler(job: WfJob): Promise<void> {
    const failed = job.instanceId === null ? undefined : await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(job.instanceId!));
    if (!failed) {
      await this.dropJob(job);
      return;
    }
    const process = (job.payload as { process: string }).process;
    const note = (data: Record<string, unknown>) => this.engine.inStep(failed.id, async (step) => {
      await this.dropJob(job);
      this.engine.history(step, null, null, "handler", { process, ...data });
    });
    let version: VersionDetails;
    try {
      version = await this.definitions.latest(process);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      await note({ error: error.message });
      return;
    }
    const start = Object.entries(version.document.nodes).find(([, node]) => node.kind === "manualStart");
    if (!start) {
      await note({ error: "the process has no manual start" });
      return;
    }
    const { value, issues } = validateForm(inputSpecOf(version.document), {});
    if (issues.length > 0) {
      await note({ error: "the process needs input", issues });
      return;
    }
    const graph = this.engine.cache(version);
    // In one transaction with the job, so that a repeat of the job does not start a second handler.
    await this.engine.inStep(failed.id, async (step) => {
      await this.dropJob(job);
      const { id } = await this.engine.begin(graph, start[0], {
        input: value,
        partition: failed.partition,
        businessKey: null,
        startedVia: "errorHandler",
        actor: { kind: "system", id: `process:${failed.processKey}` },
        event: {
          key: "workflow.instance-stopped",
          payload: { instanceId: failed.id, processKey: failed.processKey, version: failed.version, partition: failed.partition, businessKey: failed.businessKey, status: failed.status, node: failed.error?.node ?? null, code: failed.error?.code ?? null, message: failed.error?.message ?? null },
        },
        cause: { instanceId: failed.id, processKey: failed.processKey },
      });
      this.engine.history(step, null, null, "handler", { process, instanceId: id });
    });
  }

  private async dropJob(job: WfJob): Promise<void> {
    await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
  }
}
