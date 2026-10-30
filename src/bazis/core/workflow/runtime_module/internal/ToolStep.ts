import type { AgentToolResult } from "../../../agent";
import { resolveInput } from "../../../../library/workflow";
import type { WorkflowTools } from "../../internal/WorkflowTools";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import { dataOf, type WorkflowEngine } from "./WorkflowEngine";

/**
 * One `tool` job: call the service task's Tool and apply the result. The Tool
 * runs outside a transaction, the result is applied in a step transaction; a
 * token closed meanwhile (a cancel) drops it. The Tool runs on behalf of who
 * started the instance, with the token id as its idempotency key: after a crash
 * between the call and the step the call may repeat (TOOLS-001 §7).
 */
export class ToolStep {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly tools: WorkflowTools,
  ) {}

  async run(job: WfJob, signal: AbortSignal): Promise<void> {
    const instance = job.instanceId === null ? undefined : await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(job.instanceId!));
    const token = job.tokenId === null ? undefined : await this.db.tokens.asNoTracking().firstOrDefault((t) => t.id.eq(job.tokenId!));
    if (!instance || !token || instance.status !== "running" || token.status !== "waiting") {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      return;
    }
    const graph = await this.engine.graphOf(instance.versionId);
    const node = graph.document.nodes[token.nodeId];
    const name = String(node?.config?.tool ?? "");
    const input = resolveInput(node?.config?.input ?? {}, dataOf(instance));
    const runner = this.tools.bound;
    const result: AgentToolResult = runner === undefined
      ? { callId: token.id, name, status: "error", error: { code: "TOOL_NOT_FOUND", message: `Tool ${name} is not available to processes` }, metadata: {} } as AgentToolResult
      : await runner.run(name, input, {
        idempotencyKey: token.id,
        actor: { kind: instance.startedByKind, id: instance.startedById },
        metadata: { instanceId: instance.id, partition: instance.partition, processKey: instance.processKey, nodeId: token.nodeId },
        signal,
      });

    await this.engine.inStep(instance.id, async (step) => {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      const current = step.tokens.find((t) => t.id === token.id);
      if (!current || current.status !== "waiting" || step.instance.status !== "running") return;
      this.engine.history(step, current, current.nodeId, "tool", {
        tool: name,
        status: result.status,
        durationMs: result.durationMs ?? null,
        ...(result.error ? { error: { code: result.error.code ?? null, message: result.error.message } } : {}),
      });
      if (result.status === "success") {
        await this.engine.complete(step, current.id, result.output ?? null);
      } else {
        this.engine.fail(step, current, result.error?.code ?? "TOOL_FAILED", result.error?.message ?? `Tool ${name} failed`);
      }
    });
  }
}
