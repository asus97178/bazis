import { inputSpecOf, resolveInput } from "../../../../library/workflow";
import type { ServiceProvider } from "../../../di";
import { WorkflowError } from "../../contracts/WorkflowError";
import { WorkflowInputValidator } from "../../contracts/WorkflowInputValidator";
import type { IWorkflowDefinitions, VersionDetails } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { WorkflowLanguages } from "../../internal/WorkflowLanguages";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfInstance } from "../model/WfInstance.model";
import type { WfJob } from "../model/WfJob.model";
import type { WfToken } from "../model/WfToken.model";
import { dataOf, runActorOf, type StepError, type WorkflowEngine } from "./WorkflowEngine";

/** How deep processes may call each other: a process that calls itself has to stop somewhere. */
const MAX_DEPTH = 16;

/**
 * `callProcess`: the jobs between a caller and the process it called. Each runs in
 * the transaction of one instance, so caller and child never wait for each other.
 * The child runs on behalf of the caller's actor, in its partition.
 */
export class ChildCalls {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
    /** The scope: the input validator is asked here, so that the application's own registration replaces the default. */
    private readonly services: ServiceProvider,
    private readonly languages: WorkflowLanguages,
  ) {}

  /**
   * A `call` job: the step starts its process. If it has called already (a retry, a
   * repeat after a crash), it goes on with that child: a failed one is retried, so
   * that its finished steps do not run twice. A cancelled or timed out one is called
   * anew only when the step was entered again (`fresh`).
   */
  async call(job: WfJob): Promise<void> {
    const instance = job.instanceId === null ? undefined : await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(job.instanceId!));
    const token = job.tokenId === null ? undefined : await this.db.tokens.asNoTracking().firstOrDefault((t) => t.id.eq(job.tokenId!));
    if (!instance || !token || instance.status !== "running" || token.status !== "waiting") {
      await this.dropJob(job);
      return;
    }
    const child = await this.lastChild(instance.id, token.id);
    if (child?.status === "running" || child?.status === "pending") {
      await this.dropJob(job);
      return;
    }
    if (child?.status === "failed") {
      const actor = runActorOf((await this.engine.graphOf(instance.versionId)).document, instance);
      await this.engine.inStep(child.id, async (step) => {
        await this.dropJob(job);
        if (step.instance.status === "failed") await this.engine.retry(step, actor);
      });
      return;
    }
    if (child?.status === "completed") {
      await this.engine.inStep(instance.id, async (step) => {
        await this.dropJob(job);
        await this.engine.complete(step, token.id, child.output ?? {});
      });
      return;
    }
    if (child && (job.payload as { fresh?: boolean } | null)?.fresh !== true) {
      await this.applyEnd(job, instance.id, token.id, child);
      return;
    }
    await this.start(job, instance, token);
  }

  private async start(job: WfJob, instance: WfInstance, token: WfToken): Promise<void> {
    const graph = await this.engine.graphOf(instance.versionId);
    const config = graph.document.nodes[token.nodeId]?.config ?? {};
    const key = String(config.process ?? "");
    const depth = (typeof instance.trigger?.depth === "number" ? instance.trigger.depth : 0) + 1;
    const actor = runActorOf(graph.document, instance);
    const refuse = (error: StepError) => this.engine.inStep(instance.id, async (step) => {
      await this.dropJob(job);
      const current = step.tokens.find((t) => t.id === token.id);
      if (current?.status === "waiting" && step.instance.status === "running") await this.engine.failStep(step, current, error);
    });
    if (depth > MAX_DEPTH) {
      await refuse({ code: "call_depth", message: `Processes call each other deeper than ${MAX_DEPTH} levels` });
      return;
    }
    let version: VersionDetails;
    try {
      version = await this.definitions.latest(key);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      await refuse({ code: "process_unavailable", message: error.message, reason: error.code });
      return;
    }
    const start = Object.entries(version.document.nodes).find(([, node]) => node.kind === "manualStart");
    if (!start) {
      await refuse({ code: "process_unavailable", message: `Process ${key} has no manual start` });
      return;
    }
    const input = resolveInput(config.input ?? {}, dataOf(instance, this.engine.now(), token));
    const { value, issues } = await this.services.resolve(WorkflowInputValidator).validate(inputSpecOf(version.document), input, { purpose: "input", processKey: key, partition: instance.partition, language: this.languages.default, actor });
    if (issues.length > 0) {
      await refuse({ code: "invalid_input", message: `The input of process ${key} is invalid: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}` });
      return;
    }
    const childGraph = this.engine.cache(version);
    await this.engine.inStep(instance.id, async (step) => {
      await this.dropJob(job);
      const current = step.tokens.find((t) => t.id === token.id);
      if (current?.status !== "waiting" || step.instance.status !== "running") return;
      const { id } = await this.engine.begin(childGraph, start[0], {
        input: value,
        partition: step.instance.partition,
        businessKey: null,
        startedVia: "callProcess",
        actor,
        parent: { instanceId: step.instance.id, tokenId: current.id, depth },
        cause: { instanceId: step.instance.id, processKey: step.instance.processKey, nodeId: current.nodeId },
      });
      this.engine.history(step, current, current.nodeId, "called", { process: key, version: version.version, instanceId: id });
    });
  }

  /** A `returned` job: a child stopped. If its caller no longer waits, the job drops; a caller that is itself stopped looks again on its retry. */
  async returned(job: WfJob): Promise<void> {
    const { parentInstanceId, parentTokenId } = job.payload as { parentInstanceId: string; parentTokenId: string };
    const child = job.instanceId === null ? undefined : await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(job.instanceId!));
    if (!child) {
      await this.dropJob(job);
      return;
    }
    await this.applyEnd(job, parentInstanceId, parentTokenId, child);
  }

  private async applyEnd(job: WfJob, instanceId: string, tokenId: string, child: WfInstance): Promise<void> {
    const done = await this.engine.inStep(instanceId, async (step) => {
      await this.dropJob(job);
      const token = step.tokens.find((t) => t.id === tokenId);
      if (token?.status !== "waiting" || step.instance.status !== "running") return;
      if (child.status === "completed") {
        this.engine.history(step, token, token.nodeId, "returned", { instanceId: child.id });
        await this.engine.complete(step, tokenId, child.output ?? {});
        return;
      }
      const error = errorOf(child);
      if (error) await this.engine.failStep(step, token, error);
    });
    if (done === null) await this.dropJob(job);
  }

  /** A `cancelChildren` job: the step that called is closed, so is what it called. */
  async cancelChildren(job: WfJob): Promise<void> {
    const { tokenId, reason } = job.payload as { tokenId: string; reason: string };
    const parent = job.instanceId === null ? undefined : await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(job.instanceId!));
    if (parent) {
      const children = await this.db.instances.asNoTracking()
        .where((i) => i.parentInstanceId.eq(parent.id).and(i.parentTokenId.eq(tokenId)).and(i.status.in(["pending", "running", "failed"])))
        .toList();
      const actor = { kind: "system" as const, id: `process:${parent.processKey}` };
      for (const child of children) {
        await this.engine.inStep(child.id, async (step) => {
          if (step.instance.status === "pending" || step.instance.status === "running" || step.instance.status === "failed") await this.engine.cancel(step, reason, actor);
        });
      }
    }
    await this.dropJob(job);
  }

  /** The newest child of a step. */
  private async lastChild(instanceId: string, tokenId: string): Promise<WfInstance | undefined> {
    const children = await this.db.instances.asNoTracking().where((i) => i.parentInstanceId.eq(instanceId).and(i.parentTokenId.eq(tokenId))).orderBy((i) => i.id).toList();
    return children.at(-1);
  }

  private async dropJob(job: WfJob): Promise<void> {
    await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
  }
}

/** The failure of a step whose child stopped otherwise than by completing; `undefined` while it runs again. */
function errorOf(child: WfInstance): StepError | undefined {
  const about = `Instance ${child.id} of process ${child.processKey}`;
  if (child.status === "failed") return { code: "child_failed", message: `${about} failed: ${child.error?.message ?? ""}`, ...(child.error ? { reason: child.error.code } : {}) };
  if (child.status === "cancelled") return { code: "child_cancelled", message: `${about} was cancelled` };
  if (child.status === "timedOut") return { code: "child_timed_out", message: `${about} took too long`, reason: "timeout" };
  return undefined;
}
