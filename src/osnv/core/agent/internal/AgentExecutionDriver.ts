import { inlineGeneratedSchema } from "./Schema.contract";
import { describeTool } from "../Tool.contract";
import type { Class, ServiceProvider } from "../../di";
import { getGeneratedOpenApiMetadata, getGeneratedOpenApiSchemaName } from "../../http/OpenApi/generatedOpenApiRegistry";
import { redactSensitive, redactSensitiveText } from "../../../library/redaction";
import { AgentRuntimeError } from "../errors";
import { agentModelJson, bindAgentModel } from "./AgentModelBinding";
import { validateAgentJsonSchema } from "./AgentJsonSchema";
import type { AgentDefinition, AgentRegistry, AgentTaskDefinition, ToolDefinition } from "../AgentRegistry";
import {
  DefaultAgentContextBuilder,
  mergeAgentContextLimits,
  normalizeAgentContextLimits,
  type AgentContextBuilder,
  type AgentContextLimits,
} from "../AgentContextBuilder";
import {
  AgentToolExecutor,
  type AgentToolExecutionOptions,
  type AgentToolExecutorOptions,
  type AgentToolSchemaValidator,
} from "../AgentToolExecutor";
import type { AgentModelProvider, AgentModelProviderContext } from "../ModelProvider";
import {
  agentExecutionCheckpointV1,
  evolveAgentExecutionCheckpointV1,
  requireIssuedAgentExecutionCheckpointV1,
  type AgentExecutionBoundary,
  type AgentExecutionCheckpointV1,
} from "./AgentExecutionState";
import {
  agentClassSchema,
  agentData,
  agentJsonSchema,
  agentMessage,
  agentModelRequest,
  agentModelResponse,
  agentOutputContract,
  agentToolCall,
  agentToolContract,
  agentToolCallPart,
  agentToolResultPart,
  normalizeJsonValue,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentOutputContract,
  type AgentToolError,
  type AgentToolContract,
  type AgentToolResult,
  type JsonObject,
  type JsonValue,
} from "../semantic";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 16;
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

export type AgentRuntimeStatus = "completed" | "failed";

export interface AgentRuntimeToolCallContext {
  readonly invocationId: string;
  readonly agentName: string;
  readonly call: AgentModelResponse["toolCalls"][number];
}

export interface AgentRuntimeToolExecutionOptions extends Omit<
  AgentToolExecutionOptions,
  "agentName" | "invocationId" | "metadata" | "idempotencyKey"
> {
  /** Optional prefix; the runtime appends the unique model call id. */
  readonly idempotencyKey?: string;
  /** Per-call override for domain-specific stable idempotency keys. */
  readonly idempotencyKeyForCall?: (context: AgentRuntimeToolCallContext) => string | undefined;
}

export interface AgentRuntimeOptions {
  readonly maxSteps?: number;
  readonly maxToolCallsPerStep?: number;
  readonly modelProfile?: string;
  readonly model?: string;
  /** Provider-call timeout. Defaults to 60 seconds; 0 explicitly disables it. */
  readonly timeoutMs?: number;
  readonly contextBuilder?: AgentContextBuilder;
  readonly contextLimits?: AgentContextLimits;
  readonly toolExecutorOptions?: AgentToolExecutorOptions;
  readonly taskSchemaValidator?: AgentToolSchemaValidator;
}

export interface AgentRuntimeInvokeOptions {
  readonly id?: string;
  readonly input?: unknown;
  readonly messages?: readonly AgentMessage[];
  readonly output?: AgentOutputContract;
  readonly metadata?: unknown;
  readonly modelProfile?: string;
  readonly model?: string;
  readonly maxSteps?: number;
  readonly maxToolCallsPerStep?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Per-provider-call timeout override; 0 explicitly disables it. */
  readonly timeoutMs?: number;
  readonly contextLimits?: AgentContextLimits;
  readonly signal?: AbortSignal;
  readonly toolExecution?: AgentRuntimeToolExecutionOptions;
  /** Ephemeral, provisional text; never persisted/replayed as a checkpoint or accepted output. */
  readonly onTextDelta?: (event: { readonly step: number; readonly text: string }) => void;
}

export interface AgentRuntimeTaskInvokeOptions extends Omit<AgentRuntimeInvokeOptions, "input"> {}

export interface AgentRuntimeResult {
  readonly invocationId: string;
  readonly agentName: string;
  readonly status: AgentRuntimeStatus;
  readonly steps: number;
  readonly messages: readonly AgentMessage[];
  readonly responses: readonly AgentModelResponse[];
  readonly toolResults: readonly AgentToolResult[];
  readonly finalMessage?: AgentMessage;
  /** Validated structured value for declared or explicitly requested JSON output. */
  readonly output?: JsonValue;
  readonly error?: AgentToolError;
  readonly metadata: JsonObject;
}

type PreparedTaskContract =
  | { readonly ok: true; readonly instance: object; readonly value: JsonValue }
  | { readonly ok: false; readonly error: AgentToolError };

type PreparedAgentPlan = {
  readonly agent: AgentDefinition;
  readonly invocationId: string;
  readonly metadata: JsonObject;
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly timeoutMs: number | undefined;
  readonly modelProfile: string | undefined;
  readonly contextLimits: AgentContextLimits | undefined;
  readonly messages: AgentMessage[];
  readonly seenToolCallIds: Set<string>;
  readonly tools: readonly AgentToolContract[];
  readonly executorToolOptions: AgentToolExecutionOptions;
  readonly sessionToolTimeouts?: ReadonlyMap<string, number>;
  readonly options: AgentRuntimeInvokeOptions;
  readonly taskFinalization?: TaskFinalizationPlan;
};

type TaskFinalizationPlan = {
  readonly task: AgentTaskDefinition;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal | undefined;
};

type AgentPreparation =
  | { readonly ok: true; readonly plan: PreparedAgentPlan }
  | { readonly ok: false; readonly result: AgentRuntimeResult };

type PreparedTaskPlan = {
  readonly task: AgentTaskDefinition;
  readonly timeoutMs: number | undefined;
  readonly plan: PreparedAgentPlan;
};

type TaskPreparation =
  | { readonly ok: true; readonly prepared: PreparedTaskPlan }
  | { readonly ok: false; readonly result: AgentRuntimeResult };

type EngineProgress = Pick<AgentExecutionCheckpointV1, "phase" | "steps" | "messages" | "responses" | "toolResults" | "seenToolCallIds" | "pendingToolBatch" | "terminal">;

/** Progress of a run kept only in memory (no checkpoint store). */
type InMemoryExecutionState = EngineProgress;

type PhaseBridge<TState extends EngineProgress> = {
  evolve(
    previous: TState,
    progress: EngineProgress,
  ): TState;
  boundaryError(state: TState): Error;
};

type EngineBoundary<TState extends EngineProgress> = {
  checkControl(current: TState, next: TState): Promise<import("./AgentExecutionState").AgentExecutionControlDecision>;
  beforeModelDispatch(checkpoint: TState, step: number, request: AgentModelRequest): Promise<void>;
  afterModelSettlement(previous: TState, candidate: TState, step: number, outcome: { readonly response: AgentModelResponse } | { readonly error: AgentToolError }): Promise<void>;
  beforeToolDispatch(checkpoint: TState, step: number, toolIndex: number, call: AgentModelResponse["toolCalls"][number], idempotencyKey: string): Promise<void>;
  afterToolSettlement(previous: TState, candidate: TState, step: number, toolIndex: number, call: AgentModelResponse["toolCalls"][number], idempotencyKey: string, result: AgentToolResult): Promise<void>;
};

type EngineOutcome<TState extends EngineProgress> =
  | { readonly kind: "terminal"; readonly state: TState; readonly result: AgentRuntimeResult }
  | { readonly kind: "suspended"; readonly state: TState; readonly reason: string };

export type AgentExecutionDriveOutcome =
  | { readonly kind: "terminal"; readonly checkpoint: AgentExecutionCheckpointV1; readonly result: AgentRuntimeResult }
  | { readonly kind: "suspended"; readonly checkpoint: AgentExecutionCheckpointV1; readonly reason: string };

