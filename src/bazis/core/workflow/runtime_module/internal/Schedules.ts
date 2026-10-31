import { parseCron } from "../../../../library/workflow";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfJob } from "../model/WfJob.model";
import type { WorkflowEngine } from "./WorkflowEngine";

const SCHEDULE_ACTOR = { kind: "system", id: "schedule" } as const;

/**
 * Scheduled starts (`scheduleStart`, cron in UTC). Every latest published
 * version with such nodes has one `schedule` job, due at the nearest firing of
 * any of them. `reconcile` keeps the jobs in line with the catalog; `fire`
 * starts the instances of a due job and plans the next firing in the same
 * transaction, so a crash never starts one firing twice. Firings missed while
 * no worker ran are not caught up: the next one is planned from now.
 */
export class Schedules {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
  ) {}

  /** Adds jobs for new scheduled versions and drops those of replaced or archived ones. */
  async reconcile(now = this.engine.now()): Promise<void> {
    const versions = (await this.definitions.published()).filter((version) => scheduleNodes(version).length > 0);
    const wanted = new Map(versions.map((version) => [version.id, version]));
    const added: WfJob[] = [];
    await this.db.transactionScope(async () => {
      // One reconciler at a time across application instances.
      await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext('bazis.workflow.schedules'))");
      const jobs = await this.db.jobs.asNoTracking().where((j) => j.kind.eq("schedule")).toList();
      const stale = jobs.filter((job) => job.versionId === null || !wanted.has(job.versionId)).map((job) => job.id);
      if (stale.length > 0) await this.db.jobs.asNoTracking().where((j) => j.id.in(stale)).executeDelete();
      const planned = new Set(jobs.map((job) => job.versionId));
      for (const version of versions) {
        if (planned.has(version.id)) continue;
        const dueAt = nextFiring(version, now);
        if (dueAt === undefined) continue;
        const job = Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "schedule" as const, versionId: version.id, dueAt });
        this.db.jobs.add(job);
        added.push(job);
      }
      await this.db.saveChanges();
    });
    // The jobs belong to the worker from now on: this context must not hold them.
    for (const job of added) this.db.detach(job);
  }

  /** A `schedule` job is due: start an instance from every node firing at this minute and plan the next firing. */
  async fire(job: WfJob): Promise<void> {
    const version = job.versionId === null ? undefined : await this.definitions.versionById(job.versionId);
    const latest = version === undefined ? undefined : (await this.definitions.published()).find((item) => item.id === version.id);
    if (!latest) {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      return;
    }
    const due = new Date(Math.floor(job.dueAt.getTime() / 60_000) * 60_000);
    const graph = this.engine.cache(latest);
    await this.db.transactionScope(async () => {
      // Planned from now, not from the missed firing: a stopped worker does not catch up.
      const now = this.engine.now();
      const next = nextFiring(latest, now > due ? now : due);
      if (next === undefined) await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      else await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ dueAt: next, lockedUntil: null, attempts: 0, lastError: null });
      for (const [nodeId, cron] of scheduleNodes(latest)) {
        if (!cron.matches(due)) continue;
        await this.engine.begin(graph, nodeId, { input: {}, partition: null, businessKey: null, startedVia: "schedule", actor: SCHEDULE_ACTOR });
      }
    });
  }
}

function scheduleNodes(version: VersionDetails) {
  return Object.entries(version.document.nodes).flatMap(([id, node]) => {
    const cron = node.kind === "scheduleStart" && typeof node.config?.cron === "string" ? parseCron(node.config.cron) : undefined;
    return cron === undefined ? [] : [[id, cron] as const];
  });
}

function nextFiring(version: VersionDetails, after: Date): Date | undefined {
  const times = scheduleNodes(version).map(([, cron]) => cron.next(after)?.getTime()).filter((time): time is number => time !== undefined);
  return times.length === 0 ? undefined : new Date(Math.min(...times));
}
