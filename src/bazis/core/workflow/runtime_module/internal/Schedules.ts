import { inputSpecOf, parseCron, validateForm, type ProcessNode } from "../../../../library/workflow";
import type { ServiceProvider } from "../../../di";
import { WorkflowPartitions, type ProcessPartition } from "../../contracts/WorkflowPartitions";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { WorkflowLanguages } from "../../internal/WorkflowLanguages";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfJob } from "../model/WfJob.model";
import type { WorkflowEngine } from "./WorkflowEngine";

const SCHEDULE_ACTOR = { kind: "system", id: "schedule" } as const;
const MINUTE = 60_000;

/** The `config` of a `scheduleStart`, as validation lets it through. */
interface ScheduleConfig {
  readonly cron: string;
  readonly timezone?: string;
  readonly from?: string;
  readonly until?: string;
  readonly overlap?: "skip" | "queue" | "parallel";
  readonly catchUp?: boolean;
  readonly partitions?: "none" | "all" | readonly string[];
}

/** One place a node fires in: a partition with its time zone. */
interface Target {
  readonly partition: string | null;
  readonly timezone: string | undefined;
}

/**
 * Scheduled starts (`scheduleStart`). Every node of a latest published version
 * has a `schedule` job per partition it runs in, due at its next firing.
 * `reconcile` keeps the jobs in line with the catalog and `WorkflowPartitions`;
 * `fire` starts the instance of a due job and plans the next firing in the same
 * transaction, so a crash never starts one firing twice. With `catchUp` the next
 * firing is planned from the one just made, so every missed firing runs;
 * otherwise from now, and those missed while no worker ran are gone.
 */
export class Schedules {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
    private readonly languages: WorkflowLanguages,
    /** The scope: the application's own `WorkflowPartitions` replaces the default. */
    private readonly services: ServiceProvider,
  ) {}

  /** Adds jobs for new scheduled nodes and partitions and drops those no longer wanted. */
  async reconcile(now = this.engine.now()): Promise<void> {
    const wanted = new Map<string, { readonly version: VersionDetails; readonly nodeId: string; readonly config: ScheduleConfig; readonly target: Target }>();
    const invalid: string[] = [];
    for (const version of await this.definitions.published()) {
      for (const [nodeId, config] of scheduleNodes(version)) {
        for (const target of await this.targetsOf(version.key, config)) {
          if (parseCron(config.cron, target.timezone) === undefined) invalid.push(`${version.key}: time zone ${String(target.timezone)} of partition ${String(target.partition)}`);
          else wanted.set(keyOf(version.id, nodeId, target.partition), { version, nodeId, config, target });
        }
      }
    }
    const added: WfJob[] = [];
    await this.db.transactionScope(async () => {
      // One reconciler at a time across application instances.
      await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext('bazis.workflow.schedules'))");
      const jobs = await this.db.jobs.asNoTracking().where((j) => j.kind.eq("schedule")).toList();
      const stale = jobs.filter((job) => !wanted.has(keyOf(job.versionId, job.nodeId, job.partition))).map((job) => job.id);
      if (stale.length > 0) await this.db.jobs.asNoTracking().where((j) => j.id.in(stale)).executeDelete();
      const planned = new Set(jobs.map((job) => keyOf(job.versionId, job.nodeId, job.partition)));
      for (const [key, { version, nodeId, config, target }] of wanted) {
        if (planned.has(key)) continue;
        const dueAt = nextFiring(config, target, now);
        if (dueAt === undefined) continue;
        const job = Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "schedule" as const, versionId: version.id, nodeId, partition: target.partition, dueAt });
        this.db.jobs.add(job);
        added.push(job);
      }
      await this.db.saveChanges();
    });
    // The jobs belong to the worker from now on: this context must not hold them.
    for (const job of added) this.db.detach(job);
    if (invalid.length > 0) throw new Error(`Scheduled starts are not planned for ${invalid.join("; ")}`);
  }

  /** A `schedule` job is due: start an instance unless `overlap` says otherwise, and plan the next firing. */
  async fire(job: WfJob): Promise<void> {
    const version = job.versionId === null ? undefined : await this.definitions.versionById(job.versionId);
    const latest = version === undefined ? undefined : (await this.definitions.published()).find((item) => item.id === version.id);
    const config = latest === undefined || job.nodeId === null ? undefined : scheduleConfig(latest.document.nodes[job.nodeId]);
    const target = latest === undefined || config === undefined ? undefined : (await this.targetsOf(latest.key, config)).find((item) => item.partition === job.partition);
    if (!latest || !config || !target) {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      return;
    }
    const due = new Date(Math.floor(job.dueAt.getTime() / MINUTE) * MINUTE);
    const graph = this.engine.cache(latest);
    const { overlap = "parallel" } = config;
    await this.db.transactionScope(async () => {
      const now = this.engine.now();
      const next = nextFiring(config, target, config.catchUp === true || now <= due ? due : now);
      if (next === undefined) await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      else await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ dueAt: next, lockedUntil: null, attempts: 0, lastError: null });
      let queued = false;
      if (overlap !== "parallel") {
        await this.engine.lockProcess(latest.key);
        if (await this.engine.scheduledLive(latest.key, target.partition) > 0) {
          if (overlap === "skip") return;
          queued = true;
        }
      }
      await this.engine.begin(graph, job.nodeId!, { input: validateForm(inputSpecOf(latest.document), {}).value, partition: target.partition, businessKey: null, startedVia: "schedule", actor: SCHEDULE_ACTOR, queued, scheduledAt: due });
    });
  }

  /** Where a node runs: `none` without a partition, `all` in every enabled one, a list in those not switched off. */
  private async targetsOf(processKey: string, config: ScheduleConfig): Promise<readonly Target[]> {
    const { partitions = "none", timezone } = config;
    if (partitions === "none") return [{ partition: null, timezone }];
    const known = await this.partitionsOf(processKey);
    if (partitions === "all") return known.filter((item) => item.enabled).map((item) => ({ partition: item.partition, timezone: timezone ?? item.timezone }));
    return partitions.flatMap((partition) => {
      const entry = known.find((item) => item.partition === partition);
      return entry?.enabled === false ? [] : [{ partition, timezone: timezone ?? entry?.timezone }];
    });
  }

  private async partitionsOf(processKey: string): Promise<readonly ProcessPartition[]> {
    return await this.services.resolve(WorkflowPartitions).of(processKey, { partition: null, language: this.languages.default, actor: null });
  }
}

function keyOf(versionId: string | null, nodeId: string | null, partition: string | null): string {
  return JSON.stringify([versionId, nodeId, partition]);
}

function scheduleConfig(node: ProcessNode | undefined): ScheduleConfig | undefined {
  return node?.kind === "scheduleStart" && typeof node.config?.cron === "string" ? node.config as unknown as ScheduleConfig : undefined;
}

function scheduleNodes(version: VersionDetails): readonly (readonly [string, ScheduleConfig])[] {
  return Object.entries(version.document.nodes).flatMap(([id, node]) => {
    const config = scheduleConfig(node);
    return config === undefined ? [] : [[id, config] as const];
  });
}

/** The first firing after `after` inside the period of the node. */
function nextFiring(config: ScheduleConfig, target: Target, after: Date): Date | undefined {
  const from = config.from === undefined ? undefined : new Date(Date.parse(config.from) - MINUTE);
  const next = parseCron(config.cron, target.timezone)?.next(from !== undefined && from > after ? from : after);
  return next === undefined || (config.until !== undefined && next.getTime() > Date.parse(config.until)) ? undefined : next;
}
