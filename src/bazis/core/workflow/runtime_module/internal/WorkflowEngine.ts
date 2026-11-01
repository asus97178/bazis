import type { EventToken } from "../../../kernel";
import { durationMs, evaluateCondition, nodeKindOf, readPath, type FormSpec, type InstanceData, type ProcessFlow, type ProcessNode } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";
import type { WorkflowClock } from "../../contracts/WorkflowClock";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { WorkflowEvents } from "../../internal/WorkflowEvents";
import { WORKFLOW_INSTANCE_CANCELLED, WORKFLOW_INSTANCE_FINISHED, WORKFLOW_INSTANCE_RETRIED, WORKFLOW_INSTANCE_STARTED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED } from "../events/Runtime.events";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfHistory, type HistoryType } from "../model/WfHistory.model";
import { WfInstance, type StartedVia } from "../model/WfInstance.model";
import { WfJob } from "../model/WfJob.model";
import { WfSubscription } from "../model/WfSubscription.model";
import { WfToken } from "../model/WfToken.model";
import { buildGraph, type GraphCache, type ProcessGraph } from "./GraphCache";

/** An event to publish once the step has committed. */
interface PendingEvent {
  readonly event: EventToken<unknown>;
  readonly payload: unknown;
}

/**
 * The state of an instance for one step: its row under `FOR UPDATE`, its live
 * tokens and the version graph, plus the events to publish after the commit.
 */
export interface Step {
  readonly instance: WfInstance;
  readonly tokens: WfToken[];
  readonly graph: ProcessGraph;
  readonly events: PendingEvent[];
}

export interface BeginOptions {
  readonly input: Record<string, unknown>;
  readonly partition: string | null;
  readonly businessKey: string | null;
  readonly startedVia: StartedVia;
  readonly actor: WorkflowActor;
  /** Where the start came from; `null` for code, schedules and the worker. */
  readonly request?: WorkflowRequest | null;
}

const LIVE = new Set(["active", "waiting", "failed"]);

/**
 * Moves tokens along the graph up to the steps that wait (a Tool, a task, a
 * join) and finishes the instance when no live token is left. No state lives in
 * memory: every change is one transaction holding the instance row
 * ({@link inStep}), so a restart or a second application instance loses nothing.
 */
