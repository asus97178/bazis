import type { Class } from "../di";
import { registerModuleDescriber } from "../kernel/report/moduleTree";
import { moduleToolsOf, type DefinedTool, type ToolSet } from "./defineTool";
import { toolMetadataOf } from "./metadata";

// The module tree of the startup screen: `orders.summary · read`.
registerModuleDescriber((metadata) => moduleToolsOf(metadata.tools).map((tool) => {
  const meta = toolMetadataOf(tool);
  return { kind: "tool" as const, text: meta === undefined ? tool.name : `${meta.name} · ${meta.sideEffect}` };
}));

export { Tool } from "./decorators/Tool";
export { defineTool, isDefinedTool, toolNameOf, type DefinedTool, type DefinedToolOptions, type ToolSet } from "./defineTool";
export { agentTool, type AgentToolInput, type AgentToolOptions, type AgentToolOutput } from "./agentTool";
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
  AgentModelUnavailableError,
  AgentModelContextOverflowError,
  AgentToolPreCommitError,
  ToolError,
} from "./errors";
export {
  AGENT_RUNTIME_OPTIONS,
  AgentRuntime,
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentModelRetryPolicy,
  type AgentCompactionOptions,
  type AgentRunEvent,
  type AgentStepStartedEvent,
  type AgentTextDeltaEvent,
  type AgentModelRetryEvent,
  type AgentModelAnsweredEvent,
  type AgentToolStartedEvent,
  type AgentToolFinishedEvent,
  type AgentCompactedEvent,
  type AgentRunFinishedEvent,
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
  type ToolDryRun,
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
  agentMessageText,
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
  agentReasoning,
  normalizeJsonValue,
  type AgentClassSchemaContract,
  type AgentContentInput,
  type AgentContentPart,
  type AgentDataPart,
  type AgentFilePart,
  type AgentReasoningPart,
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
    /**
     * The Tools of the module: classes with `@Tool`, Tools made by `defineTool`
     * and sets of them (`ormEntityTools(...)`). An agent definition names them in `toolNames`.
     */
    readonly tools?: readonly (Class<object> | DefinedTool | ToolSet)[];
    readonly agentToolHooks?: readonly import("./AgentToolHooks").AgentToolHookRegistrationV1[];
  }
}
