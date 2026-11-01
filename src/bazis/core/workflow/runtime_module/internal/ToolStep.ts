import type { AgentToolResult } from "../../../agent";
import { durationMs, resolveInput } from "../../../../library/workflow";
import type { WorkflowToolMetadata } from "../../contracts/types";
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
        metadata: { instanceId: instance.id, processKey: instance.processKey, nodeId: token.nodeId, partition: instance.partition, test: false } satisfies WorkflowToolMetadata,
        signal,
      });

    const reason = reasonOf(result);
    await this.engine.inStep(instance.id, async (step) => {
      const current = step.tokens.find((t) => t.id === token.id);
      const retryAt = current?.status === "waiting" && step.instance.status === "running" && result.status === "error" && reason === undefined
        ? nextAttempt(node?.config?.retry, job.attempts, this.engine.now())
        : undefined;
      if (retryAt !== undefined) {
        // The same job runs again later: its attempts keep counting.
        await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ dueAt: retryAt, lockedUntil: null, lastError: result.error?.message ?? null });
      } else {
        await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeDelete();
      }
      if (!current || current.status !== "waiting" || step.instance.status !== "running") return;
      this.engine.history(step, current, current.nodeId, "tool", {
        tool: name,
        status: result.status,
        attempt: job.attempts,
        durationMs: result.durationMs ?? null,
        ...(result.error ? { error: { code: result.error.code ?? null, message: result.error.message, ...(reason === undefined ? {} : { reason }) } } : {}),
        ...(retryAt === undefined ? {} : { retryAt: retryAt.toISOString() }),
      });
      if (retryAt !== undefined) return;
      if (result.status === "success") {
        await this.engine.complete(step, current.id, result.output ?? null);
      } else {
        await this.engine.failStep(step, current, {
          code: result.error?.code ?? "TOOL_FAILED",
          message: result.error?.message ?? `Tool ${name} failed`,
          ...(reason === undefined ? {} : { reason }),
        });
      }
    });
  }
}

/** The business reason of a `ToolError`, if the Tool gave one. */
function reasonOf(result: AgentToolResult): string | undefined {
  const details = result.error?.details;
  const reason = typeof details === "object" && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>).reason : undefined;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * When to try a failed call again under the node's `retry` policy, or
 * `undefined` when the attempts are used up. The pause doubles from `backoff`
 * (10 seconds by default) and stops growing at a day.
 */
export function nextAttempt(policy: unknown, attempts: number, now: Date): Date | undefined {
  if (typeof policy !== "object" || policy === null) return undefined;
  const { maxAttempts, backoff } = policy as { maxAttempts?: unknown; backoff?: unknown };
  if (typeof maxAttempts !== "number" || attempts >= maxAttempts) return undefined;
  const base = typeof backoff === "string" ? durationMs(backoff) ?? 10_000 : 10_000;
  return new Date(now.getTime() + Math.min(base * 2 ** Math.max(attempts - 1, 0), 86_400_000));
}
