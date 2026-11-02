import { createHash } from "node:crypto";
import { durationMs, evaluateExpression, inputSpecOf, isTruthy, type Expr, type FormIssue, type InstanceData, type ProcessNode } from "../../../../library/workflow";
import { LOGGER } from "../../../kernel";
import type { ServiceProvider } from "../../../di";
import { isUuid, type WorkflowActor, type WorkflowRequest } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import { WorkflowInputValidator } from "../../contracts/WorkflowInputValidator";
import { WorkflowPartitions } from "../../contracts/WorkflowPartitions";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import { canonicalJson } from "../../internal/canonicalJson";
import type { WorkflowLanguages } from "../../internal/WorkflowLanguages";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfJob } from "../model/WfJob.model";
import type { EmitCause, EmitResult } from "../services/IWorkflowRuntime.service";
import type { WorkflowEngine } from "./WorkflowEngine";

/** An event on its way: what `emit` got, with the defaults in place. */
export interface EventMessage {
  readonly eventKey: string;
  readonly payload: Record<string, unknown>;
  readonly correlation: string | null;
  readonly partition: string | null;
  readonly actor: WorkflowActor;
  readonly request: WorkflowRequest | null;
  readonly cause: EmitCause | null;
}

interface EventStartConfig {
  readonly filter?: Expr;
  readonly debounce?: { readonly key: Expr; readonly window: string };
  readonly delay?: string;
  readonly ignoreOwn?: boolean;
}

/** A process the event is to start, with its checked input. */
interface PlannedStart {
  readonly version: VersionDetails;
  readonly nodeId: string;
  readonly config: EventStartConfig;
  readonly input: Record<string, unknown>;
}

/**
 * Takes an event to whoever waits for it and to the processes it starts
 * (WORKFLOW-002 §5.1, §5.2). An `event` job (`emitLater`) turns into an
 * `eventStart` job per process in one transaction, and each of those starts its
 * instance in one transaction with its own removal: a repeat after a crash starts
 * nothing twice. Waits are safe as they are: a subscription leaves with its step.
 */
