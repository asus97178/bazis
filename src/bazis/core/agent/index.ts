import type { Class } from "../di";
import { registerModuleDescriber } from "../kernel/report/moduleTree";
import { toolMetadataOf } from "./metadata";

// The module tree of the startup screen: `orders.summary · read`.
registerModuleDescriber((metadata) => (metadata.tools ?? []).map((tool) => {
  const meta = toolMetadataOf(tool);
  return { kind: "tool" as const, text: meta === undefined ? tool.name : `${meta.name} · ${meta.sideEffect}` };
}));

export { Tool } from "./decorators/Tool";
export { describeTool } from "./Tool.contract";
export type {
  AgentToolHookKindV1, AgentToolHookRefV1, AgentToolRequiredHookRefV1, AgentToolHookRegistrationBaseV1,
  AgentToolHookRegistrationV1, AgentToolHookContextV1, AgentToolCallProjectionV1, AgentToolDescriptorProjectionV1,
  AgentToolBeforeEffectEventV1, AgentToolEnforcementDecisionV1, AgentToolEnforcementHookV1,
  AgentToolTerminalProjectionV1, AgentToolSettlementEventV1, AgentToolSettlementResultV1,
  AgentToolSettlementHookV1, AgentToolObserverEventV1, AgentToolObserverHookV1, AgentToolAuditHookProjectionV1,
} from "./AgentToolHooks";
export {
  AgentRuntimeError,
  AgentSemanticError,
  AgentSetupError,
  AgentToolExecutionError,
  AgentModelTimeoutError,
  AgentToolPreCommitError,
  ToolError,
} from "./errors";
export {
  AGENT_RUNTIME_OPTIONS,
  AgentRuntime,
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
  type AgentRuntimeStatus,
  type AgentRuntimeToolCallContext,
  type AgentRuntimeToolExecutionOptions,
} from "./AgentRuntime";
export { BoundToolRunner, ToolRunner, type ToolRunOptions } from "./ToolRunner";
export { TOOL_EXECUTION_OPTIONS, type ToolExecutionOptions } from "./toolExecutionOptions";
export {
  ApproximateAgentContextTokenEstimator,
  DefaultAgentContextBuilder,
  mergeAgentContextLimits,
  normalizeAgentContextLimits,
  type AgentContext,
  type AgentContextBuildInput,
  type AgentContextBuilder,
  type AgentContextLimits,
  type AgentContextTokenEstimator,
  type AgentContextTraceEntry,
  type DefaultAgentContextBuilderOptions,
} from "./AgentContextBuilder";
export {
  type AgentExecutableTool,
  type AgentToolAuditEntry,
  type AgentToolAuditFailureMode,
  type AgentToolAuditFunction,
  type AgentToolAuditPhase,
  type AgentToolAuditSink,
  type AgentToolAuditSinkObject,
  type AgentToolAuditToolInfo,
  type AgentToolApprovalDecision,
  type AgentToolApprovalFunction,
  type AgentToolApprovalPolicy,
  type AgentToolApprovalPolicyObject,
  type AgentToolApprovalReason,
  type AgentToolApprovalRequest,
  type AgentToolExecutionApproval,
  type AgentToolExecutionContext,
  type AgentToolExecutionOptions,
  type AgentToolExecutorOptions,
  type AgentToolRetryBackoff,
  type AgentToolRetryPolicy,
  type AgentToolSchemaValidator,
  type AgentToolValidationIssue,
  type AgentToolValidationResult,
} from "./AgentToolExecutor";
export {
  AGENT_MODEL_PROVIDER,
  type AgentModelProvider,
  type AgentModelProviderContext,
} from "./ModelProvider";
export type { ToolDefinition } from "./AgentRegistry";
export type { AgentDataDefinition } from "./AgentDataDefinition";
export {
  toolMetadataOf,
  type ToolApproval,
  type ToolMetadata,
  type ToolActor,
  type ToolOptions,
  type ToolSideEffect,
} from "./metadata";
export {
  agentClassSchema,
  agentData,
  agentFile,
  agentImage,
  agentInvocation,
  agentJsonSchema,
  agentMessage,
  agentModelCapabilities,
  agentModelRequest,
  agentModelResponse,
  agentOutputContract,
  agentText,
  agentToolCall,
  agentToolCallPart,
  agentToolContract,
  agentToolResult,
  agentToolResultPart,
  normalizeJsonValue,
  type AgentClassSchemaContract,
  type AgentContentInput,
  type AgentContentPart,
  type AgentDataPart,
  type AgentFilePart,
  type AgentFinishReason,
  type AgentImagePart,
  type AgentInvocation,
  type AgentInvocationOptions,
  type AgentJsonSchemaContract,
  type AgentMessage,
  type AgentMessageOptions,
  type AgentMessageRole,
  type AgentModelCapabilities,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentOutputContract,
  type AgentOutputMode,
  type AgentSchemaContract,
  type AgentStreamEvent,
  type AgentTextPart,
  type AgentToolCall,
  type AgentToolCallPart,
  type AgentToolContract,
  type AgentToolError,
  type AgentToolResult,
  type AgentToolResultPart,
  type AgentToolResultStatus,
  type AgentUsage,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "./semantic";

// Augment the declaring file, not the "../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../di/module/types/BazisModule" {
  interface BazisModuleMetadata {
    /** Tools agents may call: classes with `@Tool`. An agent definition names them in `toolNames`. */
    readonly tools?: readonly Class<object>[];
    readonly agentToolHooks?: readonly import("./AgentToolHooks").AgentToolHookRegistrationV1[];
  }
}