/** Owner-private Session creation carrier; it is never re-exported by AgentRuntime. */
export interface AgentSessionPreparationV1 {
  readonly invocationId: string;
  readonly agentName: string;
  readonly taskName: string | null;
  readonly input: JsonValue;
  readonly requested: {
    readonly maxSteps: number | null;
    readonly maxToolCallsPerStep: number | null;
    readonly runTimeoutMs: number | null;
    readonly modelProfile: string | null;
  };
  readonly module: {
    readonly maxSessionSteps: number;
    readonly maxToolCallsPerStep: number;
    readonly runTimeoutMs: number;
    readonly providerCallTimeoutMs: number;
    readonly toolDefaultTimeoutMs: number;
    readonly scopeDisposeTimeoutMs: number;
  };
  readonly signal?: AbortSignal;
}

export type AgentSessionPreparationOutcomeV1 =
  | { readonly kind: "prepared"; readonly checkpoint: AgentExecutionCheckpointV1 }
  | { readonly kind: "rejected"; readonly result: AgentRuntimeResult };

export interface AgentExecutionDriveRequestV1 {
  readonly checkpoint: AgentExecutionCheckpointV1;
  readonly boundary: AgentExecutionBoundary;
  readonly signal: AbortSignal;
}

export class AgentExecutionBoundaryError extends Error {
  constructor(readonly checkpoint: AgentExecutionCheckpointV1) {
    super("Agent execution durable boundary rejected a checkpoint transition.");
    this.name = "AgentExecutionBoundaryError";
  }
}

class AgentRuntimeTimeoutError extends Error {
  constructor() {
    super("Agent runtime provider call timed out.");
    this.name = "AgentRuntimeTimeoutError";
  }
}

class AgentRuntimeAbortError extends Error {
  constructor() {
    super("Agent runtime invocation was aborted.");
    this.name = "AgentRuntimeAbortError";
  }
}

function isPlainJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown, field: string): JsonObject {
  const normalized = normalizeJsonValue(value ?? {}, field);
  if (!isPlainJsonObject(normalized)) {
    throw new AgentRuntimeError(`${field} must be a JSON object.`);
  }
  return normalized;
}

function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === "string" ? error.message : String(error);
  } catch {
    return "Unknown error.";
  }
}