export class EventDelivery {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
    private readonly languages: WorkflowLanguages,
    /** The scope: the application's own ports replace the defaults. */
    private readonly services: ServiceProvider,
  ) {}

  /** Moves the waits and starts the processes, now or, under `debounce` and `delay`, by a job. */
  async emit(message: EventMessage): Promise<EmitResult> {
    const continued = await this.continueWaits(message);
    const { planned, rejected } = await this.plan(message);
    const started: string[] = [];
    const skipped: { processKey: string; instanceId: string }[] = [];
    const deferred: { processKey: string }[] = [];
    for (const start of planned) {
      if (start.config.debounce !== undefined || start.config.delay !== undefined) {
        await this.defer(start, message);
        deferred.push({ processKey: start.version.key });
        continue;
      }
      const begun = await this.begin(start.version, start.nodeId, start.input, message);
      if (begun.skipped) skipped.push({ processKey: start.version.key, instanceId: begun.id });
      else started.push(begun.id);
    }
    return { started, skipped, deferred, continued, rejected };
  }

  /** An `event` job: the waits move, and the job becomes an `eventStart` job per process it starts. */
  async deliverLater(job: WfJob): Promise<void> {
    const message = job.payload as EventMessage;
    await this.continueWaits(message);
    const { planned, rejected } = await this.plan(message);
    for (const { processKey, issues } of rejected) this.services.tryResolve(LOGGER)?.warn("workflow event did not start a process", { event: message.eventKey, processKey, issues });
    await this.db.transactionScope(async () => {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      for (const start of planned) await this.defer(start, message);
    });
  }

  /** An `eventStart` job: its instance starts together with the removal of the job. An archived process takes nothing. */
  async startLater(job: WfJob): Promise<void> {
    const { message, input } = job.payload as { readonly message: EventMessage; readonly input: Record<string, unknown> };
    const version = job.versionId === null ? undefined : await this.definitions.versionById(job.versionId);
    if (version === undefined || job.nodeId === null || !await this.available(version.key)) {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      return;
    }
    const graph = this.engine.cache(version);
    await this.db.transactionScope(async () => {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      await this.engine.begin(graph, job.nodeId!, this.beginOptions(input, message));
    });
  }

  private async available(processKey: string): Promise<boolean> {
    try {
      await this.definitions.latest(processKey);
      return true;
    } catch (error) {
      if (error instanceof WorkflowError) return false;
      throw error;
    }
  }

  /** Every wait of the event: `eventWait.until` may leave a step waiting. */
  private async continueWaits(message: EventMessage): Promise<string[]> {
    const { eventKey, correlation, partition, payload } = message;
    let waits = this.db.subscriptions.asNoTracking().where((s) => s.eventKey.eq(eventKey));
    waits = correlation === null ? waits.where((s) => s.correlation.isNull()) : waits.where((s) => s.correlation.isNull().or(s.correlation.eq(correlation)));
    if (partition !== null) waits = waits.where((s) => s.partition.eq(partition));
    const continued = new Set<string>();
    for (const wait of await waits.orderBy((s) => s.id).toList()) {
      const moved = await this.engine.inStep(wait.instanceId, async (step) => {
        if (!this.engine.eventAccepted(step, wait.tokenId, payload)) return false;
        await this.db.subscriptions.asNoTracking().where((s) => s.id.eq(wait.id)).executeDelete();
        return await this.engine.eventReceived(step, wait.tokenId, eventKey, payload);
      });
      if (moved === true) continued.add(wait.instanceId);
    }
    return [...continued];
  }

  /** The `eventStart` nodes that take the event: connected to its partition, past `ignoreOwn` and `filter`, with a valid input. */
  private async plan(message: EventMessage): Promise<{ readonly planned: PlannedStart[]; readonly rejected: { processKey: string; issues: readonly FormIssue[] }[] }> {
    const { eventKey, payload, partition, actor } = message;
    const planned: PlannedStart[] = [];
    const rejected: { processKey: string; issues: readonly FormIssue[] }[] = [];
    const data = eventData(message, this.engine.now());
    const own = await this.causeProcess(message.cause);
    for (const version of await this.definitions.published()) {
      for (const [nodeId, node] of Object.entries(version.document.nodes)) {
        if (node.kind !== "eventStart" || node.config?.event !== eventKey) continue;
        const config = eventStartConfig(node);
        if (!await this.connected(version.key, partition)) continue;
        if (config.ignoreOwn === true && own === version.key) continue;
        if (config.filter !== undefined && !isTruthy(evaluateExpression(config.filter, data))) continue;
        // An event carries more than a process needs: fields the input does not declare are dropped, not refused.
        const { value, issues: all } = await this.services.resolve(WorkflowInputValidator).validate(inputSpecOf(version.document), payload, { purpose: "input", processKey: version.key, partition, language: this.languages.default, actor });
        const issues = all.filter((issue) => issue.code !== "unknown");
        if (issues.length > 0) rejected.push({ processKey: version.key, issues });
        else planned.push({ version, nodeId, config, input: value });
      }
    }
    return { planned, rejected };
  }

  /** Whether the process works in the partition of the event; an event without a partition is for processes without them. */
  private async connected(processKey: string, partition: string | null): Promise<boolean> {
    const partitions = await this.services.resolve(WorkflowPartitions).of(processKey, { partition, language: this.languages.default, actor: null });
    return partitions.some((item) => item.enabled && item.partition === partition);
  }

  /** The process of the instance that caused the event. */
  private async causeProcess(cause: EmitCause | null): Promise<string | undefined> {
    const id = cause?.instanceId;
    if (!isUuid(id)) return undefined;
    const row = await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(id));
    return row?.processKey;
  }

  private async begin(version: VersionDetails, nodeId: string, input: Record<string, unknown>, message: EventMessage) {
    return await this.engine.begin(this.engine.cache(version), nodeId, this.beginOptions(input, message));
  }

  private beginOptions(input: Record<string, unknown>, message: EventMessage) {
    return {
      input,
      partition: message.partition,
      businessKey: message.correlation,
      startedVia: "event" as const,
      actor: message.actor,
      request: message.request,
      event: { key: message.eventKey, payload: message.payload },
      ...(message.cause === null ? {} : { cause: message.cause }),
    };
  }

  /**
   * An `eventStart` job due after `delay` and the `debounce` window. The window runs
   * from its first event and later ones replace what the job carries, so a steady
   * stream of events still starts a process once per window. A job a worker holds
   * takes no more events: the next one opens a new window.
   */
  private async defer(start: PlannedStart, message: EventMessage): Promise<void> {
    const { version, nodeId, config, input } = start;
    const now = this.engine.now();
    const dueAt = new Date(now.getTime() + (config.debounce === undefined ? 0 : durationMs(config.debounce.window) ?? 0) + (config.delay === undefined ? 0 : durationMs(config.delay) ?? 0));
    const payload = { message, input };
    const dedupeKey = config.debounce === undefined ? null : debounceKey(version.key, nodeId, message, config.debounce.key, now);
    const job = Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "eventStart" as const, versionId: version.id, nodeId, partition: message.partition, dueAt, payload, dedupeKey, createdAt: now });
    if (dedupeKey === null) {
      await this.db.jobs.insertIfAbsent(job, { conflictBy: (j) => [j.id] });
      return;
    }
    await this.db.transactionScope(async () => {
      await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext({0}))", dedupeKey);
      const merged = await this.db.jobs.asNoTracking().where((j) => j.dedupeKey.eq(dedupeKey).and(j.lockedUntil.isNull())).executeUpdate({ payload, versionId: version.id });
      if (merged.affectedRows === 0) await this.db.jobs.insertIfAbsent(job, { conflictBy: (j) => [j.id] });
    });
  }
}

function eventStartConfig(node: ProcessNode): EventStartConfig {
  return (node.config ?? {}) as unknown as EventStartConfig;
}

/** What the expressions of an `eventStart` read: there is no instance yet. */
function eventData(message: EventMessage, now: Date): InstanceData {
  return {
    input: {},
    vars: {},
    nodes: {},
    event: message.payload,
    trigger: { via: "event", at: now.toISOString(), actor: message.actor, eventKey: message.eventKey, ...(message.cause === null ? {} : { cause: message.cause }) },
    now: now.toISOString(),
  };
}

function debounceKey(processKey: string, nodeId: string, message: EventMessage, key: Expr, now: Date): string {
  const value = evaluateExpression(key, eventData(message, now)) ?? null;
  return createHash("sha256").update(canonicalJson([processKey, nodeId, message.partition, value])).digest("hex");
}
