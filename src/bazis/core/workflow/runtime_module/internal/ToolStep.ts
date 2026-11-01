import type { AgentSchemaContract, AgentToolResult } from "../../../agent";
import { durationMs, maskByMapping, maskBySchema, masksPersonal, personalPaths, resolveInput, type ProcessDocument } from "../../../../library/workflow";
import type { WorkflowToolMetadata } from "../../contracts/types";
import type { WorkflowTools } from "../../internal/WorkflowTools";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfJob } from "../model/WfJob.model";
import { dataOf, runActorOf, type WorkflowEngine } from "./WorkflowEngine";

/**
 * One `tool` job: call the service task's Tool and apply the result. The Tool
 * runs outside a transaction, the result is applied in a step transaction; a
 * token closed meanwhile (a cancel) drops it. The Tool runs on behalf of who
 * started the instance or of the process (`runAs`), with the token id as its idempotency key: after a crash
 * between the call and the step the call may repeat (TOOLS-001 §7).
 */
/** How long a claimed job belongs to its worker; if it dies, another one takes the job after that. */
export const LEASE_MS = 5 * 60_000;

const TIMEOUT_CODES: ReadonlySet<string> = new Set(["TOOL_TIMEOUT", "TOOL_TIMEOUT_OUTCOME_UNKNOWN"]);

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
    const input = resolveInput(node?.config?.input ?? {}, dataOf(instance, this.engine.now(), token));
    const timeoutMs = stepTimeoutMs(node?.config?.timeout, graph.document);
    // A step may run longer than the lease: another worker must not take the job and call the Tool again meanwhile.
    if (timeoutMs !== undefined && timeoutMs >= LEASE_MS) {
      await this.db.jobs.asNoTracking().where((j) => j.id.eq(job.id)).executeUpdate({ lockedUntil: new Date(this.engine.now().getTime() + timeoutMs + LEASE_MS) });
    }
    const runner = this.tools.bound;
    const result: AgentToolResult = runner === undefined
      ? { callId: token.id, name, status: "error", error: { code: "TOOL_NOT_FOUND", message: `Tool ${name} is not available to processes` }, metadata: {} } as AgentToolResult
      : await runner.run(name, input, {
        idempotencyKey: token.id,
        actor: runActorOf(graph.document, instance),
        metadata: { instanceId: instance.id, processKey: instance.processKey, nodeId: token.nodeId, partition: instance.partition, test: false } satisfies WorkflowToolMetadata,
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

    const timedOut = TIMEOUT_CODES.has(result.error?.code ?? "");
    const reason = timedOut ? "timeout" : reasonOf(result);
    const payloads = graph.document.settings?.log?.toolPayloads === true ? this.payloads(graph.document, name, node?.config?.input, input, result) : {};
    await this.engine.inStep(instance.id, async (step) => {
      const current = step.tokens.find((t) => t.id === token.id);
      const retryAt = current?.status === "waiting" && step.instance.status === "running" && result.status === "error" && (reason === undefined || timedOut)
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
        ...payloads,
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

  /** The input and output for the history under `log.toolPayloads`; personal data is masked unless `log.maskPersonal` is `false`. */
  private payloads(document: ProcessDocument, name: string, mapping: unknown, input: unknown, result: AgentToolResult): Record<string, unknown> {
    if (!masksPersonal(document)) return { input, output: result.output ?? null };
    const contract = this.tools.bound?.describe(name);
    const schemaOf = (side: AgentSchemaContract | undefined) => (side?.kind === "json-schema" ? side.schema : undefined);
    const masked = maskByMapping(mapping ?? {}, maskBySchema(input, schemaOf(contract?.input)), personalPaths(document));
    return { input: masked, output: maskBySchema(result.output ?? null, schemaOf(contract?.output)) };
  }
}

/** The business reason of a `ToolError`, if the Tool gave one. */
function reasonOf(result: AgentToolResult): string | undefined {
  const details = result.error?.details;
  const reason = typeof details === "object" && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>).reason : undefined;
  return typeof reason === "string" ? reason : undefined;
}

/** How long a step's Tool may run: its `timeout`, else `settings.stepTimeout`; `undefined` leaves the Tool's own limit. */
function stepTimeoutMs(timeout: unknown, document: ProcessDocument): number | undefined {
  const value = typeof timeout === "string" ? timeout : document.settings?.stepTimeout;
  return value === undefined ? undefined : durationMs(value);
}

/**
 * When to try a failed call again under the node's `retry` policy, or
 * `undefined` when the attempts are used up. The pause starts at `backoff` (10
 * seconds by default), grows by `factor` (2 by default) unless `growth` is
 * `fixed`, and stops growing at a day.
 */
export function nextAttempt(policy: unknown, attempts: number, now: Date): Date | undefined {
  if (typeof policy !== "object" || policy === null) return undefined;
  const { maxAttempts, backoff, growth, factor } = policy as { maxAttempts?: unknown; backoff?: unknown; growth?: unknown; factor?: unknown };
  if (typeof maxAttempts !== "number" || attempts >= maxAttempts) return undefined;
  const base = typeof backoff === "string" ? durationMs(backoff) ?? 10_000 : 10_000;
  const scale = growth === "fixed" ? 1 : (typeof factor === "number" ? factor : 2) ** Math.max(attempts - 1, 0);
  return new Date(now.getTime() + Math.min(base * scale, 86_400_000));
}