function assertPositiveInteger(value: number | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentRuntimeError(`${field} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentRuntimeError(`${field} must be a non-negative integer.`);
  }
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentRuntimeError(`${field} must be a non-empty string when provided.`);
  }
  return trimmed;
}

function optionPositiveInteger(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AgentRuntimeError(`${field} must be a positive integer.`);
  }
  return value;
}

function optionText(value: JsonValue | undefined, field: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentRuntimeError(`${field} must be a non-empty string or null.`);
  }
  return value;
}

function checkpointOptionObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value === undefined || !isPlainJsonObject(value)) throw new AgentRuntimeError(`${field} must be an object.`);
  return value;
}

function optionNullablePositiveInteger(value: JsonValue | undefined, field: string): number | undefined {
  if (value === null) return undefined;
  return optionPositiveInteger(value, field);
}

function optionNullableFiniteNonNegative(value: JsonValue | undefined, field: string): number | undefined {
  if (value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentRuntimeError(`${field} must be a finite non-negative number or null.`);
  }
  return value;
}

function checkpointContextLimits(value: JsonObject): AgentContextLimits | undefined {
  const maxMessages = optionNullablePositiveInteger(value.maxMessages, "checkpoint.options.context.maxMessages");
  const maxChars = optionNullablePositiveInteger(value.maxChars, "checkpoint.options.context.maxChars");
  const maxTokens = optionNullablePositiveInteger(value.maxTokens, "checkpoint.options.context.maxTokens");
  return maxMessages === undefined && maxChars === undefined && maxTokens === undefined
    ? undefined
    : Object.freeze({ maxMessages, maxChars, maxTokens });
}

function checkpointToolExecutionOptions(
  value: JsonObject,
  agent: AgentDefinition,
  invocationId: string,
): AgentToolExecutionOptions {
  const maxAttempts = value.maxAttempts;
  if (maxAttempts !== 1) throw new AgentRuntimeError("checkpoint.options.tool.maxAttempts must be 1.");
  const scopeDisposeTimeoutMs = optionPositiveInteger(value.scopeDisposeTimeoutMs, "checkpoint.options.tool.scopeDisposeTimeoutMs");
  const timeouts = value.timeouts;
  if (!Array.isArray(timeouts)) throw new AgentRuntimeError("checkpoint.options.tool.timeouts must be an array.");
  const expected = agent.tools.map((tool) => tool.metadata.name).sort();
  const actual = timeouts.map((entry) => {
    if (!isPlainJsonObject(entry)) throw new AgentRuntimeError("checkpoint.options.tool.timeouts entry must be an object.");
    const name = optionText(entry.name, "checkpoint.options.tool.timeouts.name");
    if (name === undefined) throw new AgentRuntimeError("checkpoint.options.tool.timeouts.name is required.");
    optionPositiveInteger(entry.timeoutMs, "checkpoint.options.tool.timeouts.timeoutMs");
    return name;
  });
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new AgentRuntimeError(`checkpoint for invocation "${invocationId}" does not match the bound Agent tools.`);
  }
  return Object.freeze({ retryPolicy: Object.freeze({ maxAttempts: 1 }), scopeDisposeTimeoutMs });
}

function checkpointToolTimeouts(value: JsonObject): ReadonlyMap<string, number> {
  const entries = value.timeouts;
  if (!Array.isArray(entries)) throw new AgentRuntimeError("checkpoint.options.tool.timeouts must be an array.");
  const timeouts = new Map<string, number>();
  for (const entry of entries) {
    if (!isPlainJsonObject(entry)) throw new AgentRuntimeError("checkpoint.options.tool.timeouts entry must be an object.");
    const name = optionText(entry.name, "checkpoint.options.tool.timeouts.name");
    if (name === undefined || timeouts.has(name)) throw new AgentRuntimeError("checkpoint.options.tool.timeouts must contain unique names.");
    timeouts.set(name, optionPositiveInteger(entry.timeoutMs, "checkpoint.options.tool.timeouts.timeoutMs"));
  }
  return timeouts;
}

function generatedInvocationId(): string {
  return `inv-${crypto.randomUUID()}`;
}

function classDebugName(value: unknown): string {
  const name = (value as { readonly name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name : "<anonymous class>";
}


function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseMessage(response: AgentModelResponse): AgentMessage | undefined {
  return response.message;
}

function normalizeProviderResponse(value: unknown): AgentModelResponse {
  if (!isObjectRecord(value) || !Array.isArray(value.toolCalls)) {
    throw new AgentRuntimeError("Model provider response must be an object with a toolCalls array.");
  }
  const rawMessage = value.message;
  const message = rawMessage === undefined
    ? undefined
    : (() => {
        if (!isObjectRecord(rawMessage)) {
          throw new AgentRuntimeError("Model provider response message must be an object.");
        }
        return agentMessage(
          rawMessage.role as AgentMessage["role"],
          rawMessage.content as AgentMessage["content"],
          {
            id: rawMessage.id as string | undefined,
            name: rawMessage.name as string | undefined,
            toolCallId: rawMessage.toolCallId as string | undefined,
            createdAtUnixMs: rawMessage.createdAtUnixMs as number | undefined,
            metadata: rawMessage.metadata,
          },
        );
      })();
  const toolCalls = value.toolCalls.map((call, index) => {
    if (!isObjectRecord(call)) {
      throw new AgentRuntimeError(`Model provider toolCalls[${index}] must be an object.`);
    }
    return agentToolCall({
      id: call.id as string,
      name: call.name as string,
      input: call.input,
      metadata: call.metadata,
    });
  });
  return agentModelResponse({
    invocationId: value.invocationId as string,
    finishReason: value.finishReason as AgentModelResponse["finishReason"],
    message,
    toolCalls,
    usage: value.usage as AgentModelResponse["usage"],
    metadata: value.metadata,
  });
}

function runtimeError(code: string, message: string, details?: JsonValue): AgentToolError {
  return Object.freeze({
    code,
    message: redactSensitiveText(message),
    ...(details !== undefined ? { details: redactSensitive(details) } : {}),
  });
}

function runtimeResult(options: {
  readonly invocationId: string;
  readonly agentName: string;
  readonly status: AgentRuntimeStatus;
  readonly steps: number;
  readonly messages: readonly AgentMessage[];
  readonly responses: readonly AgentModelResponse[];
  readonly toolResults: readonly AgentToolResult[];
  readonly finalMessage?: AgentMessage;
  readonly output?: JsonValue;
  readonly error?: AgentToolError;
  readonly metadata: JsonObject;
}): AgentRuntimeResult {
  return Object.freeze({
    invocationId: options.invocationId,
    agentName: options.agentName,
    status: options.status,
    steps: options.steps,
    messages: Object.freeze([...options.messages]),
    responses: Object.freeze([...options.responses]),
    toolResults: Object.freeze([...options.toolResults]),
    ...(options.finalMessage !== undefined ? { finalMessage: options.finalMessage } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    metadata: options.metadata,
  });
}

function timed<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  abort: () => void,
  signal?: AbortSignal,
): Promise<T> {
  // `operation` may already be running. Observe rejection before a pre-abort
  // fast path so hostile/late validators cannot escape as unhandled.
  void operation.catch(() => undefined);
  if (signal?.aborted) {
    return Promise.reject(new AgentRuntimeAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new AgentRuntimeAbortError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => finish(() => {
          reject(new AgentRuntimeTimeoutError());
          abort();
        }), timeoutMs);

    operation.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );
  });
}

function attachAbortForwarding(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (source.aborted) {
    target.abort(source.reason);
    return undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export class AgentExecutionDriver {
  private readonly toolExecutor: AgentToolExecutor;
  private readonly defaultMaxSteps: number;
  private readonly defaultMaxToolCallsPerStep: number;
  private readonly defaultModelProfile?: string;
  private readonly hasConcreteModelOption: boolean;
  readonly defaultTimeoutMs?: number;
  private readonly defaultContextLimits?: AgentContextLimits;
  private readonly contextBuilder: AgentContextBuilder;
  private readonly taskSchemaValidator?: AgentToolSchemaValidator;

  constructor(
    services: ServiceProvider,
    private readonly registry: AgentRegistry,
    private readonly modelProvider: AgentModelProvider,
    options: AgentRuntimeOptions = {},
  ) {
    assertPositiveInteger(options.maxSteps, "AgentRuntime.maxSteps");
    assertPositiveInteger(options.maxToolCallsPerStep, "AgentRuntime.maxToolCallsPerStep");
    assertNonNegativeInteger(options.timeoutMs, "AgentRuntime.timeoutMs");
    this.defaultMaxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.defaultMaxToolCallsPerStep = options.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP;
    this.defaultModelProfile = optionalText(options.modelProfile, "AgentRuntime.modelProfile");
    this.hasConcreteModelOption = options.model !== undefined;
    this.defaultTimeoutMs = options.timeoutMs === 0
      ? undefined
      : options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.defaultContextLimits = normalizeAgentContextLimits(options.contextLimits, "AgentRuntime.contextLimits");
    this.contextBuilder = options.contextBuilder ?? new DefaultAgentContextBuilder();
    this.taskSchemaValidator = options.taskSchemaValidator ?? options.toolExecutorOptions?.schemaValidator;
    this.toolExecutor = new AgentToolExecutor(services, registry, options.toolExecutorOptions);
  }

  async invoke(agentName: string, options: AgentRuntimeInvokeOptions = {}): Promise<AgentRuntimeResult> {
    const prepared = await this.prepareAgent(agentName, options);
    return prepared.ok ? this.drive(prepared.plan) : prepared.result;
  }

  async prepareSessionCheckpoint(request: AgentSessionPreparationV1): Promise<AgentSessionPreparationOutcomeV1> {
    try {
      this.assertSessionPreparation(request);
      const options: AgentRuntimeInvokeOptions = {
        id: request.invocationId,
        input: request.input,
        maxSteps: request.requested.maxSteps ?? undefined,
        maxToolCallsPerStep: request.requested.maxToolCallsPerStep ?? undefined,
        modelProfile: request.requested.modelProfile ?? undefined,
        timeoutMs: request.module.providerCallTimeoutMs,
        contextLimits: undefined,
        signal: request.signal,
      };
      const prepared = request.taskName === null
        ? await this.prepareAgent(request.agentName, options)
        : await this.prepareTask(request.agentName, request.taskName, request.input, options);
      if (!prepared.ok) return { kind: "rejected", result: prepared.result };
      const plan = "plan" in prepared ? prepared.plan : prepared.prepared.plan;
      const task = "plan" in prepared ? undefined : prepared.prepared.task;
      const maxSteps = request.requested.maxSteps ?? Math.min(task?.metadata.maxSteps ?? plan.agent.metadata.maxSteps ?? request.module.maxSessionSteps, request.module.maxSessionSteps);
      const maxToolCallsPerStep = request.requested.maxToolCallsPerStep ?? request.module.maxToolCallsPerStep;
      const runTimeoutMs = request.requested.runTimeoutMs ?? request.module.runTimeoutMs;
      const modelProfile = request.requested.modelProfile ?? task?.metadata.modelProfile ?? plan.agent.metadata.modelProfile ?? null;
      if (maxSteps > request.module.maxSessionSteps || maxToolCallsPerStep > request.module.maxToolCallsPerStep || runTimeoutMs > request.module.runTimeoutMs) {
        throw new AgentRuntimeError("AgentSession requested limits must not exceed module limits.");
      }
      return { kind: "prepared", checkpoint: this.initialCheckpoint({ ...plan, contextLimits: undefined }, {
        maxSteps, maxToolCallsPerStep, runTimeoutMs, modelProfile,
        providerTimeoutMs: request.module.providerCallTimeoutMs,
        toolDefaultTimeoutMs: request.module.toolDefaultTimeoutMs,
        scopeDisposeTimeoutMs: request.module.scopeDisposeTimeoutMs,
      }) };
    } catch (error) {
      return { kind: "rejected", result: runtimeResult({
        invocationId: request.invocationId, agentName: request.agentName, status: "failed", steps: 0,
        messages: [], responses: [], toolResults: [], metadata: Object.freeze({}),
        error: runtimeError("AGENT_RUNTIME_OPTIONS_INVALID", errorMessageOf(error)),
      }) };
    }
  }

  private assertSessionPreparation(request: AgentSessionPreparationV1): void {
    for (const [value, field] of [
      [request.module.maxSessionSteps, "AgentSession.maxSessionSteps"], [request.module.maxToolCallsPerStep, "AgentSession.maxToolCallsPerStep"],
      [request.module.runTimeoutMs, "AgentSession.runTimeoutMs"], [request.module.providerCallTimeoutMs, "AgentSession.providerCallTimeoutMs"],
      [request.module.toolDefaultTimeoutMs, "AgentSession.toolDefaultTimeoutMs"], [request.module.scopeDisposeTimeoutMs, "AgentSession.scopeDisposeTimeoutMs"],
    ] as const) assertPositiveInteger(value, field);
    for (const [value, field] of [[request.requested.maxSteps, "AgentSession.maxSteps"], [request.requested.maxToolCallsPerStep, "AgentSession.maxToolCallsPerStep"], [request.requested.runTimeoutMs, "AgentSession.runTimeoutMs"]] as const) assertPositiveInteger(value ?? undefined, field);
    if (request.taskName !== null && request.taskName.trim().length === 0) throw new AgentRuntimeError("AgentSession.taskName must be non-empty.");
  }

  private initialCheckpoint(plan: PreparedAgentPlan, resolved: {
    readonly maxSteps: number; readonly maxToolCallsPerStep: number; readonly runTimeoutMs: number; readonly modelProfile: string | null;
    readonly providerTimeoutMs: number; readonly toolDefaultTimeoutMs: number; readonly scopeDisposeTimeoutMs: number;
  }): AgentExecutionCheckpointV1 {
    const input = normalizeJsonValue(plan.options.input, "agentSession.input");
    const task = plan.taskFinalization?.task.metadata.name;
    return agentExecutionCheckpointV1({
      version: "osnv.agent-execution-state/v1",
      invocation: {
        kind: task === undefined ? "agent" : "task",
        invocationId: plan.invocationId,
        agentName: plan.agent.metadata.name,
        taskName: task ?? null,
        input,
        metadata: plan.metadata,
        options: {
          maxSteps: resolved.maxSteps,
          maxToolCallsPerStep: resolved.maxToolCallsPerStep,
          runTimeoutMs: resolved.runTimeoutMs,
          modelProfile: resolved.modelProfile,
          provider: { timeoutMs: resolved.providerTimeoutMs },
          context: {
            maxMessages: plan.contextLimits?.maxMessages ?? null,
            maxChars: plan.contextLimits?.maxChars ?? null,
            maxTokens: plan.contextLimits?.maxTokens ?? null,
          },
          output: { maxOutputTokens: null, temperature: null },
          tool: {
            defaultTimeoutMs: resolved.toolDefaultTimeoutMs,
            scopeDisposeTimeoutMs: resolved.scopeDisposeTimeoutMs,
            maxAttempts: 1,
            timeouts: plan.agent.tools
              .map((tool) => ({ name: tool.metadata.name, timeoutMs: tool.metadata.timeoutMs ?? resolved.toolDefaultTimeoutMs }))
              .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
          },
        },
      },
      phase: "ready-model",
      steps: 0,
      messages: plan.messages.map((message) => ({
        role: message.role,
        content: message.content,
        id: message.id ?? null,
        name: message.name ?? null,
        toolCallId: message.toolCallId ?? null,
        createdAtUnixMs: message.createdAtUnixMs ?? null,
        metadata: message.metadata,
      })),
      responses: [],
      toolResults: [],
      seenToolCallIds: [...plan.seenToolCallIds],
      pendingToolBatch: null,
      terminal: null,
    });
  }

  /** Rebuilds only ephemeral definitions/options after Session binding qualification. */
  private rehydratePlan(checkpoint: AgentExecutionCheckpointV1): PreparedAgentPlan {
    const agent = this.registry.getAgent(checkpoint.invocation.agentName);
    if (!agent) throw new AgentRuntimeError(`Agent "${checkpoint.invocation.agentName}" is not registered.`);
    const options = checkpoint.invocation.options;
    const maxSteps = optionPositiveInteger(options.maxSteps, "checkpoint.options.maxSteps");
    const maxToolCallsPerStep = optionPositiveInteger(options.maxToolCallsPerStep, "checkpoint.options.maxToolCallsPerStep");
    const modelProfile = optionText(options.modelProfile, "checkpoint.options.modelProfile");
    const provider = checkpointOptionObject(options.provider, "checkpoint.options.provider");
    const context = checkpointOptionObject(options.context, "checkpoint.options.context");
    const output = checkpointOptionObject(options.output, "checkpoint.options.output");
    const tool = checkpointOptionObject(options.tool, "checkpoint.options.tool");
    const providerTimeoutMs = optionPositiveInteger(provider.timeoutMs, "checkpoint.options.provider.timeoutMs");
    const contextLimits = checkpointContextLimits(context);
    const toolOptions = checkpointToolExecutionOptions(tool, agent, checkpoint.invocation.invocationId);
    const sessionToolTimeouts = checkpointToolTimeouts(tool);
    let taskFinalization: TaskFinalizationPlan | undefined;
    if (checkpoint.invocation.kind === "task") {
      const task = this.registry.getTask(agent.metadata.name, checkpoint.invocation.taskName!);
      if (!task) throw new AgentRuntimeError(`Task "${checkpoint.invocation.taskName}" is not registered on Agent "${agent.metadata.name}".`);
      taskFinalization = { task, timeoutMs: providerTimeoutMs, signal: undefined };
    }
    return {
      agent,
      invocationId: checkpoint.invocation.invocationId,
      metadata: checkpoint.invocation.metadata,
      maxSteps,
      maxToolCallsPerStep,
      timeoutMs: providerTimeoutMs,
      modelProfile,
      contextLimits,
      messages: [...checkpoint.messages],
      seenToolCallIds: new Set(checkpoint.seenToolCallIds),
      tools: this.toolContracts(agent),
      executorToolOptions: toolOptions,
      sessionToolTimeouts,
      options: {
        id: checkpoint.invocation.invocationId,
        input: checkpoint.invocation.input,
        metadata: checkpoint.invocation.metadata,
        modelProfile,
        maxOutputTokens: optionNullablePositiveInteger(output.maxOutputTokens, "checkpoint.options.output.maxOutputTokens"),
        temperature: optionNullableFiniteNonNegative(output.temperature, "checkpoint.options.output.temperature"),
        ...(taskFinalization === undefined ? {} : { output: this.taskOutputContract(taskFinalization.task) }),
      },
      taskFinalization,
    };
  }

  private async prepareAgent(agentName: string, options: AgentRuntimeInvokeOptions): Promise<AgentPreparation> {
    const invocationId = options.id ?? generatedInvocationId();
    let metadata: JsonObject;
    let maxSteps: number;
    let maxToolCallsPerStep: number;
    let timeoutMs: number | undefined;
    let modelProfile: string | undefined;
    let contextLimits: AgentContextLimits | undefined;
    try {
      metadata = normalizeMetadata(options.metadata, "agentRuntime.metadata");
      assertPositiveInteger(options.maxSteps, "agentRuntime.maxSteps");
      assertPositiveInteger(options.maxToolCallsPerStep, "agentRuntime.maxToolCallsPerStep");
      assertNonNegativeInteger(options.timeoutMs, "agentRuntime.timeoutMs");
      maxSteps = options.maxSteps ?? this.registry.getAgent(agentName)?.metadata.maxSteps ?? this.defaultMaxSteps;
      maxToolCallsPerStep = options.maxToolCallsPerStep ?? this.defaultMaxToolCallsPerStep;
      timeoutMs = options.timeoutMs === 0 ? undefined : options.timeoutMs ?? this.defaultTimeoutMs;
      modelProfile = optionalText(options.modelProfile, "agentRuntime.modelProfile");
      contextLimits = mergeAgentContextLimits(
        this.defaultContextLimits,
        normalizeAgentContextLimits(options.contextLimits, "agentRuntime.contextLimits"),
      );
      if (this.hasConcreteModelOption || options.model !== undefined) {
        throw new AgentRuntimeError("Concrete model selection is owned by Infra; use modelProfile instead.");
      }
    } catch (error) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_RUNTIME_OPTIONS_INVALID", errorMessageOf(error)), metadata: Object.freeze({}) }) };
    }

    const agent = this.registry.getAgent(agentName);
    if (!agent) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_NOT_REGISTERED", `Agent "${agentName}" is not registered.`), metadata }) };
    }

    let declaredInput: unknown = options.input;
    if (agent.metadata.input !== undefined) {
      const prepared = await this.prepareTaskContract(agent.metadata.input, options.input, "input", timeoutMs, options.signal, "agent");
      if (!prepared.ok) {
        return { ok: false, result: runtimeResult({ invocationId, agentName: agent.metadata.name, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: this.agentContractError(prepared.error, "input"), metadata }) };
      }
      declaredInput = prepared.value;
    }

    let messages: AgentMessage[];
    let seenToolCallIds: Set<string>;
    try {
      messages = this.initialMessages({ ...options, input: declaredInput });
      seenToolCallIds = this.initialToolCallIds(messages);
    } catch (error) {
      return { ok: false, result: runtimeResult({ invocationId, agentName: agent.metadata.name, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_INPUT_INVALID", errorMessageOf(error)), metadata }) };
    }

    return {
      ok: true,
      plan: {
        agent,
        invocationId,
        metadata,
        maxSteps,
        maxToolCallsPerStep,
        timeoutMs,
        modelProfile,
        contextLimits,
        messages,
        seenToolCallIds,
        tools: this.toolContracts(agent),
        executorToolOptions: this.executorToolOptions(options.toolExecution),
        options: { ...options, id: invocationId, input: declaredInput },
      },
    };
  }

  private async prepareTask(
    agentName: string,
    taskName: string,
    input: unknown,
    options: AgentRuntimeTaskInvokeOptions,
  ): Promise<TaskPreparation> {
    const invocationId = options.id ?? generatedInvocationId();
    const task = this.registry.getTask(agentName, taskName);
    if (!task) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_TASK_NOT_REGISTERED", `Task "${taskName}" is not registered on Agent "${agentName}".`), metadata: Object.freeze({ taskName }) }) };
    }

    let timeoutMs: number | undefined;
    try {
      assertNonNegativeInteger(options.timeoutMs, "agentRuntime.timeoutMs");
      timeoutMs = options.timeoutMs === 0 ? undefined : options.timeoutMs ?? this.defaultTimeoutMs;
    } catch (error) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_RUNTIME_OPTIONS_INVALID", errorMessageOf(error)), metadata: Object.freeze({ taskName }) }) };
    }

    let preparedInput: unknown = input;
    if (task.metadata.input !== undefined) {
      const prepared = await this.prepareTaskContract(task.metadata.input, input, "input", timeoutMs, options.signal, "task");
      if (!prepared.ok) {
        return { ok: false, result: runtimeResult({ invocationId, agentName: task.agent.metadata.name, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: prepared.error, metadata: Object.freeze({ taskName: task.metadata.name }) }) };
      }
      preparedInput = prepared.value;
    }

    const agent = await this.prepareAgent(task.agent.metadata.name, {
      ...options,
      id: invocationId,
      input: preparedInput,
      output: this.taskOutputContract(task) ?? options.output,
      modelProfile: options.modelProfile ?? task.metadata.modelProfile,
      maxSteps: options.maxSteps ?? task.metadata.maxSteps,
      metadata: this.taskInvocationMetadata(options.metadata, task),
    });
    if (!agent.ok) return agent;
    return {
      ok: true,
      prepared: {
        task,
        timeoutMs,
        plan: {
          ...agent.plan,
          taskFinalization: { task, timeoutMs, signal: options.signal },
        },
      },
    };
  }

  /**
   * Private durable continuation.  The Session coordinator parses persisted
   * text first and performs binding authorization before reaching this method.
   */
  async driveCheckpoint(request: AgentExecutionDriveRequestV1): Promise<AgentExecutionDriveOutcome> {
    const checkpoint = requireIssuedAgentExecutionCheckpointV1(request.checkpoint);
    if (checkpoint.phase === "terminal") throw new AgentRuntimeError("terminal Agent Session checkpoints cannot be resumed.");
    const plan = this.rehydratePlan(checkpoint);
    const outcome = await this.drivePhaseEngine(plan, checkpoint, request.boundary, request.signal, {
      evolve: evolveAgentExecutionCheckpointV1,
      boundaryError: (state) => new AgentExecutionBoundaryError(state),
    }, true);
    return outcome.kind === "terminal"
      ? { kind: "terminal", checkpoint: outcome.state, result: outcome.result }
      : { kind: "suspended", checkpoint: outcome.state, reason: outcome.reason };
  }

  private async drivePhaseEngine<TState extends EngineProgress>(
    plan: PreparedAgentPlan,
    initial: TState,
    boundary: EngineBoundary<TState>,
    signal: AbortSignal | undefined,
    bridge: PhaseBridge<TState>,
    session: boolean,
  ): Promise<EngineOutcome<TState>> {
    let checkpoint = initial;
    const suspend = (reason: string): EngineOutcome<TState> => ({ kind: "suspended", state: checkpoint, reason });
    const control = async (candidate: TState): Promise<EngineOutcome<TState> | undefined> => {
      try {
        const decision = await boundary.checkControl(checkpoint, candidate);
        if (decision.kind === "suspend") return suspend(decision.reason);
        checkpoint = candidate;
        return undefined;
      } catch {
        throw bridge.boundaryError(checkpoint);
      }
    };
    const committedControl = async (candidate: TState): Promise<EngineOutcome<TState> | undefined> => {
      checkpoint = candidate;
      try {
        const decision = await boundary.checkControl(checkpoint, checkpoint);
        return decision.kind === "suspend" ? suspend(decision.reason) : undefined;
      } catch {
        throw bridge.boundaryError(checkpoint);
      }
    };
    const terminal = (state: TState, result: AgentRuntimeResult): EngineOutcome<TState> => ({ kind: "terminal", state, result });

    for (;;) {
      if (session && signal?.aborted) return suspend("aborted");
      if (checkpoint.phase === "pending-tools") {
        const pendingControl = await control(checkpoint);
        if (pendingControl !== undefined) return pendingControl;
        const pending = checkpoint.pendingToolBatch!;
        const response = checkpoint.responses[pending.responseIndex]!;
        const call = response.toolCalls[pending.nextToolIndex]!;
        let idempotencyKey: string;
        try {
          idempotencyKey = !session
            ? this.toolIdempotencyKey(plan.options.toolExecution, { invocationId: plan.invocationId, agentName: plan.agent.metadata.name, call })
            : this.sessionIdempotencyKey(plan.invocationId, call.id);
        } catch (error) {
          if (session) throw bridge.boundaryError(checkpoint);
          const failed = bridge.evolve(checkpoint, { phase: "terminal", steps: checkpoint.steps, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults, seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined, terminal: { status: "failed", error: runtimeError("AGENT_TOOL_OPTIONS_INVALID", errorMessageOf(error)) } });
          return terminal(failed, this.resultFromCheckpoint(plan, failed));
        }
        try {
          await boundary.beforeToolDispatch(checkpoint, pending.step, pending.nextToolIndex, call, idempotencyKey);
        } catch {
          return suspend("before-tool-rejected");
        }
        const toolTimeoutMs = plan.sessionToolTimeouts?.get(call.name);
        const result = await this.toolExecutor.execute(call, {
          ...plan.executorToolOptions,
          ...(toolTimeoutMs === undefined ? {} : { timeoutMs: toolTimeoutMs }),
          agentName: plan.agent.metadata.name,
          invocationId: plan.invocationId,
          metadata: plan.metadata,
          signal,
          idempotencyKey,
        });
        const messages = [...checkpoint.messages, agentMessage("tool", agentToolResultPart(result), {
          toolCallId: call.id, metadata: { toolName: call.name },
        })];
        const toolResults = [...checkpoint.toolResults, result];
        const isUnknown = result.error?.code?.endsWith("_OUTCOME_UNKNOWN") === true;
        const nextToolIndex = pending.nextToolIndex + 1;
        const candidate = bridge.evolve(checkpoint, {
          phase: isUnknown ? "terminal" : nextToolIndex === response.toolCalls.length ? "ready-model" : "pending-tools",
          steps: checkpoint.steps,
          messages,
          responses: checkpoint.responses,
          toolResults,
          seenToolCallIds: checkpoint.seenToolCallIds,
          pendingToolBatch: isUnknown && nextToolIndex < response.toolCalls.length
            ? { ...pending, nextToolIndex }
            : nextToolIndex === response.toolCalls.length ? undefined : { ...pending, nextToolIndex },
          terminal: isUnknown ? {
            status: "failed",
            error: runtimeError("AGENT_TOOL_OUTCOME_UNKNOWN", `Tool "${call.name}" finished with an unknown retry-safe side-effect outcome; automatic model continuation is blocked.`, {
              callId: call.id, toolName: call.name, idempotencyKey, toolErrorCode: result.error?.code,
            }),
          } : undefined,
        });
        try {
          await boundary.afterToolSettlement(checkpoint, candidate, pending.step, pending.nextToolIndex, call, idempotencyKey, result);
        } catch {
          throw bridge.boundaryError(checkpoint);
        }
        const stopped = await committedControl(candidate);
        if (stopped !== undefined) return stopped;
        if (candidate.phase === "terminal") return terminal(candidate, this.resultFromCheckpoint(plan, candidate));
        continue;
      }

      if (checkpoint.steps >= plan.maxSteps) {
        const candidate = bridge.evolve(checkpoint, {
          phase: "terminal", steps: checkpoint.steps, messages: checkpoint.messages, responses: checkpoint.responses,
          toolResults: checkpoint.toolResults, seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined,
          terminal: { status: "failed", error: runtimeError("AGENT_MAX_STEPS_EXCEEDED", `Agent "${plan.agent.metadata.name}" exceeded maxSteps (${plan.maxSteps}).`, { maxSteps: plan.maxSteps }) },
        });
        const stopped = await control(candidate);
        return stopped ?? terminal(candidate, this.resultFromCheckpoint(plan, candidate));
      }

      const step = checkpoint.steps + 1;
      const readyControl = await control(checkpoint);
      if (readyControl !== undefined) return readyControl;
      let modelRequest: AgentModelRequest;
      try {
        const context = this.contextBuilder.build({ invocationId: plan.invocationId, agent: plan.agent, messages: checkpoint.messages, metadata: plan.metadata, limits: plan.contextLimits });
        modelRequest = agentModelRequest({
          invocationId: plan.invocationId, messages: context.messages, tools: plan.tools,
          output: this.providerOutputContract(plan.agent.metadata.output === undefined ? plan.options.output : this.agentOutputContract(plan.agent)),
          modelProfile: plan.modelProfile,
          maxOutputTokens: plan.options.maxOutputTokens, temperature: plan.options.temperature,
          metadata: { ...plan.metadata, agentName: plan.agent.metadata.name, step, modelProfile: plan.modelProfile ?? null, agentContext: context.metadata },
        });
      } catch (error) {
        const candidate = bridge.evolve(checkpoint, {
          phase: "terminal", steps: step, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
          seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined,
          terminal: { status: "failed", error: runtimeError("AGENT_CONTEXT_INVALID", errorMessageOf(error)) },
        });
        const stopped = await control(candidate);
        return stopped ?? terminal(candidate, this.resultFromCheckpoint(plan, candidate));
      }
      try {
        await boundary.beforeModelDispatch(checkpoint, step, modelRequest);
      } catch {
        return suspend("before-model-rejected");
      }
      const response = await this.completeModel(modelRequest, plan.agent.metadata.name, plan.modelProfile, plan.metadata, signal, plan.timeoutMs,
        plan.options.onTextDelta ? text => plan.options.onTextDelta!(Object.freeze({ step, text })) : undefined);
      if (!response.ok) {
        const candidate = bridge.evolve(checkpoint, {
          phase: "terminal", steps: step, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
          seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined, terminal: { status: "failed", error: response.error },
        });
        try { await boundary.afterModelSettlement(checkpoint, candidate, step, { error: response.error }); } catch { throw bridge.boundaryError(checkpoint); }
        const stopped = await committedControl(candidate);
        return stopped ?? terminal(candidate, this.resultFromCheckpoint(plan, candidate));
      }
      const candidate = await this.modelCandidate(plan, checkpoint, step, response.value, signal, bridge);
      try { await boundary.afterModelSettlement(checkpoint, candidate.state, step, { response: response.value }); } catch { throw bridge.boundaryError(checkpoint); }
      const stopped = await committedControl(candidate.state);
      if (stopped !== undefined) return stopped;
      if (candidate.state.phase === "terminal") return terminal(candidate.state, candidate.result ?? this.resultFromCheckpoint(plan, candidate.state));
    }
  }

  private sessionIdempotencyKey(invocationId: string, callId: string): string {
    return `agent:${invocationId.length}:${invocationId}:${callId.length}:${callId}`;
  }

  private resultFromCheckpoint(plan: PreparedAgentPlan, checkpoint: EngineProgress): AgentRuntimeResult {
    const terminal = checkpoint.terminal;
    if (terminal === undefined) throw new AgentRuntimeError("terminal checkpoint is required.");
    return runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.metadata.name, status: terminal.status,
      steps: checkpoint.steps, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
      finalMessage: terminal.finalMessage, output: terminal.output, error: terminal.error, metadata: plan.metadata });
  }

  private async modelCandidate<TState extends EngineProgress>(
    plan: PreparedAgentPlan, checkpoint: TState, step: number, response: AgentModelResponse, signal: AbortSignal | undefined, bridge: PhaseBridge<TState>,
  ): Promise<{ readonly state: TState; readonly result?: AgentRuntimeResult }> {
    const rejected = (code: string, message: string, retainResponse = true): { readonly state: TState; readonly result: AgentRuntimeResult } => {
      const state = bridge.evolve(checkpoint, { phase: "terminal", steps: step, messages: checkpoint.messages,
        responses: retainResponse ? [...checkpoint.responses, response] : checkpoint.responses, toolResults: checkpoint.toolResults, seenToolCallIds: checkpoint.seenToolCallIds,
        pendingToolBatch: undefined, terminal: { status: "failed", error: runtimeError(code, message) } });
      return { state, result: this.resultFromCheckpoint(plan, state) };
    };
    if (response.invocationId !== plan.invocationId) return rejected("AGENT_PROVIDER_RESPONSE_INVALID", "Model provider returned a response for another invocation.", false);
    if (response.toolCalls.length > plan.maxToolCallsPerStep) return rejected("AGENT_TOOL_CALL_LIMIT_EXCEEDED", `Model requested ${response.toolCalls.length} tool calls; the per-step limit is ${plan.maxToolCallsPerStep}.`);
    const seen = new Set(checkpoint.seenToolCallIds);
    for (const call of response.toolCalls) { if (seen.has(call.id)) return rejected("AGENT_PROVIDER_RESPONSE_INVALID", `Model provider reused tool call id "${call.id}" within one invocation.`); seen.add(call.id); }
    const message = responseMessage(response);
    if (response.toolCalls.length > 0 && message !== undefined && message.role !== "assistant") return rejected("AGENT_PROVIDER_RESPONSE_INVALID", "A response with tool calls must use an assistant message.");
    if (response.toolCalls.length > 0) {
      const assistant = agentMessage("assistant", [...(message?.content ?? []), ...response.toolCalls.map(agentToolCallPart)], message === undefined ? {} : { id: message.id, name: message.name, createdAtUnixMs: message.createdAtUnixMs, metadata: message.metadata });
      const state = bridge.evolve(checkpoint, { phase: "pending-tools", steps: step, messages: [...checkpoint.messages, assistant], responses: [...checkpoint.responses, response], toolResults: checkpoint.toolResults, seenToolCallIds: [...seen], pendingToolBatch: { step, responseIndex: checkpoint.responses.length, assistantMessageIndex: checkpoint.messages.length, nextToolIndex: 0 }, terminal: undefined });
      return { state };
    }
    const messages = message === undefined ? checkpoint.messages : [...checkpoint.messages, message];
    let result: AgentRuntimeResult;
    if (response.finishReason !== "stop" || message === undefined) {
      result = runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.metadata.name, status: "failed", steps: step, messages, responses: [...checkpoint.responses, response], toolResults: checkpoint.toolResults, finalMessage: message, metadata: plan.metadata,
        error: runtimeError("AGENT_PROVIDER_STOPPED", `Model provider stopped with finishReason "${response.finishReason}".`) });
    } else {
      result = runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.metadata.name, status: "completed", steps: step, messages, responses: [...checkpoint.responses, response], toolResults: checkpoint.toolResults, finalMessage: message, metadata: plan.metadata });
      if (plan.agent.metadata.output !== undefined) {
        try {
          const output = this.parseTaskOutput(message);
          const prepared = await this.prepareTaskContract(plan.agent.metadata.output, output, "output", plan.timeoutMs, signal, "agent");
          result = prepared.ok
            ? runtimeResult({ ...result, output: prepared.value })
            : this.failedTaskResult(result, this.agentContractError(prepared.error, "output"));
        } catch (error) {
          result = this.failedTaskResult(result, runtimeError("AGENT_OUTPUT_INVALID", errorMessageOf(error)));
        }
      }
      if (plan.agent.metadata.output === undefined && plan.taskFinalization?.task.metadata.output === undefined && plan.options.output?.mode === "json") {
        result = this.validateExplicitOutput(result, plan.options.output);
      }
      if (result.status === "completed") result = await this.finalizeCompleted(plan, result, signal);
    }
    const state = bridge.evolve(checkpoint, { phase: "terminal", steps: step, messages: result.messages, responses: result.responses, toolResults: result.toolResults, seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined,
      terminal: result.status === "completed" ? { status: "completed", finalMessage: result.finalMessage, output: result.output } : { status: "failed", finalMessage: result.finalMessage, error: result.error! } });
    return { state, result };
  }

  private validateExplicitOutput(result: AgentRuntimeResult, contract: AgentOutputContract): AgentRuntimeResult {
    try {
      const output = normalizeJsonValue(this.parseTaskOutput(result.finalMessage), "agent.output");
      const declared = contract.schema;
      if (declared !== undefined) {
        const generated = declared.kind === "class" ? getGeneratedOpenApiMetadata().schemas[declared.name] : undefined;
        if (declared.kind === "class" && generated === undefined) {
          return this.failedTaskResult(result, runtimeError("AGENT_OUTPUT_SCHEMA_UNAVAILABLE", `Output class "${declared.name}" has no generated JSON schema.`));
        }
        const schema = declared.kind === "json-schema" ? declared.schema : inlineGeneratedSchema(generated, getGeneratedOpenApiMetadata().schemas);
        const issues = validateAgentJsonSchema(output, schema);
        if (issues.length > 0) return this.failedTaskResult(result, runtimeError("AGENT_OUTPUT_INVALID", "Agent output failed JSON Schema validation.", { schema: declared.name, issues }));
      }
      return runtimeResult({ ...result, output });
    } catch (error) {
      return this.failedTaskResult(result, runtimeError("AGENT_OUTPUT_INVALID", errorMessageOf(error)));
    }
  }

  private async drive(plan: PreparedAgentPlan): Promise<AgentRuntimeResult> {
    const initial: InMemoryExecutionState = Object.freeze({
      phase: "ready-model", steps: 0, messages: Object.freeze([...plan.messages]), responses: Object.freeze([]), toolResults: Object.freeze([]), seenToolCallIds: Object.freeze([...plan.seenToolCallIds]),
    });
    const inMemoryBoundary: EngineBoundary<InMemoryExecutionState> = {
      async checkControl() { return { kind: "continue" }; }, async beforeModelDispatch() {}, async afterModelSettlement() {}, async beforeToolDispatch() {}, async afterToolSettlement() {},
    };
    const inMemoryBridge: PhaseBridge<InMemoryExecutionState> = {
      evolve(previous, progress) { return Object.freeze({ ...previous, ...progress }); },
      boundaryError() { return new AgentRuntimeError("in-memory execution boundary rejected a transition."); },
    };
    const resolvedPlan = { ...plan, modelProfile: plan.modelProfile ?? plan.agent.metadata.modelProfile ?? this.defaultModelProfile };
    const outcome = await this.drivePhaseEngine(resolvedPlan, initial, inMemoryBoundary, plan.options.signal, inMemoryBridge, false);
    if (outcome.kind === "terminal") return outcome.result;
    throw new AgentRuntimeError("in-memory execution cannot suspend.");
  }
  async invokeTask(
    agentName: string,
    taskName: string,
    input: unknown,
    options: AgentRuntimeTaskInvokeOptions = {},
  ): Promise<AgentRuntimeResult> {
    const preparation = await this.prepareTask(agentName, taskName, input, options);
    if (!preparation.ok) return preparation.result;
    return this.drive(preparation.prepared.plan);
  }

  private async prepareTaskContract(
    contract: Class<object>,
    value: unknown,
    direction: "input" | "output",
    timeoutMs?: number,
    signal?: AbortSignal,
    contractKind: "agent" | "task" = "task",
  ): Promise<PreparedTaskContract> {
    if (signal?.aborted) {
      return { ok: false, error: runtimeError("AGENT_ABORTED", "Agent runtime invocation was aborted.") };
    }
    try {
      value = value instanceof contract
        ? agentModelJson(value, `task.${direction}`)
        : normalizeJsonValue(value, `task.${direction}`);
    } catch (error) {
      return { ok: false, error: runtimeError(direction === "input" ? "AGENT_TASK_INPUT_INVALID" : "AGENT_TASK_OUTPUT_INVALID", errorMessageOf(error)) };
    }
    const name = getGeneratedOpenApiSchemaName(contract) ?? classDebugName(contract);
    if (!isObjectRecord(value)) {
      return {
        ok: false,
        error: runtimeError(
          contractKind === "agent"
            ? direction === "input" ? "AGENT_INPUT_INVALID" : "AGENT_OUTPUT_INVALID"
            : direction === "input" ? "AGENT_TASK_INPUT_INVALID" : "AGENT_TASK_OUTPUT_INVALID",
          `${contractKind === "agent" ? "Agent" : "Task"} ${direction} schema "${name}" expects a JSON object.`,
        ),
      };
    }

    const generated = getGeneratedOpenApiMetadata().schemas[name];
    if (generated === undefined && this.taskSchemaValidator === undefined) {
      return {
        ok: false,
        error: runtimeError(
          "AGENT_TASK_SCHEMA_VALIDATOR_MISSING",
          `Task ${direction} schema "${name}" has no generated JSON schema or configured validator.`,
        ),
      };
    }
    if (generated !== undefined) {
      const issues = validateAgentJsonSchema(value, inlineGeneratedSchema(generated, getGeneratedOpenApiMetadata().schemas));
      if (issues.length > 0) {
        return {
          ok: false,
          error: runtimeError(
            direction === "input" ? "AGENT_TASK_INPUT_VALIDATION_FAILED" : "AGENT_TASK_OUTPUT_VALIDATION_FAILED",
            `Task ${direction} failed generated schema validation.`,
            { schema: name, issues },
          ),
        };
      }
    }

    let instance: object;
    try {
      instance = bindAgentModel(contract, value);
    } catch (error) {
      return {
        ok: false,
        error: runtimeError(
          direction === "input" ? "AGENT_TASK_INPUT_INVALID" : "AGENT_TASK_OUTPUT_INVALID",
          errorMessageOf(error),
        ),
      };
    }

    if (this.taskSchemaValidator !== undefined) {
      try {
        const validation = await timed(
          Promise.resolve(this.taskSchemaValidator.validate(instance)),
          timeoutMs,
          () => undefined,
          signal,
        );
        if (!validation || typeof validation.isValid !== "boolean" || !Array.isArray(validation.errors)) {
          throw new AgentRuntimeError("task schema validator returned an invalid result.");
        }
        if (!validation.isValid) {
          return {
            ok: false,
            error: runtimeError(
              direction === "input" ? "AGENT_TASK_INPUT_VALIDATION_FAILED" : "AGENT_TASK_OUTPUT_VALIDATION_FAILED",
              `Task ${direction} failed model validation.`,
              {
                schema: name,
                issues: validation.errors.map((issue) => ({
                  property: String(issue.property),
                  message: String(issue.message),
                  ...(issue.code !== undefined ? { code: String(issue.code) } : {}),
                })),
              },
            ),
          };
        }
      } catch (error) {
        if (error instanceof AgentRuntimeTimeoutError) {
          return {
            ok: false,
            error: runtimeError("AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT", `Task ${direction} schema validation timed out.`, { schema: name }),
          };
        }
        if (error instanceof AgentRuntimeAbortError) {
          return { ok: false, error: runtimeError("AGENT_ABORTED", "Agent runtime invocation was aborted.") };
        }
        return {
          ok: false,
          error: runtimeError(
            "AGENT_TASK_SCHEMA_VALIDATION_FAILED",
            `Task ${direction} schema validation failed: ${errorMessageOf(error)}`,
            { schema: name },
          ),
        };
      }
    }

    try {
      return { ok: true, instance, value: agentModelJson(instance, `task.${direction}`) };
    } catch (error) {
      return {
        ok: false,
        error: runtimeError(
          direction === "input" ? "AGENT_TASK_INPUT_INVALID" : "AGENT_TASK_OUTPUT_INVALID",
          errorMessageOf(error),
        ),
      };
    }
  }

  private parseTaskOutput(message: AgentMessage | undefined): unknown {
    if (message === undefined) {
      throw new AgentRuntimeError("Task provider response does not contain a final message.");
    }
    if (message.content.length === 1 && message.content[0]?.kind === "data") {
      return message.content[0].value;
    }
    if (!message.content.every((part) => part.kind === "text")) {
      throw new AgentRuntimeError("Task JSON output must contain only text or one data part.");
    }
    const text = message.content.map((part) => part.kind === "text" ? part.text : "").join("\n").trim();
    if (text.length === 0) {
      throw new AgentRuntimeError("Task JSON output is empty.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AgentRuntimeError("Task JSON output is malformed.");
    }
  }

  private failedTaskResult(result: AgentRuntimeResult, error: AgentToolError): AgentRuntimeResult {
    return runtimeResult({
      invocationId: result.invocationId,
      agentName: result.agentName,
      status: "failed",
      steps: result.steps,
      messages: result.messages,
      responses: result.responses,
      toolResults: result.toolResults,
      finalMessage: result.finalMessage,
      error,
      metadata: result.metadata,
    });
  }

  private async finalizeCompleted(plan: PreparedAgentPlan, result: AgentRuntimeResult, currentSignal?: AbortSignal): Promise<AgentRuntimeResult> {
    const finalization = plan.taskFinalization;
    if (finalization === undefined || finalization.task.metadata.output === undefined) {
      return result;
    }
    let outputValue: unknown;
    try {
      outputValue = this.parseTaskOutput(result.finalMessage);
    } catch (error) {
      return this.failedTaskResult(result, runtimeError("AGENT_TASK_OUTPUT_INVALID", errorMessageOf(error)));
    }
    const preparedOutput = await this.prepareTaskContract(
      finalization.task.metadata.output,
      outputValue,
      "output",
      finalization.timeoutMs,
      currentSignal,
      "task",
    );
    if (!preparedOutput.ok) {
      return this.failedTaskResult(result, preparedOutput.error);
    }
    return runtimeResult({
      invocationId: result.invocationId,
      agentName: result.agentName,
      status: "completed",
      steps: result.steps,
      messages: result.messages,
      responses: result.responses,
      toolResults: result.toolResults,
      finalMessage: result.finalMessage,
      output: preparedOutput.value,
      metadata: result.metadata,
    });
  }

  private agentContractError(error: AgentToolError, direction: "input" | "output"): AgentToolError {
    if (error.code === "AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT" || error.code === "AGENT_ABORTED") return error;
    return runtimeError(direction === "input" ? "AGENT_INPUT_INVALID" : "AGENT_OUTPUT_INVALID", error.message, error.details);
  }

  private initialMessages(options: AgentRuntimeInvokeOptions): AgentMessage[] {
    const messages: AgentMessage[] = [];
    if (options.messages !== undefined) {
      messages.push(...options.messages);
    }
    if (options.input !== undefined) {
      messages.push(this.inputMessage(options.input));
    }
    if (messages.length === 0) {
      throw new AgentRuntimeError("agent invocation requires input or messages.");
    }
    return messages;
  }

  private initialToolCallIds(messages: readonly AgentMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const part of message.content) {
        if (part.kind !== "tool-call") continue;
        if (ids.has(part.call.id)) {
          throw new AgentRuntimeError(`agent invocation messages contain duplicate tool call id "${part.call.id}".`);
        }
        ids.add(part.call.id);
      }
    }
    return ids;
  }

  private toolIdempotencyKey(
    options: AgentRuntimeToolExecutionOptions | undefined,
    context: AgentRuntimeToolCallContext,
  ): string {
    const custom = options?.idempotencyKeyForCall?.(context);
    if (custom !== undefined) {
      const normalized = optionalText(custom, "agentRuntime.toolExecution.idempotencyKeyForCall");
      return normalized as string;
    }
    const prefix = optionalText(options?.idempotencyKey, "agentRuntime.toolExecution.idempotencyKey")
      ?? context.invocationId;
    return `agent:${prefix.length}:${prefix}:${context.call.id.length}:${context.call.id}`;
  }

  private executorToolOptions(options: AgentRuntimeToolExecutionOptions | undefined): AgentToolExecutionOptions {
    if (options === undefined) return {};
    const { idempotencyKey: _prefix, idempotencyKeyForCall: _builder, ...executorOptions } = options;
    return executorOptions;
  }

  private inputMessage(input: unknown): AgentMessage {
    if (typeof input === "string") {
      return agentMessage("user", input);
    }
    return agentMessage("user", agentData(input, { name: "input" }));
  }

  private toolContracts(agent: AgentDefinition): readonly ReturnType<typeof agentToolContract>[] {
    return Object.freeze(agent.tools.map(describeTool));
  }

  private providerOutputContract(output: AgentOutputContract | undefined): AgentOutputContract | undefined {
    if (output?.schema?.kind !== "class") return output;
    const schemas = getGeneratedOpenApiMetadata().schemas;
    const generated = schemas[output.schema.name];
    if (generated === undefined) return output;
    return agentOutputContract({ ...output, schema: agentJsonSchema(output.schema.name, inlineGeneratedSchema(generated, schemas), { strict: output.schema.strict }) });
  }

  private taskOutputContract(task: AgentTaskDefinition): AgentOutputContract | undefined {
    if (task.metadata.output === undefined) {
      return undefined;
    }
    return agentOutputContract({
      mode: "json",
      schema: this.schemaContract(task.metadata.output),
    });
  }

  private agentOutputContract(agent: AgentDefinition): AgentOutputContract | undefined {
    if (agent.metadata.output === undefined) {
      return undefined;
    }
    return agentOutputContract({ mode: "json", schema: this.schemaContract(agent.metadata.output) });
  }

  private schemaContract(model: NonNullable<ToolDefinition["metadata"]["input"]>) {
    const name = getGeneratedOpenApiSchemaName(model) ?? classDebugName(model);
    const schemas = getGeneratedOpenApiMetadata().schemas;
    const generated = schemas[name];
    if (generated === undefined) {
      return agentClassSchema(name);
    }
    return agentJsonSchema(name, inlineGeneratedSchema(generated, schemas) as JsonObject);
  }

  private taskInvocationMetadata(metadata: unknown, task: AgentTaskDefinition): unknown {
    const taskMetadata = {
      taskName: task.metadata.name,
      taskMethodName: task.metadata.methodName,
    };
    if (metadata === undefined) {
      return taskMetadata;
    }
    if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      return { ...(metadata as Record<string, unknown>), ...taskMetadata };
    }
    return metadata;
  }

  private async completeModel(
    request: AgentModelRequest,
    agentName: string,
    modelProfile: string | undefined,
    metadata: JsonObject,
    sourceSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    onTextDelta?: (text: string) => void,
  ): Promise<{ readonly ok: true; readonly value: AgentModelResponse } | { readonly ok: false; readonly error: AgentToolError }> {
    const abortController = new AbortController();
    const detach = attachAbortForwarding(sourceSignal, abortController);
    let acceptingText = true;
    const context: AgentModelProviderContext = Object.freeze({
      invocationId: request.invocationId,
      agentName,
      ...(modelProfile !== undefined ? { modelProfile } : {}),
      metadata,
      signal: abortController.signal,
      ...(onTextDelta ? { onTextDelta: (text: string) => {
        if (!acceptingText || abortController.signal.aborted) return;
        if (typeof text !== "string") throw new AgentRuntimeError("Model text delta must be a string.");
        if (text) onTextDelta(text);
      } } : {}),
    });

    try {
      if (abortController.signal.aborted) {
        throw new AgentRuntimeAbortError();
      }
      const rawResponse = await timed(
        Promise.resolve(this.modelProvider.complete(request, context)),
        timeoutMs,
        () => abortController.abort(),
        abortController.signal,
      );
      try {
        return { ok: true, value: normalizeProviderResponse(rawResponse) };
      } catch (error) {
        return {
          ok: false,
          error: runtimeError("AGENT_PROVIDER_RESPONSE_INVALID", `Model provider returned an invalid response: ${errorMessageOf(error)}`),
        };
      }
    } catch (error) {
      const code = error instanceof AgentRuntimeTimeoutError
        ? "AGENT_PROVIDER_TIMEOUT"
        : error instanceof AgentRuntimeAbortError
          ? "AGENT_ABORTED"
          : "AGENT_PROVIDER_FAILED";
      return { ok: false, error: runtimeError(code, errorMessageOf(error)) };
    } finally {
      acceptingText = false;
      detach?.();
    }
  }
}
