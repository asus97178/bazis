/**
 * Bazis framework — public API (barrel).
 *
 * The common path is intentionally flat:
 *
 * ```ts
 * import { Module, Controller, Get, runApp } from "bazis";
 * ```
 *
 * Namespaced re-exports stay available when grouping reads better:
 *
 * ```ts
 * import { di, http } from "bazis";
 * ```
 *
 * Subpath imports remain available for granular usage:
 *
 * ```ts
 * import { createContainer } from "bazis/core/di";
 * ```
 */
export * as app from "./core/app";
export * as agent from "./core/agent";
export * as background from "./core/background";
export * as cache from "./core/cache";
export * as di from "./core/di";
export * as http from "./core/http";
export * as grpc from "./core/grpc";
export * as httpClient from "./core/http-client";
export * as infra from "./core/infra";
export * as kernel from "./core/kernel";
export * as orm from "./core/orm";
export * as websocket from "./core/websocket";
export * as jsonapi from "./library/jsonapi";
export * as jwt from "./library/jwt";
export * as openapi from "./library/openapi";
export * as redaction from "./library/redaction";
export * as ui from "./library/ui";
export * as validation from "./library/validation";

// Golden-path application API.
export {
  GrpcController, GrpcMethod, GrpcError, GrpcStatus, grpcModule, grpcService, loadGrpcPackage,
  GrpcClient, grpcClientProvider,
  type GrpcClientOptions, type GrpcClientTlsOptions, type GrpcCallOptions, type GrpcResponse, type GrpcResponseStream,
  type GrpcContext, type GrpcModuleOptions,
} from "./core/grpc";
export {
  runApp,
  type RunAppOptions,
  type RunAppUiAppInfo,
  type RunAppUiOptions,
  type RunAppUiSurfaceOptions,
  type UiSurfacePolicyDecision,
  type UiSurfacePolicyInput,
  type UiSurfacePolicyPageInput,
  type UiSurfacePageDecision,
  type UiSurfaceResourceDecision,
  type UiSurfaceSessionUser,
  type UiSurfaceSessionV1,
} from "./core/app";
export {
  Global,
  Module,
  collectModuleUiProfiles,
  createContainer,
  createToken,
  scoped,
  singleton,
  singletonFactory,
  singletonFactoryWithResolver,
  singletonValue,
  transient,
  type ModuleConfig,
  type BazisModule,
  type BazisModuleMetadata,
  type BazisModuleRef,
} from "./core/di";
export {
  AGENT_MODEL_PROVIDER,
  Agent,
  AgentRegistry,
  AgentRuntime,
  AgentRuntimeError,
  AgentSemanticError,
  AgentToolExecutionError,
  AgentToolExecutor,
  ApproximateAgentContextTokenEstimator,
  DefaultAgentContextBuilder,
  Prompt,
  Task,
  Tool,
  agentClassSchema,
  agentData,
  agentTaskMetadataOf,
  agentInvocation,
  agentJsonSchema,
  agentMessage,
  agentModelCapabilities,
  agentModelRequest,
  agentModelResponse,
  agentOutput,
  agentOutputContract,
  agentText,
  agentToolCall,
  agentToolContract,
  agentToolResult,
  collectAgentCatalog,
  type AgentCatalog,
  type AgentCatalogExtras,
  type AgentContext,
  type AgentContextBuildInput,
  type AgentContextBuilder,
  type AgentContextLimits,
  type AgentContextTokenEstimator,
  type AgentContextTraceEntry,
  type AgentDefinition,
  type AgentInvocation,
  type AgentMessage,
  type AgentMetadataIndex,
  type AgentTaskDefinition,
  type AgentTaskMetadata,
  type AgentTaskOptions,
  type TaskDecoratorOptions,
  type AgentModelCapabilities,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentOptions,
  type AgentOutputContract,
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
  type AgentRuntimeStatus,
  type AgentRuntimeTaskInvokeOptions,
  type AgentRuntimeToolExecutionOptions,
  type AgentToolCall,
  type AgentExecutableTool,
  type AgentToolAuditEntry,
  type AgentToolAuditFailureMode,
  type AgentToolAuditFunction,
  type AgentToolAuditPhase,
  type AgentToolAuditSink,
  type AgentToolAuditSinkObject,
  type AgentToolAuditToolInfo,
  type AgentToolApprovalPolicy,
  type AgentToolApprovalRequest,
  type AgentToolExecutionContext,
  type AgentToolExecutionOptions,
  type AgentToolExecutorOptions,
  type AgentToolRetryBackoff,
  type AgentToolRetryPolicy,
  type AgentToolSchemaValidator,
  type AgentToolValidationIssue,
  type AgentToolValidationResult,
  type AgentToolHookKindV1,
  type AgentToolHookRefV1,
  type AgentToolRequiredHookRefV1,
  type AgentToolHookRegistrationBaseV1,
  type AgentToolHookRegistrationV1,
  type AgentToolHookContextV1,
  type AgentToolCallProjectionV1,
  type AgentToolDescriptorProjectionV1,
  type AgentToolBeforeEffectEventV1,
  type AgentToolEnforcementDecisionV1,
  type AgentToolEnforcementHookV1,
  type AgentToolTerminalProjectionV1,
  type AgentToolSettlementEventV1,
  type AgentToolSettlementResultV1,
  type AgentToolSettlementHookV1,
  type AgentToolObserverEventV1,
  type AgentToolObserverHookV1,
  type AgentToolAuditHookProjectionV1,
  type AgentToolContract,
  type AgentToolResult,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type JsonValue,
  type PromptOptions,
  type PromptSectionKind,
  type PromptSectionMetadata,
  type PromptSectionOptions,
  type ToolOptions,
} from "./core/agent";
export {
  AllowAnonymous,
  Authorize,
  BadRequest,
  Conflict,
  Controller,
  Created,
  Delete,
  Forbidden,
  Get,
  HttpContext,
  InternalServerError,
  NoContent,
  NotFound,
  Ok,
  Post,
  Put,
  RequestModel,
  Unauthorized,
} from "./core/http";
export {
  Cacheable,
  OutputCache,
  cachedScoped,
  cachedSingleton,
  memory,
} from "./core/cache";
export {
  Column,
  Check,
  DbContext,
  Entity,
  Index,
  Key,
  Schema,
  UUID,
  ormBazisConnect,
  ormModule,
  postgres,
  repositoryFor,
  type IRepository,
} from "./core/orm";
export { defineConfig, secret, type Secret } from "./core/kernel";
export {
  Infra,
  infraModule,
  llmConnect,
  llmProfile,
  llmRouter,
  LlmModelRouter,
  LlmModelRouterError,
  openAiCompatibleAdapter,
  OpenAiCompatibleModelProvider,
  OpenAiCompatibleProviderError,
  redisConnect,
  openSearchConnect,
  type LlmConfigShape,
  type LlmConnectionOptions,
  type LlmConnectorOptions,
  type LlmModelProfile,
  type LlmModelProfileOptions,
  type LlmProviderAdapter,
  type LlmRouterOptions,
  type OpenAiCompatibleAdapterOptions,
  type OpenAiCompatibleFetch,
} from "./core/infra";
export { Validator } from "./library/validation";
export {
  COMPILED_UI_SURFACE_V1_API_VERSION,
  COMPILED_UI_SURFACE_V1_KIND,
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  UiProfile,
  canonicalUiJson,
  compileUiSurfaceV1,
  defineUiProfile,
  normalizeUiJsonObject,
  normalizeUiJsonValue,
  uiOperation,
  uiEndpoint,
  uiProfileAuthoringMetadataOf,
  uiDocumentRevision,
  type CompiledUiSurfaceV1,
  type CompiledUiCustomPageV1,
  type CompiledUiFeaturePageV1,
  type CompileUiSurfaceV1Options,
  type CompileUiSurfaceV1Result,
  type UiDiagnosticV1,
  type UiJsonObject,
  type UiJsonValue,
  type UiProfileV1,
  type UiProfileAuthoringMetadata,
  type UiProfileAuthoringOptions,
  type UiCustomPagesProfileAuthoringOptions,
  type UiFeaturePageAuthoring,
  type UiFeaturePageProfileV1,
  type UiEndpointReference,
} from "./library/ui";
