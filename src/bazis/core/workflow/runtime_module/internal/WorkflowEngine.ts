import type { ServiceResolver } from "../../../di";
import { EventBus, type EventToken, type Logger } from "../../../kernel";
import { durationMs, evaluateCondition, nodeKindOf, type FormSpec, type InstanceData, type ProcessFlow, type ProcessNode } from "../../../../library/workflow";
import type { WorkflowActor } from "../../contracts/types";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import { WORKFLOW_INSTANCE_FINISHED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED } from "../events/Runtime.events";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfHistory, type HistoryType } from "../model/WfHistory.model";
import { WfInstance, type StartedVia } from "../model/WfInstance.model";
import { WfJob } from "../model/WfJob.model";
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
}

/** Node kinds that come with later stages: an instance reaching one fails with a clear reason. */
const NOT_YET = new Set(["timerCatch", "eventWait"]);
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
    private readonly events: EventBus,
    private readonly scope: ServiceResolver,
    private readonly logger: Logger | undefined,
  ) {}

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
    await this.advance(step, this.leave(step, token, this.single(step, token.nodeId)));
    return true;
  }

  /** A step failed: the token waits for a retry, the instance is `failed` with the reason. */
  fail(step: Step, token: WfToken, code: string, message: string): void {
    token.status = "failed";
    step.instance.status = "failed";
    step.instance.error = { node: token.nodeId, code, message };
    this.history(step, token, token.nodeId, "error", { code, message });
  }

  /** Retries the failed steps: their tokens are back on their nodes and the instance runs again. */
  async retry(step: Step, actor: WorkflowActor): Promise<void> {
    const failed = step.tokens.filter((t) => t.status === "failed");
    step.instance.status = "running";
    step.instance.error = null;
    for (const token of failed) {
      token.status = "active";
      this.history(step, token, token.nodeId, "retried", null, actor);
    }
    await this.advance(step, failed);
  }

  /** Closes every live token, job and subscription; the application drops the tasks on `WORKFLOW_TOKEN_CLOSED`. */
  async cancel(step: Step, reason: string | null, actor: WorkflowActor): Promise<void> {
    const open = step.tokens.filter((t) => LIVE.has(t.status));
    for (const token of open) {
      token.status = "cancelled";
      token.endedAt = new Date();
    }
    await this.db.jobs.asNoTracking().where((j) => j.instanceId.eq(step.instance.id)).executeDelete();
    await this.db.subscriptions.asNoTracking().where((s) => s.instanceId.eq(step.instance.id)).executeDelete();
    step.instance.status = "cancelled";
    step.instance.endedAt = new Date();
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
      step.instance.endedAt = new Date();
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
    if (NOT_YET.has(node.kind)) {
      this.fail(step, token, "not_supported", `${node.kind} steps are not supported yet`);
      return [];
    }
    switch (node.kind) {
      case "serviceTask":
        return this.waitForTool(step, token);
      case "userTask":
        return this.waitForTask(step, token, node);
      case "exclusiveGateway":
        return this.choose(step, token);
      case "parallelGateway":
        return this.parallel(step, token);
      default:
        this.fail(step, token, "not_supported", `${node.kind} cannot be entered by a flow`);
        return [];
    }
  }

  private waitForTool(step: Step, token: WfToken): WfToken[] {
    token.status = "waiting";
    this.db.jobs.add(Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind: "tool" as const, instanceId: step.instance.id, tokenId: token.id, dueAt: new Date() }));
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
        dueAt: dueIn === undefined ? null : new Date(Date.now() + dueIn),
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
    token.endedAt = new Date();
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

  /**
   * Events go out after the commit, so a handler never sees a step that rolled
   * back. A failing handler is logged: the step is already saved.
   */
  private publishAfter(transaction: { afterCommit(callback: () => void | Promise<void>): void }, step: Step): void {
    if (step.events.length === 0) return;
    const events = [...step.events];
    transaction.afterCommit(async () => {
      for (const { event, payload } of events) {
        try {
          await this.events.publishScoped(this.scope, event, payload);
        } catch (error) {
          this.logger?.error("workflow event handler failed", { event: event.name, instance: step.instance.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  }
}

export function dataOf(instance: WfInstance): InstanceData {
  return { input: instance.input, vars: instance.vars, nodes: instance.nodes };
}
