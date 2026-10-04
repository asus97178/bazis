import type { SensitiveRedactionOptions } from "../../../library/redaction";
import { redactSensitive } from "../../../library/redaction";
import type { ToolDefinition } from "../AgentRegistry";
import type { AgentToolAuditHookProjectionV1 } from "../AgentToolHooks";
import type { AgentToolCall, AgentToolResult, JsonObject, JsonValue } from "../semantic";
import { toolContractName } from "./ToolContract.validator";

export type AgentToolAuditPhase = "attempt" | "enforcement" | "result" | "settlement" | "observer";
export type AgentToolAuditFailureMode = "fail-closed" | "best-effort";

export interface AgentToolAuditToolInfo {
  readonly name: string;
  readonly sideEffect: ToolDefinition["metadata"]["sideEffect"];
  readonly approval: ToolDefinition["metadata"]["approval"];
  readonly tags: readonly string[];
  readonly timeoutMs?: number;
  readonly inputSchema?: string;
  readonly outputSchema?: string;
}

export interface AgentToolAuditEntry {
  readonly kind: "agent-tool";
  readonly phase: AgentToolAuditPhase;
  readonly callId: string;
  readonly toolName: string;
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly idempotencyKey?: string;
  readonly input: JsonValue;
  readonly tool?: AgentToolAuditToolInfo;
  readonly result?: AgentToolResult;
  readonly startedAtUnixMs: number;
  readonly finishedAtUnixMs?: number;
  readonly durationMs?: number;
  readonly metadata: JsonObject;
  readonly hook?: AgentToolAuditHookProjectionV1;
}

interface ToolAuditOptions {
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly auditRedaction?: SensitiveRedactionOptions | false;
}
interface ToolAuditAttempt {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey?: string;
}

/** Builds the immutable audit projection; sink delivery and failure policy stay with execution. */
export class ToolAuditProjector {
  public constructor(private readonly auditRedaction: SensitiveRedactionOptions | false) {}

  public create(
    phase: AgentToolAuditPhase,
    call: AgentToolCall,
    startedAt: number,
    metadata: JsonObject,
    options: ToolAuditOptions,
    tool?: ToolDefinition,
    agentName?: string,
    result?: AgentToolResult,
    attempt?: ToolAuditAttempt,
  ): AgentToolAuditEntry {
    const finishedAt = result ? Date.now() : undefined;
    const entry: {
      kind: "agent-tool";
      phase: AgentToolAuditPhase;
      callId: string;
      toolName: string;
      agentName?: string;
      invocationId?: string;
      attempt?: number;
      maxAttempts?: number;
      idempotencyKey?: string;
      input: JsonValue;
      tool?: AgentToolAuditToolInfo;
      result?: AgentToolResult;
      startedAtUnixMs: number;
      finishedAtUnixMs?: number;
      durationMs?: number;
      metadata: JsonObject;
    } = {
      kind: "agent-tool",
      phase,
      callId: call.id,
      toolName: call.name,
      input: this.redactAuditValue(call.input, options),
      startedAtUnixMs: startedAt,
      metadata: this.redactAuditValue(metadata, options) as JsonObject,
    };

    if (agentName !== undefined || options.agentName !== undefined) {
      entry.agentName = agentName ?? options.agentName;
    }
    if (options.invocationId !== undefined) {
      entry.invocationId = options.invocationId;
    }
    if (attempt !== undefined) {
      entry.attempt = attempt.attempt;
      entry.maxAttempts = attempt.maxAttempts;
      if (attempt.idempotencyKey !== undefined) {
        entry.idempotencyKey = attempt.idempotencyKey;
      }
    }
    if (tool !== undefined) {
      entry.tool = this.auditToolInfo(tool);
    }
    if (result !== undefined) {
      entry.result = this.redactAuditValue(result, options) as AgentToolResult;
      entry.finishedAtUnixMs = finishedAt;
      entry.durationMs = result.durationMs ?? Math.max(0, Date.now() - startedAt);
    }

    return this.freezeAuditEntry(this.redactAuditValue(entry, options));
  }

  private redactAuditValue<T>(value: T, options: ToolAuditOptions): T {
    const redaction = options.auditRedaction ?? this.auditRedaction;
    return redaction === false ? value : redactSensitive(value, redaction);
  }

  private freezeAuditEntry(entry: AgentToolAuditEntry): AgentToolAuditEntry {
    const visit = (value: unknown, seen: WeakSet<object>): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      for (const child of Object.values(value as Record<string, unknown>)) visit(child, seen);
      Object.freeze(value);
    };
    visit(entry, new WeakSet<object>());
    return entry;
  }

  private auditToolInfo(tool: ToolDefinition): AgentToolAuditToolInfo {
    const info: {
      name: string;
      sideEffect: ToolDefinition["metadata"]["sideEffect"];
      approval: ToolDefinition["metadata"]["approval"];
      tags: readonly string[];
      timeoutMs?: number;
      inputSchema?: string;
      outputSchema?: string;
    } = {
      name: tool.metadata.name,
      sideEffect: tool.metadata.sideEffect,
      approval: tool.metadata.approval,
      tags: Object.freeze([...tool.metadata.tags]),
    };
    if (tool.metadata.timeoutMs !== undefined) {
      info.timeoutMs = tool.metadata.timeoutMs;
    }
    if (tool.metadata.input !== undefined) {
      info.inputSchema = toolContractName(tool.metadata.input);
    }
    if (tool.metadata.output !== undefined) {
      info.outputSchema = toolContractName(tool.metadata.output);
    }
    return Object.freeze(info);
  }

}
