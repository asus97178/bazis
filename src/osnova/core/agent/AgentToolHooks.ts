import type { Class, OsnovaModuleRef } from "../di";
import type { JsonObject, JsonValue, AgentToolResultStatus } from "./semantic";
import type { ToolApproval, ToolSideEffect } from "./metadata";
import type { AgentToolExecutionApproval } from "./AgentToolExecutor";

export type AgentToolHookKindV1 = "enforcement" | "settlement" | "observer";

export interface AgentToolHookRefV1 { readonly kind: AgentToolHookKindV1; readonly id: string; readonly version: number; }
export interface AgentToolRequiredHookRefV1 extends AgentToolHookRefV1 { readonly owner: OsnovaModuleRef; }
export interface AgentToolHookRegistrationBaseV1 extends AgentToolHookRefV1 { readonly order?: number; readonly timeoutMs?: number; }
export type AgentToolHookRegistrationV1 =
  | (AgentToolHookRegistrationBaseV1 & { readonly kind: "enforcement"; readonly handler: Class<AgentToolEnforcementHookV1>; })
  | (AgentToolHookRegistrationBaseV1 & { readonly kind: "settlement"; readonly handler: Class<AgentToolSettlementHookV1>; })
  | (AgentToolHookRegistrationBaseV1 & { readonly kind: "observer"; readonly handler: Class<AgentToolObserverHookV1>; });

export interface AgentToolHookContextV1 { readonly signal: AbortSignal; readonly deadlineUnixMs: number; }
export interface AgentToolCallProjectionV1 { readonly id: string; readonly name: string; readonly input: JsonValue; readonly metadata: JsonObject; }
export interface AgentToolDescriptorProjectionV1 { readonly name: string; readonly description: string; readonly sideEffect: ToolSideEffect; readonly approval: ToolApproval; readonly tags: readonly string[]; }
export interface AgentToolBeforeEffectEventV1 {
  readonly type: "agent-tool.before-effect/v1"; readonly invocationId?: string; readonly agentName?: string;
  readonly attempt: number; readonly maxAttempts: number; readonly idempotencyKey?: string;
  readonly call: AgentToolCallProjectionV1; readonly tool: AgentToolDescriptorProjectionV1;
  readonly executionApproval: AgentToolExecutionApproval;
}
export type AgentToolEnforcementDecisionV1 =
  | { readonly decision: "allow"; readonly evidence?: JsonObject; }
  | { readonly decision: "deny"; readonly reasonCode?: string; readonly message?: string; readonly evidence?: JsonObject; };
export interface AgentToolEnforcementHookV1 { enforce(event: AgentToolBeforeEffectEventV1, context: AgentToolHookContextV1): AgentToolEnforcementDecisionV1 | Promise<AgentToolEnforcementDecisionV1>; }
export interface AgentToolTerminalProjectionV1 { readonly status: AgentToolResultStatus; readonly executeStarted: boolean; readonly outcomeKnown: boolean; readonly retryable: boolean; readonly errorCode?: string; readonly output?: JsonValue; }
export interface AgentToolSettlementEventV1 {
  readonly type: "agent-tool.settlement/v1"; readonly callId: string; readonly toolName: string;
  readonly invocationId?: string; readonly agentName?: string; readonly attempt?: number;
  readonly beforeEffect?: AgentToolBeforeEffectEventV1; readonly terminal: AgentToolTerminalProjectionV1;
}
export interface AgentToolSettlementResultV1 { readonly status: "recorded"; readonly evidence?: JsonObject; }
export interface AgentToolSettlementHookV1 { settle(event: AgentToolSettlementEventV1, context: AgentToolHookContextV1): AgentToolSettlementResultV1 | Promise<AgentToolSettlementResultV1>; }
export interface AgentToolObserverEventV1 { readonly type: "agent-tool.observer/v1"; readonly settlement: AgentToolSettlementEventV1; }
export interface AgentToolObserverHookV1 { observe(event: AgentToolObserverEventV1, context: AgentToolHookContextV1): void | Promise<void>; }
export interface AgentToolAuditHookProjectionV1 extends AgentToolHookRefV1 { readonly tier: "platform" | "application"; readonly order: number; readonly outcome: "allowed" | "denied" | "recorded" | "failed" | "timed-out" | "cancelled" | "invalid-result"; readonly reasonCode?: string; readonly evidence?: JsonObject; }