export class WorkflowEngine {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly definitions: IWorkflowDefinitions,
    private readonly graphs: GraphCache,
    private readonly events: WorkflowEvents,
    private readonly clock: WorkflowClock,
  ) {}

  /** The engine's time ({@link WorkflowClock}). */
  now(): Date {
    return this.clock.now();
  }

  /** The graph of a version. Versions are immutable, so graphs are cached. */
  async graphOf(versionId: string): Promise<ProcessGraph> {
    const cached = this.graphs.get(versionId);
    if (cached) return cached;
    const version = await this.definitions.versionById(versionId);
    if (!version) throw new Error(`workflow version ${versionId} does not exist`);
    return this.cache(version);
  }

  cache(version: VersionDetails): ProcessGraph {
    const graph = buildGraph(version.id, version.key, version.version, version.document);
    this.graphs.set(graph);
    return graph;
  }

  /** Creates an instance of `graph` and moves its token from `startNodeId`. */
  async begin(graph: ProcessGraph, startNodeId: string, options: BeginOptions): Promise<string> {
    const instance = Object.assign(new WfInstance(), {
      id: Bun.randomUUIDv7(),
      versionId: graph.versionId,
      processKey: graph.processKey,
      version: graph.version,
      partition: options.partition,
      input: options.input,
      businessKey: options.businessKey,
      startedVia: options.startedVia,
      startedByKind: options.actor.kind,
      startedById: options.actor.id,
    });
    await this.db.transactionScope(async (transaction) => {
      this.db.instances.add(instance);
      await this.db.saveChanges();
      const step: Step = { instance, tokens: [], graph, events: [] };
      this.history(step, null, null, "started", { via: options.startedVia }, options.actor);
      step.events.push({
        event: WORKFLOW_INSTANCE_STARTED as EventToken<unknown>,
        payload: { instanceId: instance.id, processKey: graph.processKey, version: graph.version, partition: options.partition, businessKey: options.businessKey, startedVia: options.startedVia, actor: options.actor, request: options.request ?? null },
      });
      await this.advance(step, [this.spawn(step, startNodeId, null)]);
      await this.db.saveChanges();
      this.publishAfter(transaction, step);
    });
    return instance.id;
  }

  /**
   * Runs `work` in a transaction holding the instance row and saves every
   * change. `null` when the instance does not exist.
   */
  async inStep<T>(instanceId: string, work: (step: Step) => Promise<T>): Promise<T | null> {
    // The graph is read before the transaction: versions are immutable and live in the Definitions store.
    const head = await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(instanceId));
    if (!head) return null;
    const graph = await this.graphOf(head.versionId);
    return await this.db.transactionScope(async (transaction) => {
      const instance = await this.db.instances.where((i) => i.id.eq(instanceId)).forUpdate().firstOrDefault();
      if (!instance) return null;
      const tokens = await this.db.tokens.where((t) => t.instanceId.eq(instanceId).and(t.status.in(["active", "waiting", "failed"]))).toList();
      const step: Step = { instance, tokens, graph, events: [] };
      const result = await work(step);
      await this.db.saveChanges();
      this.publishAfter(transaction, step);
      return result;
    });
  }

  /**
   * A waiting step (a Tool, a task) is done: its result goes to `$nodes.<node>`
   * and to the `saveTo` variable, the token moves on. `false` when the token no
   * longer waits (cancelled, the instance failed or finished).
   */
  async complete(step: Step, tokenId: string, output: unknown, actor?: WorkflowActor): Promise<boolean> {
    const token = step.tokens.find((t) => t.id === tokenId);
    if (!token || token.status !== "waiting" || step.instance.status !== "running") return false;
    const node = step.graph.document.nodes[token.nodeId]!;
    token.output = output ?? null;
    step.instance.nodes = { ...step.instance.nodes, [token.nodeId]: output ?? null };
    const saveTo = node.config?.saveTo;
    if (typeof saveTo === "string") step.instance.vars = { ...step.instance.vars, [saveTo]: output ?? null };
    if (actor !== undefined) this.history(step, token, token.nodeId, "completed", null, actor);
    this.disarm(step, token.nodeId);
    await this.advance(step, this.leave(step, token, this.single(step, token.nodeId)));
    return true;
  }

  /**
   * A step's Tool failed for good. An error boundary attached to the step takes
   * the token (first one whose `errorCode` equals the Tool's `reason` or error
   * code, else one without `errorCode`); otherwise the instance fails.
   */
  async failStep(step: Step, token: WfToken, error: { readonly code: string; readonly message: string; readonly reason?: string }): Promise<void> {
    const boundaries = (step.graph.boundaries.get(token.nodeId) ?? []).filter(([, node]) => node.kind === "boundaryError");
    const matching = boundaries.find(([, node]) => node.config?.errorCode !== undefined && (node.config.errorCode === error.reason || node.config.errorCode === error.code))
      ?? boundaries.find(([, node]) => node.config?.errorCode === undefined);
    if (!matching) {
      this.fail(step, token, error.code, error.message);
      return;
    }
    const [boundaryId] = matching;
    const caught = { code: error.code, message: error.message, ...(error.reason === undefined ? {} : { reason: error.reason }) };
    token.output = { error: caught };
    this.close(token, "done");
    this.disarm(step, token.nodeId);
    this.history(step, token, token.nodeId, "error", { ...caught, boundary: boundaryId });
    step.instance.nodes = { ...step.instance.nodes, [boundaryId]: caught };
    await this.advance(step, [this.spawn(step, boundaryId, null)]);
  }

  /**
   * A timer job is due. A `timerCatch` step moves on. A `boundaryTimer` takes
   * its own flow; an interrupting one (the default) first closes the step it
   * watches. `false` when the token no longer waits.
   */
  async timerFired(step: Step, tokenId: string): Promise<boolean> {
    const token = step.tokens.find((t) => t.id === tokenId);
    if (!token || token.status !== "waiting" || step.instance.status !== "running") return false;
    const node = step.graph.document.nodes[token.nodeId];
    const firedAt = this.now().toISOString();
    if (node?.kind === "timerCatch") {
      this.history(step, token, token.nodeId, "timer", { firedAt });
      return await this.complete(step, tokenId, { firedAt });
    }
    if (node?.kind !== "boundaryTimer") return false;
    return await this.fireBoundary(step, token, node, { firedAt }, "timer");
  }

  /**
   * An event the token waits for arrived. An `eventWait` step moves on with
   * the payload (and `saveTo`); a `boundaryEvent` takes its flow like a
   * boundary timer. `false` when the token no longer waits.
   */
  async eventReceived(step: Step, tokenId: string, eventKey: string, payload: Record<string, unknown>): Promise<boolean> {
    const token = step.tokens.find((t) => t.id === tokenId);
    if (!token || token.status !== "waiting" || step.instance.status !== "running") return false;
    const node = step.graph.document.nodes[token.nodeId];
    if (node?.kind === "eventWait") {
      this.history(step, token, token.nodeId, "event", { event: eventKey });
      return await this.complete(step, tokenId, payload);
    }
    if (node?.kind !== "boundaryEvent") return false;
    return await this.fireBoundary(step, token, node, payload, "event", { event: eventKey });
  }

  /** A boundary timer or event fired: an interrupting one closes the watched step first, then the boundary takes its flow. */
  private async fireBoundary(step: Step, token: WfToken, node: ProcessNode, output: Record<string, unknown>, type: "timer" | "event", details: Record<string, unknown> = {}): Promise<boolean> {
    if (node.attachedTo === undefined) return false;
    const interrupting = node.config?.interrupting !== false;
    this.history(step, token, token.nodeId, type, { ...details, ...(type === "timer" ? output : {}), interrupting });
    if (interrupting) {
      for (const host of step.tokens.filter((t) => t.nodeId === node.attachedTo && LIVE.has(t.status))) {
        this.close(host, "cancelled");
        if (step.graph.document.nodes[host.nodeId]?.kind === "userTask") {
          step.events.push({ event: WORKFLOW_TOKEN_CLOSED as EventToken<unknown>, payload: { instanceId: step.instance.id, tokenId: host.id, reason: "interrupted" } });
        }
      }
      this.disarm(step, node.attachedTo, token.id);
    }
    step.instance.nodes = { ...step.instance.nodes, [token.nodeId]: output };
    await this.advance(step, this.leave(step, token, this.single(step, token.nodeId)));
    return true;
  }

  /** A step failed: the token waits for a retry, the instance is `failed` with the reason. */
  fail(step: Step, token: WfToken, code: string, message: string): void {
    this.disarm(step, token.nodeId);
    token.status = "failed";
    step.instance.status = "failed";
    step.instance.error = { node: token.nodeId, code, message };
    this.history(step, token, token.nodeId, "error", { code, message });
  }

  /** Retries the failed steps: their tokens are back on their nodes and the instance runs again. */
  async retry(step: Step, actor: WorkflowActor, request: WorkflowRequest | null = null): Promise<void> {
    const failed = step.tokens.filter((t) => t.status === "failed");
    step.events.push({
      event: WORKFLOW_INSTANCE_RETRIED as EventToken<unknown>,
      payload: { instanceId: step.instance.id, processKey: step.instance.processKey, partition: step.instance.partition, actor, request },
    });
    step.instance.status = "running";
    step.instance.error = null;
    for (const token of failed) {
      token.status = "active";
      this.history(step, token, token.nodeId, "retried", null, actor);
    }
    await this.advance(step, failed);
  }

  /** Closes every live token, job and subscription; the application drops the tasks on `WORKFLOW_TOKEN_CLOSED`. */
  async cancel(step: Step, reason: string | null, actor: WorkflowActor, request: WorkflowRequest | null = null): Promise<void> {
    const open = step.tokens.filter((t) => LIVE.has(t.status));
    step.events.push({
      event: WORKFLOW_INSTANCE_CANCELLED as EventToken<unknown>,
      payload: { instanceId: step.instance.id, processKey: step.instance.processKey, partition: step.instance.partition, reason, actor, request },
    });
    for (const token of open) {
      token.status = "cancelled";
      token.endedAt = this.now();
    }
    await this.db.jobs.asNoTracking().where((j) => j.instanceId.eq(step.instance.id)).executeDelete();
    await this.db.subscriptions.asNoTracking().where((s) => s.instanceId.eq(step.instance.id)).executeDelete();
    step.instance.status = "cancelled";
    step.instance.endedAt = this.now();
    this.history(step, null, null, "cancelled", { reason }, actor);
    for (const token of open) {
      if (token.nodeId !== "" && step.graph.document.nodes[token.nodeId]?.kind === "userTask") {
        step.events.push({ event: WORKFLOW_TOKEN_CLOSED as EventToken<unknown>, payload: { instanceId: step.instance.id, tokenId: token.id, reason: "cancelled" } });
      }
    }
    this.finished(step, "cancelled");
  }

  /** Adds a history entry to the step. */
  history(step: Step, token: WfToken | null, nodeId: string | null, type: HistoryType, data: Record<string, unknown> | null, actor?: WorkflowActor): void {
    this.db.history.add(Object.assign(new WfHistory(), {
      id: Bun.randomUUIDv7(),
      instanceId: step.instance.id,
      tokenId: token?.id ?? null,
      nodeId,
      type,
      data,
      actorKind: actor?.kind ?? null,
      actorId: actor?.id ?? null,
    }));
  }

  /** Moves tokens until each waits or ends. */
  private async advance(step: Step, start: readonly WfToken[]): Promise<void> {
    const queue = [...start];
    while (queue.length > 0 && step.instance.status === "running") {
      const token = queue.shift()!;
      if (token.status !== "active") continue;
      queue.push(...this.enter(step, token));
    }
    if (step.instance.status === "running" && !step.tokens.some((t) => LIVE.has(t.status))) {
      step.instance.status = "completed";
      step.instance.endedAt = this.now();
      this.history(step, null, null, "completed", null);
      this.finished(step, "completed");
    }
  }

  /** The node under a token: returns the new tokens to move on. */
  private enter(step: Step, token: WfToken): WfToken[] {
    const node = step.graph.document.nodes[token.nodeId];
    if (!node) {
      this.fail(step, token, "unknown_node", `node ${token.nodeId} is not in the version`);
      return [];
    }
    const role = nodeKindOf(node.kind)?.role;
    if (role === "start") return this.leave(step, token, this.single(step, token.nodeId));
    if (role === "end") {
      this.close(token, "done");
      return [];
    }
    // An error boundary that caught a step's failure: it only leads on.
    if (role === "boundary") return this.leave(step, token, this.single(step, token.nodeId));
    switch (node.kind) {
      case "serviceTask":
        return this.arm(step, token, this.waitForTool(step, token));
      case "userTask":
        return this.arm(step, token, this.waitForTask(step, token, node));
      case "timerCatch":
        return this.arm(step, token, this.waitForTimer(step, token, node));
      case "eventWait":
        return this.arm(step, token, this.waitForEvent(step, token, node));
      case "exclusiveGateway":
        return this.choose(step, token);
      case "parallelGateway":
        return this.parallel(step, token);
      default:
        this.fail(step, token, "not_supported", `${node.kind} cannot be entered by a flow`);
        return [];
    }
  }

  private waitForTimer(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const dueAt = timerDue(node.config ?? {}, dataOf(step.instance), this.now());
    if (dueAt === undefined) {
      this.fail(step, token, "bad_timer", `the timer of ${token.nodeId} has no valid date`);
      return [];
    }
    token.status = "waiting";
    this.db.jobs.add(Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "timer" as const, instanceId: step.instance.id, tokenId: token.id, dueAt }));
    return [];
  }

  /**
   * A step started waiting: its boundary timers start too, each as a waiting
   * token on the boundary node with a timer job.
   */
  private arm(step: Step, host: WfToken, next: WfToken[]): WfToken[] {
    if (host.status !== "waiting") return next;
    for (const [id, node] of step.graph.boundaries.get(host.nodeId) ?? []) {
      if (node.kind === "boundaryEvent") {
        const correlation = correlationOf(node.config ?? {}, dataOf(step.instance));
        if (correlation === undefined) {
          this.fail(step, host, "bad_correlation", `the correlation of ${id} has no value`);
          return [];
        }
        const watcher = this.spawn(step, id, null);
        watcher.status = "waiting";
        this.subscribe(step, watcher, String(node.config?.event), correlation);
        continue;
      }
      if (node.kind !== "boundaryTimer") continue;
      const dueAt = timerDue(node.config ?? {}, dataOf(step.instance), this.now());
      if (dueAt === undefined) {
        this.fail(step, host, "bad_timer", `the timer of ${id} has no valid date`);
        return [];
      }
      const watcher = this.spawn(step, id, null);
      watcher.status = "waiting";
      this.db.jobs.add(Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "timer" as const, instanceId: step.instance.id, tokenId: watcher.id, dueAt }));
    }
    return next;
  }

  /** The step left or failed: its boundary tokens close; their jobs find the tokens closed and drop. */
  private disarm(step: Step, hostNodeId: string, except?: string): void {
    const boundaries = new Set((step.graph.boundaries.get(hostNodeId) ?? []).map(([id]) => id));
    if (boundaries.size === 0) return;
    for (const token of step.tokens) {
      if (token.id !== except && boundaries.has(token.nodeId) && LIVE.has(token.status)) this.close(token, "cancelled");
    }
  }

  private waitForEvent(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const correlation = correlationOf(node.config ?? {}, dataOf(step.instance));
    if (correlation === undefined) {
      this.fail(step, token, "bad_correlation", `the correlation of ${token.nodeId} has no value`);
      return [];
    }
    token.status = "waiting";
    this.subscribe(step, token, String(node.config?.event), correlation);
    return [];
  }

  private subscribe(step: Step, token: WfToken, eventKey: string, correlation: string | null): void {
    this.db.subscriptions.add(Object.assign(new WfSubscription(), {
      id: Bun.randomUUIDv7(),
      instanceId: step.instance.id,
      tokenId: token.id,
      eventKey,
      correlation,
      partition: step.instance.partition,
    }));
  }

  private waitForTool(step: Step, token: WfToken): WfToken[] {
    token.status = "waiting";
    this.db.jobs.add(Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "tool" as const, instanceId: step.instance.id, tokenId: token.id, dueAt: this.now() }));
    return [];
  }

  private waitForTask(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    token.status = "waiting";
    const config = node.config ?? {};
    const dueIn = typeof config.dueIn === "string" ? durationMs(config.dueIn) : undefined;
    step.events.push({
      event: WORKFLOW_TASK_REQUESTED as EventToken<unknown>,
      payload: {
        instanceId: step.instance.id,
        tokenId: token.id,
        processKey: step.instance.processKey,
        nodeId: token.nodeId,
        partition: step.instance.partition,
        title: node.title,
        assignee: config.assignee as { role: string } | { user: string },
        form: (config.form as FormSpec | undefined) ?? null,
        dueAt: dueIn === undefined ? null : new Date(this.now().getTime() + dueIn),
      },
    });
    return [];
  }

  /** An exclusive gateway: the first true flow in document order, else the default one. */
  private choose(step: Step, token: WfToken): WfToken[] {
    const flows = step.graph.outgoing.get(token.nodeId) ?? [];
    if (flows.length === 1) return this.leave(step, token, flows[0]!);
    const data = dataOf(step.instance);
    const chosen = flows.find(([, flow]) => flow.condition !== undefined && evaluateCondition(flow.condition, data))
      ?? flows.find(([, flow]) => flow.isDefault === true);
    if (!chosen) {
      this.fail(step, token, "no_branch", "no condition matched and there is no default flow");
      return [];
    }
    return this.leave(step, token, chosen);
  }

  /** A parallel gateway. A join waits for a token from every incoming flow and makes one; a split makes one per outgoing flow. */
  private parallel(step: Step, token: WfToken): WfToken[] {
    const inputs = step.graph.incoming.get(token.nodeId) ?? [];
    let current = token;
    if (inputs.length > 1) {
      token.status = "waiting";
      const arrived = new Map<string, WfToken>();
      for (const other of step.tokens) {
        if (other.nodeId === token.nodeId && other.status === "waiting" && other.viaFlowId !== null && !arrived.has(other.viaFlowId)) arrived.set(other.viaFlowId, other);
      }
      if (!inputs.every(([id]) => arrived.has(id))) return [];
      for (const joined of arrived.values()) this.close(joined, "done");
      current = this.spawn(step, token.nodeId, null);
    }
    const outputs = step.graph.outgoing.get(token.nodeId) ?? [];
    this.close(current, "done");
    this.history(step, current, current.nodeId, "left", { flows: outputs.map(([id]) => id) });
    return outputs.map(([id, flow]) => this.spawn(step, flow.target, id));
  }

  /** The single outgoing flow of a node; validation guarantees it exists. */
  private single(step: Step, nodeId: string): readonly [string, ProcessFlow] {
    const flows = step.graph.outgoing.get(nodeId) ?? [];
    if (flows.length !== 1) throw new Error(`node ${nodeId} must have exactly one outgoing flow`);
    return flows[0]!;
  }

  private leave(step: Step, token: WfToken, [flowId, flow]: readonly [string, ProcessFlow]): WfToken[] {
    this.close(token, "done");
    this.history(step, token, token.nodeId, "left", { flow: flowId });
    return [this.spawn(step, flow.target, flowId)];
  }

  private close(token: WfToken, status: "done" | "cancelled"): void {
    token.status = status;
    token.endedAt = this.now();
  }

  private spawn(step: Step, nodeId: string, viaFlowId: string | null): WfToken {
    const token = Object.assign(new WfToken(), { id: Bun.randomUUIDv7(), instanceId: step.instance.id, nodeId, viaFlowId, status: "active" as const });
    this.db.tokens.add(token);
    step.tokens.push(token);
    this.history(step, token, nodeId, "entered", viaFlowId ? { flow: viaFlowId } : null);
    return token;
  }

  private finished(step: Step, status: "completed" | "cancelled"): void {
    step.events.push({
      event: WORKFLOW_INSTANCE_FINISHED as EventToken<unknown>,
      payload: { instanceId: step.instance.id, processKey: step.instance.processKey, partition: step.instance.partition, status },
    });
  }

  /** Events go out after the commit, so a handler never sees a step that rolled back. */
  private publishAfter(transaction: { afterCommit(callback: () => void | Promise<void>): void }, step: Step): void {
    if (step.events.length === 0) return;
    const events = [...step.events];
    transaction.afterCommit(async () => {
      for (const { event, payload } of events) await this.events.publish(event, payload);
    });
  }
}

/** When a timer fires: `duration` from now, or the date at the `at` path; `undefined` if neither is valid. */
export function timerDue(config: Readonly<Record<string, unknown>>, data: InstanceData, now: Date): Date | undefined {
  if (typeof config.duration === "string") {
    const ms = durationMs(config.duration);
    return ms === undefined ? undefined : new Date(now.getTime() + ms);
  }
  if (typeof config.at === "string") {
    const value = readPath(data, config.at);
    const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : undefined;
    return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/**
 * The correlation a wait matches: the value at `config.correlation` as a
 * string, `null` without a path (any event of the key), `undefined` when the
 * path has no value.
 */
export function correlationOf(config: Readonly<Record<string, unknown>>, data: InstanceData): string | null | undefined {
  if (typeof config.correlation !== "string") return null;
  const value = readPath(data, config.correlation);
  return value === undefined || value === null || value === "" || typeof value === "object" ? undefined : String(value);
}

export function dataOf(instance: WfInstance): InstanceData {
  return { input: instance.input, vars: instance.vars, nodes: instance.nodes };
}
