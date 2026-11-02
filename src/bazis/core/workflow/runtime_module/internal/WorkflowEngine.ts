import type { EventToken } from "../../../kernel";
import { durationMs, evaluateExpression, initialVarsOf, isTruthy, masksPersonal, maskByMapping, nodeKindOf, outputOf, personalPaths, personalVariables, PERSONAL_MASK, readPath, type Expr, type FormSpec, type InstanceData, type ProcessDocument, type ProcessFlow, type ProcessNode } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";
import type { WorkflowClock } from "../../contracts/WorkflowClock";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { WorkflowEvents } from "../../internal/WorkflowEvents";
import { WORKFLOW_INSTANCE_CANCELLED, WORKFLOW_INSTANCE_FINISHED, WORKFLOW_INSTANCE_RETRIED, WORKFLOW_INSTANCE_STARTED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED } from "../events/Runtime.events";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import { WfHistory, type HistoryType } from "../model/WfHistory.model";
import { WfInstance, type StartedVia } from "../model/WfInstance.model";
import { WfJob, type JobKind } from "../model/WfJob.model";
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
  /** Iterations of loops this step has begun: past {@link LOOP_BATCH} the rest go to a job. */
  iterations: number;
  /** Rows for the end of the step ({@link WorkflowEngine.flush}). */
  jobs: WfJob[];
  readonly subscriptions: WfSubscription[];
}

export interface BeginOptions {
  readonly input: Record<string, unknown>;
  readonly partition: string | null;
  readonly businessKey: string | null;
  readonly startedVia: StartedVia;
  readonly actor: WorkflowActor;
  /** Where the start came from; `null` for code, schedules and the worker. */
  readonly request?: WorkflowRequest | null;
  /** The event that starts it: `$event` and `$trigger.eventKey`. */
  readonly event?: { readonly key: string; readonly payload: unknown };
  /** The step of the instance that called it. */
  readonly parent?: { readonly instanceId: string; readonly tokenId: string; readonly depth: number };
  /** What led to the start: `$trigger.cause`. */
  readonly cause?: Readonly<Record<string, unknown>>;
}

/** Why a step failed. `reason` is the business reason an error boundary may name. */
export interface StepError {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
}

/** The result of {@link WorkflowEngine.begin}: the new instance, or with `skipped` the unfinished one that took its place (`sameKey: "skip"`). */
export interface Begun {
  readonly id: string;
  readonly skipped: boolean;
}

/** What a token inside a loop body sees besides the instance: its element and what steps of the iteration gave. */
interface Locals {
  readonly item: unknown;
  readonly index: number;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly nodes: Readonly<Record<string, unknown>>;
}

/** The progress of a running loop, in the `output` of its token. `items` is taken once: the body may change the list it came from. */
interface LoopState {
  readonly items: readonly unknown[] | null;
  readonly next: number;
  readonly skipped: number;
  readonly collected: Readonly<Record<string, unknown>>;
  /** The rest waits for a `loop` job. */
  readonly yielded: boolean;
}

interface LoopConfig {
  readonly over?: Expr;
  readonly while?: Expr;
  readonly times?: number;
  readonly item?: string;
  readonly index?: string;
  readonly maxIterations: number;
  readonly parallel?: { readonly limit: number };
  readonly onItemError?: "stop" | "skip";
  readonly collect?: { readonly from: Expr; readonly to: string };
}

/** Where a token runs: the loop and the iteration. Top-level tokens have neither. */
type Frame = Pick<WfToken, "parentTokenId" | "iteration" | "locals">;

const TOP: Frame = { parentTokenId: null, iteration: null, locals: null };

const LIVE = new Set(["active", "waiting", "failed"]);

/** How many iterations one transaction begins: a body without waits must not hold the instance for ten thousand of them. */
const LOOP_BATCH = 100;

/** Jobs that end with the instance. The others carry news of its end to someone else. */
const OWN_JOBS: readonly JobKind[] = ["tool", "timer", "loop", "call", "runTimeout"];

/** Whether two tokens are in one iteration: tokens of other iterations pass the same nodes and do not touch each other. */
function sameFrame(a: Frame, b: Frame): boolean {
  return a.parentTokenId === b.parentTokenId && a.iteration === b.iteration;
}

function localsOf(token: Frame): Locals | null {
  return token.locals as unknown as Locals | null;
}

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

  /**
   * Creates an instance of `graph` and moves its token from `startNodeId`, or
   * leaves it `pending` when `maxConcurrent` or `sameKey` tell it to wait. With
   * `sameKey: "skip"` no instance is created.
   */
  async begin(graph: ProcessGraph, startNodeId: string, options: BeginOptions): Promise<Begun> {
    return await this.db.transactionScope(async (transaction) => {
      const admission = await this.admit(graph, options.businessKey);
      if (typeof admission === "object") return { id: admission.skippedBy, skipped: true };
      const instance = this.newInstance(graph, options, admission === "queue" ? "pending" : "running");
      this.db.instances.add(instance);
      await this.db.saveChanges();
      const step = this.stepOf(instance, [], graph);
      this.history(step, null, null, "started", { via: options.startedVia }, options.actor);
      step.events.push({
        event: WORKFLOW_INSTANCE_STARTED as EventToken<unknown>,
        payload: { instanceId: instance.id, processKey: graph.processKey, version: graph.version, partition: options.partition, businessKey: options.businessKey, startedVia: options.startedVia, actor: options.actor, request: options.request ?? null },
      });
      const first = this.spawn(step, startNodeId, null, TOP);
      if (admission === "queue") {
        first.status = "waiting";
        this.history(step, first, startNodeId, "queued", null);
      } else {
        this.armRun(step);
        await this.advance(step, [first]);
      }
      await this.flush(step);
      this.publishAfter(transaction, step);
      return { id: instance.id, skipped: false };
    });
  }

  private stepOf(instance: WfInstance, tokens: WfToken[], graph: ProcessGraph): Step {
    return { instance, tokens, graph, events: [], iterations: 0, jobs: [], subscriptions: [] };
  }

  /**
   * Saves the step. Jobs and subscriptions are inserted past the change tracker:
   * they belong to the worker, and one scope may delete such rows directly in its
   * next step, which an ORM context that holds them would refuse.
   */
  private async flush(step: Step): Promise<void> {
    await this.db.saveChanges();
    for (const job of step.jobs) await this.db.jobs.insertIfAbsent(job, { conflictBy: (j) => [j.id] });
    for (const subscription of step.subscriptions) await this.db.subscriptions.insertIfAbsent(subscription, { conflictBy: (s) => [s.id] });
  }

  /** Whether a start goes ahead, under the lock of the process: only processes with a limit take it. */
  private async admit(graph: ProcessGraph, businessKey: string | null): Promise<"start" | "queue" | { readonly skippedBy: string }> {
    const { maxConcurrent, sameKey = "allow" } = graph.document.settings ?? {};
    const keyed = sameKey !== "allow" && businessKey !== null;
    if (maxConcurrent === undefined && !keyed) return "start";
    await this.lockProcess(graph.processKey);
    if (keyed) {
      const same = await this.db.instances.asNoTracking()
        .where((i) => i.processKey.eq(graph.processKey).and(i.businessKey.eq(businessKey)).and(i.status.in(["pending", "running", "failed"])))
        .firstOrDefault();
      if (same) return sameKey === "skip" ? { skippedBy: same.id } : "queue";
    }
    return maxConcurrent !== undefined && await this.runningOf(graph.processKey) >= maxConcurrent ? "queue" : "start";
  }

  /** One transaction at a time decides who of a process runs. Held until the commit. */
  async lockProcess(processKey: string): Promise<void> {
    await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext({0}))", `bazis.workflow.process:${processKey}`);
  }

  async runningOf(processKey: string): Promise<number> {
    return await this.db.instances.asNoTracking().where((i) => i.processKey.eq(processKey).and(i.status.eq("running"))).count();
  }

  /** A `pending` instance got its place: its token moves from the start. */
  async release(step: Step): Promise<void> {
    if (step.instance.status !== "pending") return;
    step.instance.status = "running";
    const first = step.tokens.filter((t) => t.status === "waiting");
    for (const token of first) {
      token.status = "active";
      this.history(step, token, token.nodeId, "released", null);
    }
    this.armRun(step);
    await this.advance(step, first);
  }

  private newInstance(graph: ProcessGraph, options: BeginOptions, status: "pending" | "running"): WfInstance {
    return Object.assign(new WfInstance(), {
      id: Bun.randomUUIDv7(),
      status,
      versionId: graph.versionId,
      processKey: graph.processKey,
      version: graph.version,
      partition: options.partition,
      input: options.input,
      vars: initialVarsOf(graph.document),
      event: options.event?.payload ?? null,
      trigger: {
        via: options.startedVia,
        at: this.now().toISOString(),
        actor: options.actor,
        ...(options.event === undefined ? {} : { eventKey: options.event.key }),
        ...(options.cause === undefined ? {} : { cause: options.cause }),
        ...(options.parent === undefined ? {} : { depth: options.parent.depth }),
      },
      businessKey: options.businessKey,
      startedVia: options.startedVia,
      startedByKind: options.actor.kind,
      startedById: options.actor.id,
      parentInstanceId: options.parent?.instanceId ?? null,
      parentTokenId: options.parent?.tokenId ?? null,
    });
  }

  /** A run with `runTimeout` has a job that ends it. */
  private armRun(step: Step, startedAt = this.now()): void {
    const timeout = step.graph.document.settings?.runTimeout;
    const ms = timeout === undefined ? undefined : durationMs(timeout);
    if (ms === undefined) return;
    this.addJob(step, "runTimeout", { dueAt: new Date(Math.max(startedAt.getTime() + ms, this.now().getTime())) });
  }

  private addJob(step: Step, kind: JobKind, fields: Partial<Pick<WfJob, "tokenId" | "dueAt" | "payload">> = {}): void {
    step.jobs.push(Object.assign(new WfJob(), { id: Bun.randomUUIDv7(), kind, instanceId: step.instance.id, dueAt: this.now(), createdAt: this.now(), ...fields }));
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
      const step = this.stepOf(instance, tokens, graph);
      const result = await work(step);
      await this.flush(step);
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
    if (actor !== undefined) this.history(step, token, token.nodeId, "completed", null, actor);
    await this.advance(step, this.finish(step, token, output));
    return true;
  }

  /** A step's result goes to `$nodes.<node>` and to `saveTo`; the token leaves. */
  private finish(step: Step, token: WfToken, output: unknown): WfToken[] {
    const node = step.graph.document.nodes[token.nodeId]!;
    token.output = output ?? null;
    this.record(step, token, token.nodeId, output ?? null);
    const saveTo = node.config?.saveTo;
    if (typeof saveTo === "string") this.save(step, token, saveTo, output ?? null);
    this.disarm(step, token);
    return this.leave(step, token, this.single(step, token.nodeId));
  }

  /** `$nodes.<node>`: inside a loop body it belongs to the iteration. */
  private record(step: Step, token: WfToken, nodeId: string, output: unknown): void {
    const locals = localsOf(token);
    if (locals === null) step.instance.nodes = { ...step.instance.nodes, [nodeId]: output };
    else token.locals = { ...locals, nodes: { ...locals.nodes, [nodeId]: output } };
  }

  /** `saveTo`: inside a loop body it belongs to the iteration, unless the process declares the variable. */
  private save(step: Step, token: WfToken, name: string, value: unknown): void {
    const locals = localsOf(token);
    if (locals === null || step.graph.document.variables?.some((variable) => variable.name === name)) step.instance.vars = { ...step.instance.vars, [name]: value };
    else token.locals = { ...locals, vars: { ...locals.vars, [name]: value } };
  }

  /**
   * A step failed for good: its Tool, or the process it called. An error boundary
   * attached to the step takes the token (first one whose `errorCode` equals the
   * `reason` or the error code, else one without `errorCode`); otherwise
   * `onError: "skip"` moves on with `{ skipped: true, error }`; otherwise it goes
   * to the loops around the step and then to the whole instance ({@link failed}).
   */
  async failStep(step: Step, token: WfToken, error: StepError): Promise<void> {
    const boundary = this.errorBoundary(step, token.nodeId, error);
    if (boundary) {
      await this.advance(step, this.caught(step, token, boundary, error));
      return;
    }
    const node = step.graph.document.nodes[token.nodeId];
    if (node?.config?.onError === "skip") {
      const skipped = detailsOf(error);
      this.history(step, token, token.nodeId, "skipped", skipped);
      if (node.kind === "callProcess") this.addJob(step, "cancelChildren", { payload: { tokenId: token.id, reason: "the caller skipped this step" } });
      await this.complete(step, token.id, { skipped: true, error: skipped });
      return;
    }
    await this.advance(step, this.failed(step, token, error));
  }

  private errorBoundary(step: Step, nodeId: string, error: StepError): readonly [string, ProcessNode] | undefined {
    const boundaries = (step.graph.boundaries.get(nodeId) ?? []).filter(([, node]) => node.kind === "boundaryError");
    return boundaries.find(([, node]) => node.config?.errorCode !== undefined && (node.config.errorCode === error.reason || node.config.errorCode === error.code))
      ?? boundaries.find(([, node]) => node.config?.errorCode === undefined);
  }

  /** An error boundary takes over from a step: what ran inside the step closes, the boundary leads on. */
  private caught(step: Step, token: WfToken, [boundaryId]: readonly [string, ProcessNode], error: StepError): WfToken[] {
    const details = detailsOf(error);
    for (const child of this.childrenOf(step, token)) this.closeTree(step, child, "interrupted");
    if (step.graph.document.nodes[token.nodeId]?.kind === "callProcess") this.addJob(step, "cancelChildren", { payload: { tokenId: token.id, reason: "the caller took over the error" } });
    token.output = { error: details };
    this.close(token, "done");
    this.disarm(step, token);
    this.history(step, token, token.nodeId, "error", { ...details, boundary: boundaryId });
    this.record(step, token, boundaryId, details);
    return [this.spawn(step, boundaryId, null, token)];
  }

  /**
   * A failure no step took: the loops around it have their say, from the inside
   * out (`onItemError: "skip"` drops the iteration, an error boundary on the loop
   * takes over). Otherwise the token waits for a retry and the instance is `failed`.
   */
  private failed(step: Step, token: WfToken, error: StepError): WfToken[] {
    for (let inner = token; inner.parentTokenId !== null;) {
      const loop = step.tokens.find((t) => t.id === inner.parentTokenId);
      if (!loop) break;
      if (step.graph.document.nodes[loop.nodeId]?.config?.onItemError === "skip") return this.skipIteration(step, loop, inner.iteration!, error);
      const boundary = this.errorBoundary(step, loop.nodeId, error);
      if (boundary) return this.caught(step, loop, boundary, error);
      inner = loop;
    }
    this.disarm(step, token);
    token.status = "failed";
    step.instance.status = "failed";
    step.instance.error = { node: token.nodeId, code: error.code, message: error.message };
    this.history(step, token, token.nodeId, "error", { code: error.code, message: error.message });
    this.stopped(step);
    return [];
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
    if (node?.kind === "eventWait" || node?.kind === "boundaryEvent") step.instance.event = payload;
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
      for (const host of step.tokens.filter((t) => t.nodeId === node.attachedTo && LIVE.has(t.status) && sameFrame(t, token))) this.closeTree(step, host, "interrupted");
      this.disarm(step, token, token.id, node.attachedTo);
    }
    this.record(step, token, token.nodeId, output);
    await this.advance(step, this.leave(step, token, this.single(step, token.nodeId)));
    return true;
  }

  /** A step failed outside its Tool: as {@link failStep} without the step's own handlers. */
  async fail(step: Step, token: WfToken, code: string, message: string): Promise<void> {
    await this.advance(step, this.failed(step, token, { code, message }));
  }

  /**
   * Retries the failed steps: their tokens are back on their nodes and the instance
   * runs again. What the failure left behind goes on too: tokens that had not moved,
   * and the jobs a worker dropped while the instance was stopped.
   */
  async retry(step: Step, actor: WorkflowActor, request: WorkflowRequest | null = null): Promise<void> {
    const failed = step.tokens.filter((t) => t.status === "failed");
    const left = step.tokens.filter((t) => t.status === "active");
    step.events.push({
      event: WORKFLOW_INSTANCE_RETRIED as EventToken<unknown>,
      payload: { instanceId: step.instance.id, processKey: step.instance.processKey, partition: step.instance.partition, actor, request },
    });
    step.instance.status = "running";
    step.instance.error = null;
    await this.rearm(step);
    for (const token of failed) {
      token.status = "active";
      this.history(step, token, token.nodeId, "retried", null, actor);
    }
    await this.advance(step, [...failed, ...left]);
  }

  private async rearm(step: Step): Promise<void> {
    const jobs = await this.db.jobs.asNoTracking().where((j) => j.instanceId.eq(step.instance.id)).toList();
    const held = new Set(jobs.map((job) => job.tokenId));
    for (const token of step.tokens) {
      if (token.status !== "waiting" || held.has(token.id)) continue;
      const kind = step.graph.document.nodes[token.nodeId]?.kind;
      if (kind === "serviceTask") this.addJob(step, "tool", { tokenId: token.id });
      else if (kind === "timerCatch" || kind === "boundaryTimer") this.addJob(step, "timer", { tokenId: token.id });
      else if (kind === "callProcess") this.addJob(step, "call", { tokenId: token.id });
      else if (kind === "loop" && (token.output as LoopState | null)?.yielded === true) this.addJob(step, "loop", { tokenId: token.id });
    }
    if (!jobs.some((job) => job.kind === "runTimeout")) this.armRun(step, new Date(String(step.instance.trigger?.at)));
  }

  /** Closes every live token, job and subscription; the application drops the tasks on `WORKFLOW_TOKEN_CLOSED`. */
  async cancel(step: Step, reason: string | null, actor: WorkflowActor, request: WorkflowRequest | null = null): Promise<void> {
    step.events.push({
      event: WORKFLOW_INSTANCE_CANCELLED as EventToken<unknown>,
      payload: { instanceId: step.instance.id, processKey: step.instance.processKey, partition: step.instance.partition, reason, actor, request },
    });
    await this.closeAll(step, "cancelled");
    step.instance.status = "cancelled";
    step.instance.endedAt = this.now();
    this.history(step, null, null, "cancelled", { reason }, actor);
    this.finished(step, "cancelled");
    this.stopped(step);
  }

  /** `runTimeout` passed: the run ends here, whatever it was waiting for. */
  async timeOut(step: Step): Promise<void> {
    const timeout = step.graph.document.settings?.runTimeout ?? "";
    await this.closeAll(step, "timedOut");
    step.instance.status = "timedOut";
    step.instance.endedAt = this.now();
    step.instance.error = { node: "", code: "run_timeout", message: `The run took longer than ${timeout}` };
    this.history(step, null, null, "timedOut", { timeout });
    this.finished(step, "timedOut");
    this.stopped(step);
  }

  private async closeAll(step: Step, reason: "cancelled" | "timedOut"): Promise<void> {
    for (const token of step.tokens.filter((t) => t.parentTokenId === null || !step.tokens.some((other) => other.id === t.parentTokenId))) {
      if (LIVE.has(token.status)) this.closeTree(step, token, reason);
    }
    await this.dropJobs(step, OWN_JOBS);
    await this.db.subscriptions.asNoTracking().where((s) => s.instanceId.eq(step.instance.id)).executeDelete();
  }

  /** Removes jobs of these kinds, saved and about to be. */
  private async dropJobs(step: Step, kinds: readonly JobKind[]): Promise<void> {
    step.jobs = step.jobs.filter((job) => !kinds.includes(job.kind));
    await this.db.jobs.asNoTracking().where((j) => j.instanceId.eq(step.instance.id).and(j.kind.in([...kinds]))).executeDelete();
  }

  /** The live tokens of a loop's body. */
  private childrenOf(step: Step, token: WfToken): WfToken[] {
    return step.tokens.filter((t) => t.parentTokenId === token.id && LIVE.has(t.status));
  }

  /** Closes a token with all that runs inside it: the body of a loop, a user task, a called process. */
  private closeTree(step: Step, token: WfToken, reason: "cancelled" | "interrupted" | "timedOut"): void {
    for (const child of this.childrenOf(step, token)) this.closeTree(step, child, reason);
    this.close(token, "cancelled");
    const kind = step.graph.document.nodes[token.nodeId]?.kind;
    if (kind === "userTask") step.events.push({ event: WORKFLOW_TOKEN_CLOSED as EventToken<unknown>, payload: { instanceId: step.instance.id, tokenId: token.id, reason } });
    if (kind === "callProcess") this.addJob(step, "cancelChildren", { payload: { tokenId: token.id, reason: `the caller was ${reason}` } });
  }

  /**
   * The instance stopped running: who waits for it hears of it. Each goes through a
   * job of this instance, so that its transaction never holds another instance's row.
   */
  private stopped(step: Step): void {
    const { instance, graph } = step;
    const settings = graph.document.settings;
    if (instance.parentInstanceId !== null) this.addJob(step, "returned", { payload: { parentInstanceId: instance.parentInstanceId, parentTokenId: instance.parentTokenId } });
    if (settings?.maxConcurrent !== undefined || settings?.sameKey === "queue") this.addJob(step, "release", { payload: { processKey: instance.processKey } });
    // A handler that fails does not start a handler: a chain of them would never end.
    if ((instance.status === "failed" || instance.status === "timedOut") && settings?.errorHandler !== undefined && instance.startedVia !== "errorHandler") {
      this.addJob(step, "errorHandler", { payload: { process: settings.errorHandler } });
    }
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
      step.instance.output = outputOf(step.graph.document, step.instance.vars);
      this.history(step, null, null, "completed", null);
      this.finished(step, "completed");
      if (step.graph.document.settings?.runTimeout !== undefined) await this.dropJobs(step, ["runTimeout"]);
      this.stopped(step);
    }
  }

  /** The node under a token: returns the new tokens to move on. */
  private enter(step: Step, token: WfToken): WfToken[] {
    const node = step.graph.document.nodes[token.nodeId];
    if (!node) return this.failed(step, token, { code: "unknown_node", message: `node ${token.nodeId} is not in the version` });
    const role = nodeKindOf(node.kind)?.role;
    if (role === "start") return this.leave(step, token, this.single(step, token.nodeId));
    if (role === "end") {
      this.close(token, "done");
      return token.parentTokenId === null ? [] : this.bodyEnded(step, token);
    }
    // An error boundary that caught a step's failure: it only leads on.
    if (role === "boundary") return this.leave(step, token, this.single(step, token.nodeId));
    switch (node.kind) {
      case "assign":
        return this.assign(step, token, node);
      case "loop":
        return this.enterLoop(step, token, node);
      case "callProcess":
        token.status = "waiting";
        this.addJob(step, "call", { tokenId: token.id, payload: { fresh: true } });
        return this.arm(step, token, []);
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
        return this.failed(step, token, { code: "not_supported", message: `${node.kind} cannot be entered by a flow` });
    }
  }

  /**
   * An `assign` step: each value sees the ones before it. The history names the
   * variables; their values go there only under `log.variables`, personal ones masked.
   */
  private assign(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const { document } = step.graph;
    const assignments = (node.config?.assignments ?? []) as readonly { readonly var: string; readonly value: Expr }[];
    const personal = masksPersonal(document) ? personalVariables(document) : new Set<string>();
    const reads = masksPersonal(document) ? personalPaths(document) : new Set<string>();
    const logged: Record<string, unknown> = {};
    for (const { var: name, value } of assignments) {
      const result = evaluateExpression(value, dataOf(step.instance, this.now(), token)) ?? null;
      step.instance.vars = { ...step.instance.vars, [name]: result };
      logged[name] = personal.has(name) ? PERSONAL_MASK : maskByMapping(value, result, reads);
    }
    const log = document.settings?.log?.variables === true;
    this.history(step, token, token.nodeId, "assigned", log ? { values: logged } : { vars: assignments.map((item) => item.var) });
    return this.leave(step, token, this.single(step, token.nodeId));
  }

  private waitForTimer(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const dueAt = timerDue(node.config ?? {}, dataOf(step.instance, this.now(), token), this.now());
    if (dueAt === undefined) return this.failed(step, token, { code: "bad_timer", message: `the timer of ${token.nodeId} has no valid date` });
    token.status = "waiting";
    this.addJob(step, "timer", { tokenId: token.id, dueAt });
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
        const correlation = correlationOf(node.config ?? {}, dataOf(step.instance, this.now(), host));
        if (correlation === undefined) return this.failed(step, host, { code: "bad_correlation", message: `the correlation of ${id} has no value` });
        const watcher = this.spawn(step, id, null, host);
        watcher.status = "waiting";
        this.subscribe(step, watcher, String(node.config?.event), correlation);
        continue;
      }
      if (node.kind !== "boundaryTimer") continue;
      const dueAt = timerDue(node.config ?? {}, dataOf(step.instance, this.now(), host), this.now());
      if (dueAt === undefined) return this.failed(step, host, { code: "bad_timer", message: `the timer of ${id} has no valid date` });
      const watcher = this.spawn(step, id, null, host);
      watcher.status = "waiting";
      this.addJob(step, "timer", { tokenId: watcher.id, dueAt });
    }
    return next;
  }

  /** The step left or failed: its boundary tokens close; their jobs find the tokens closed and drop. Tokens of other iterations stay. */
  private disarm(step: Step, host: WfToken, except?: string, hostNodeId = host.nodeId): void {
    const boundaries = new Set((step.graph.boundaries.get(hostNodeId) ?? []).map(([id]) => id));
    if (boundaries.size === 0) return;
    for (const token of step.tokens) {
      if (token.id !== except && boundaries.has(token.nodeId) && LIVE.has(token.status) && sameFrame(token, host)) this.close(token, "cancelled");
    }
  }

  private waitForEvent(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const correlation = correlationOf(node.config ?? {}, dataOf(step.instance, this.now(), token));
    if (correlation === undefined) return this.failed(step, token, { code: "bad_correlation", message: `the correlation of ${token.nodeId} has no value` });
    token.status = "waiting";
    this.subscribe(step, token, String(node.config?.event), correlation);
    return [];
  }

  private subscribe(step: Step, token: WfToken, eventKey: string, correlation: string | null): void {
    step.subscriptions.push(Object.assign(new WfSubscription(), {
      id: Bun.randomUUIDv7(),
      instanceId: step.instance.id,
      tokenId: token.id,
      eventKey,
      correlation,
      partition: step.instance.partition,
      createdAt: this.now(),
    }));
  }

  private waitForTool(step: Step, token: WfToken): WfToken[] {
    token.status = "waiting";
    this.addJob(step, "tool", { tokenId: token.id });
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
    const data = dataOf(step.instance, this.now(), token);
    const chosen = flows.find(([, flow]) => flow.condition !== undefined && isTruthy(evaluateExpression(flow.condition, data)))
      ?? flows.find(([, flow]) => flow.isDefault === true);
    if (!chosen) return this.failed(step, token, { code: "no_branch", message: "no condition matched and there is no default flow" });
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
        if (other.nodeId === token.nodeId && other.status === "waiting" && other.viaFlowId !== null && !arrived.has(other.viaFlowId) && sameFrame(other, token)) arrived.set(other.viaFlowId, other);
      }
      if (!inputs.every(([id]) => arrived.has(id))) return [];
      for (const joined of arrived.values()) this.close(joined, "done");
      // What the branches of an iteration gave meets here.
      current = this.spawn(step, token.nodeId, null, { ...token, locals: mergedLocals([...arrived.values()]) });
    }
    const outputs = step.graph.outgoing.get(token.nodeId) ?? [];
    this.close(current, "done");
    this.history(step, current, current.nodeId, "left", { flows: outputs.map(([id]) => id) });
    return outputs.map(([id, flow]) => this.spawn(step, flow.target, id, current));
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
    return [this.spawn(step, flow.target, flowId, token)];
  }

  /** A loop begins, or goes on after a retry: its token waits while the iterations run. */
  private enterLoop(step: Step, token: WfToken, node: ProcessNode): WfToken[] {
    const config = node.config as unknown as LoopConfig;
    if (!isLoopState(token.output)) {
      let items: readonly unknown[] | null = null;
      if (config.over !== undefined) {
        const value = evaluateExpression(config.over, dataOf(step.instance, this.now(), token)) ?? [];
        if (!Array.isArray(value)) return this.failed(step, token, { code: "loop_not_a_list", message: `over of ${token.nodeId} is not a list` });
        if (value.length > config.maxIterations) return this.failed(step, token, { code: "loop_limit", message: `${value.length} elements for ${token.nodeId}, maxIterations is ${config.maxIterations}` });
        items = value;
      }
      token.output = { items, next: 0, skipped: 0, collected: {}, yielded: false } satisfies LoopState;
    }
    token.status = "waiting";
    const armed = this.arm(step, token, []);
    return token.status === "waiting" ? this.iterate(step, token) : armed;
  }

  /** Begins iterations up to the loop's limit; when nothing is left to begin or to wait for, the loop leaves. */
  private iterate(step: Step, loop: WfToken): WfToken[] {
    const config = step.graph.document.nodes[loop.nodeId]!.config as unknown as LoopConfig;
    const state = loop.output as LoopState;
    if (state.yielded) return [];
    const entry = step.graph.entries.get(loop.nodeId)!;
    const outer = localsOf(loop);
    const frame = (index: number, item: unknown): Locals => ({
      item,
      index,
      vars: { ...outer?.vars, ...(config.item === undefined ? {} : { [config.item]: item }), ...(config.index === undefined ? {} : { [config.index]: index }) },
      nodes: outer?.nodes ?? {},
    });
    let running = new Set(this.childrenOf(step, loop).map((t) => t.iteration)).size;
    let next = state.next;
    const begun: WfToken[] = [];
    const save = (more: Partial<LoopState> = {}) => {
      loop.output = { ...state, next, ...more } satisfies LoopState;
    };
    while (running < (config.parallel?.limit ?? 1)) {
      const item = state.items?.[next] ?? null;
      const more = state.items !== null ? next < state.items.length
        : config.times !== undefined ? next < config.times
        : isTruthy(evaluateExpression(config.while!, dataOf(step.instance, this.now(), { locals: frame(next, null) as unknown as Frame["locals"] })));
      if (!more) break;
      if (next >= config.maxIterations) {
        save();
        return this.failed(step, loop, { code: "loop_limit", message: `${loop.nodeId} reached maxIterations: ${config.maxIterations}` });
      }
      if (step.iterations >= LOOP_BATCH) {
        save({ yielded: true });
        this.addJob(step, "loop", { tokenId: loop.id });
        return begun;
      }
      step.iterations += 1;
      const first = this.spawn(step, entry, null, { parentTokenId: loop.id, iteration: next, locals: frame(next, item) as unknown as Frame["locals"] });
      this.history(step, first, loop.nodeId, "iteration", { iteration: next });
      begun.push(first);
      next += 1;
      running += 1;
    }
    save();
    if (running > 0) return begun;
    const collect = config.collect;
    if (collect !== undefined) step.instance.vars = { ...step.instance.vars, [collect.to]: Object.keys(state.collected).sort((a, b) => Number(a) - Number(b)).map((key) => state.collected[key]) };
    return this.finish(step, loop, { iterations: next, skipped: state.skipped });
  }

  /** A `loop` job: the next batch of iterations. `false` when the loop no longer waits. */
  async continueLoop(step: Step, tokenId: string): Promise<boolean> {
    const loop = step.tokens.find((t) => t.id === tokenId);
    if (!loop || loop.status !== "waiting" || step.instance.status !== "running" || !isLoopState(loop.output)) return false;
    loop.output = { ...loop.output, yielded: false } satisfies LoopState;
    await this.advance(step, this.iterate(step, loop));
    return true;
  }

  /** A token of a body reached its end: when it is the last of the iteration, what the loop collects is taken and the next one begins. */
  private bodyEnded(step: Step, token: WfToken): WfToken[] {
    const loop = step.tokens.find((t) => t.id === token.parentTokenId && t.status === "waiting");
    if (!loop || step.tokens.some((t) => t.parentTokenId === loop.id && t.iteration === token.iteration && LIVE.has(t.status))) return [];
    const config = step.graph.document.nodes[loop.nodeId]!.config as unknown as LoopConfig;
    if (config.collect !== undefined) {
      const state = loop.output as LoopState;
      const value = evaluateExpression(config.collect.from, dataOf(step.instance, this.now(), token)) ?? null;
      loop.output = { ...state, collected: { ...state.collected, [String(token.iteration)]: value } } satisfies LoopState;
    }
    return this.iterate(step, loop);
  }

  /** `onItemError: "skip"`: what still runs in the iteration closes and the loop goes on without it. */
  private skipIteration(step: Step, loop: WfToken, iteration: number, error: StepError): WfToken[] {
    for (const token of this.childrenOf(step, loop)) {
      if (token.iteration === iteration) this.closeTree(step, token, "interrupted");
    }
    const state = loop.output as LoopState;
    loop.output = { ...state, skipped: state.skipped + 1 } satisfies LoopState;
    this.history(step, loop, loop.nodeId, "skipped", { iteration, ...detailsOf(error) });
    return this.iterate(step, loop);
  }

  private close(token: WfToken, status: "done" | "cancelled"): void {
    token.status = status;
    token.endedAt = this.now();
  }

  /** A new token in the frame of `from`: in the same iteration, it sees what `from` saw. */
  private spawn(step: Step, nodeId: string, viaFlowId: string | null, from: Frame): WfToken {
    const token = Object.assign(new WfToken(), { id: Bun.randomUUIDv7(), instanceId: step.instance.id, nodeId, viaFlowId, status: "active" as const, parentTokenId: from.parentTokenId, iteration: from.iteration, locals: from.locals });
    this.db.tokens.add(token);
    step.tokens.push(token);
    this.history(step, token, nodeId, "entered", viaFlowId ? { flow: viaFlowId } : null);
    return token;
  }

  private finished(step: Step, status: "completed" | "cancelled" | "timedOut"): void {
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

/** What expressions read in an instance at this moment of the engine's clock; inside a loop body, with what the iteration has. */
export function dataOf(instance: WfInstance, now: Date, token?: Pick<Frame, "locals">): InstanceData {
  const locals = token?.locals as unknown as Locals | null | undefined;
  return {
    input: instance.input,
    vars: locals ? { ...instance.vars, ...locals.vars } : instance.vars,
    nodes: locals ? { ...instance.nodes, ...locals.nodes } : instance.nodes,
    ...(locals ? { item: locals.item, index: locals.index } : {}),
    event: instance.event,
    trigger: instance.trigger,
    run: { id: instance.id, processKey: instance.processKey, version: instance.version, partition: instance.partition, test: instance.test },
    now: now.toISOString(),
  };
}

/** Who the steps of an instance act for: `settings.runAs`. */
export function runActorOf(document: ProcessDocument, instance: WfInstance): WorkflowActor {
  return document.settings?.runAs === "process" ? { kind: "system", id: `process:${instance.processKey}` } : { kind: instance.startedByKind, id: instance.startedById };
}

function isLoopState(value: unknown): value is LoopState {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "next") && Object.hasOwn(value, "collected");
}

function detailsOf(error: StepError): { code: string; message: string; reason?: string } {
  return { code: error.code, message: error.message, ...(error.reason === undefined ? {} : { reason: error.reason }) };
}

/** What several tokens of one iteration saw, together; the later token wins. */
function mergedLocals(tokens: readonly WfToken[]): WfToken["locals"] {
  const all = tokens.map(localsOf).filter((locals): locals is Locals => locals !== null);
  if (all.length === 0) return null;
  return {
    ...all[0]!,
    vars: Object.assign({}, ...all.map((locals) => locals.vars)),
    nodes: Object.assign({}, ...all.map((locals) => locals.nodes)),
  };
}
