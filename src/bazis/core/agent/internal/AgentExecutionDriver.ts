import { inlineGeneratedSchema } from "./Schema.contract";
import { describeTool } from "../Tool.contract";
import type { ServiceProvider } from "../../di";
import { getGeneratedOpenApiMetadata } from "../../http/OpenApi/generatedOpenApiRegistry";
import { redactSensitive, redactSensitiveText } from "../../../library/redaction";
import type { Logger } from "../../kernel/logging/Logger";
import { AgentModelContextOverflowError, AgentModelTimeoutError, AgentModelUnavailableError, AgentRuntimeError } from "../errors";
import { validateAgentJsonSchema } from "./AgentJsonSchema";
import type { AgentDefinition, AgentRegistry } from "../AgentRegistry";
import {
  ApproximateAgentContextTokenEstimator,
  DefaultAgentContextBuilder,
  mergeAgentContextLimits,
  normalizeAgentContextLimits,
  type AgentContext,
  type AgentContextBuilder,
  type AgentContextLimits,
} from "../AgentContextBuilder";
import {
  AgentToolExecutor,
  type AgentToolExecutionOptions,
  type AgentToolExecutorOptions,
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
  type AgentUsage,
  type JsonObject,
  type JsonValue,
} from "../semantic";

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 16;
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL_ATTEMPTS = 3;
const DEFAULT_MODEL_RETRY_DELAY_MS = 500;
const DEFAULT_MODEL_RETRY_MAX_DELAY_MS = 20_000;
const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 3;
const DEFAULT_MAX_OUTPUT_REPAIRS = 2;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;

/** `message.metadata.runtime` of the messages the runtime writes itself. */
const RUNTIME_CONTINUE = "continue-output";
const RUNTIME_REPAIR = "repair-output";
const CONTINUE_TEXT = "Your previous message was cut off by the output limit. Continue exactly where it stopped: do not repeat, apologize or summarize what is already written.";

/**
 * What happens during a run, in the order it happens: for a progress line, a
 * chat that shows the agent at work, a trace. Every event names its run.
 */
export type AgentRunEvent =
  | AgentStepStartedEvent
  | AgentTextDeltaEvent
  | AgentModelRetryEvent
  | AgentModelAnsweredEvent
  | AgentToolStartedEvent
  | AgentToolFinishedEvent
  | AgentCompactedEvent
  | AgentRunFinishedEvent;

/** The model is asked for its next answer. */
export interface AgentStepStartedEvent { readonly kind: "step-started"; readonly invocationId: string; readonly step: number; }
/** A piece of the answer as the model writes it. Provisional: the answer is not checked yet. */
export interface AgentTextDeltaEvent { readonly kind: "text-delta"; readonly invocationId: string; readonly step: number; readonly text: string; }
/** The provider could not serve the request right now; it is sent again after `delayMs`. */
export interface AgentModelRetryEvent { readonly kind: "model-retry"; readonly invocationId: string; readonly step: number; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number; }
/** The model answered: its message, the Tools it wants to call, the usage of this call. */
export interface AgentModelAnsweredEvent {
  readonly kind: "model-answered"; readonly invocationId: string; readonly step: number;
  readonly message?: AgentMessage; readonly toolCalls: AgentModelResponse["toolCalls"];
  readonly finishReason: AgentModelResponse["finishReason"]; readonly usage?: AgentUsage;
}
/** A Tool call is handed to the Tool executor: approval, audit and the Tool itself follow. */
export interface AgentToolStartedEvent { readonly kind: "tool-started"; readonly invocationId: string; readonly step: number; readonly call: AgentModelResponse["toolCalls"][number]; }
/** A Tool call ended: its result is what the model gets. */
export interface AgentToolFinishedEvent { readonly kind: "tool-finished"; readonly invocationId: string; readonly step: number; readonly result: AgentToolResult; }
/** The older part of the dialog was replaced by a summary. */
export interface AgentCompactedEvent { readonly kind: "compacted"; readonly invocationId: string; readonly reason: "size" | "overflow"; readonly messages: number; }
/** The run ended; `result` is what `run` returns. Always the last event. */
export interface AgentRunFinishedEvent { readonly kind: "finished"; readonly invocationId: string; readonly result: AgentRuntimeResult; }

/** How a model request that the provider could not serve right now is repeated. */
export interface AgentModelRetryPolicy {
  /** How many times one model request is sent, the first one included. 3 by default; 1 turns repeats off. */
  readonly maxAttempts?: number;
  /** The wait before the second attempt, doubled before each next one. 500 ms by default. */
  readonly delayMs?: number;
  /** The longest single wait, a provider's `Retry-After` included. 20 seconds by default. */
  readonly maxDelayMs?: number;
}

/** `message.metadata.runtime` of the message that stands for the compacted part of a dialog. */
const RUNTIME_SUMMARY = "summary";
/** Compaction starts at this share of the model's context window, leaving room for the answer. */
const COMPACTION_WINDOW_SHARE = 0.8;
const SUMMARY_PREFIX = "Summary of the earlier part of this conversation (the original messages were replaced by it):";
const SUMMARY_INSTRUCTIONS = [
  "You summarize a conversation between a user and an AI assistant that uses tools, so that the assistant can continue the work without the original messages.",
  "Keep everything needed to continue:",
  "1. What the user asked for and wants: every request, in the user's own words where the wording matters.",
  "2. Facts, names, identifiers, numbers and results obtained from tools that may be needed later.",
  "3. What has been done and decided, and why.",
  "4. What is in progress and what remains to be done.",
  "5. Constraints, preferences and corrections the user gave.",
  "Write plainly, in the language of the conversation. Do not invent anything, do not address the user, do not call tools. Output only the summary.",
].join("\n");

/** When and how the older part of a long dialog is replaced by a summary. */
export interface AgentCompactionOptions {
  /**
   * The dialog size, in tokens, above which the older part is summarized.
   * By default 80% of the model's context window, when the LLM connector
   * states it (`contextTokens`); without both, only a provider's refusal of a
   * request as too long starts compaction.
   */
  readonly maxTokens?: number;
  /** How much of the newest dialog stays as written, in tokens. A quarter of `maxTokens` by default. */
  readonly keepTokens?: number;
  /** The model profile that writes the summary; the run's own by default. */
  readonly modelProfile?: string;
  /** Instructions for the summary instead of the built-in ones. */
  readonly instructions?: string;
}

interface ModelRetrySettings {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly maxDelayMs: number;
}

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
  /** Provider-call timeout. Defaults to 60 seconds; 0 explicitly disables it. */
  readonly timeoutMs?: number;
  /** The deadline of a whole run: every model call, Tool call and wait. No deadline by default. */
  readonly runTimeoutMs?: number;
  /** Repeats of a model request the provider could not serve right now (429, 5xx, a broken connection). */
  readonly modelRetry?: AgentModelRetryPolicy;
  /**
   * How many times the model is asked to go on when the output limit cut its
   * text answer (`finishReason: "length"`). 3 by default; 0 fails the run at once.
   */
  readonly maxOutputContinuations?: number;
  /**
   * How many times the model is asked to correct a structured answer that is
   * not valid JSON or does not match the schema. 2 by default; 0 fails the run at once.
   */
  readonly maxOutputRepairs?: number;
  /**
   * How many Tools of one model step run at the same time. Only Tools with
   * `sideEffect: "none"` or `"read"` standing next to each other run together;
   * `write` and `external` always run one by one, in the order the model wrote
   * them. 8 by default; 1 runs every Tool one by one.
   */
  readonly maxParallelToolCalls?: number;
  /**
   * Compaction of a long dialog: its older part is replaced by a summary the
   * model writes, the newest messages stay as written. On by default;
   * `false` turns it off, and a dialog that does not fit then fails the run.
   */
  readonly compaction?: AgentCompactionOptions | false;
  readonly contextBuilder?: AgentContextBuilder;
  readonly contextLimits?: AgentContextLimits;
  /**
   * Where failures of the model and unexpected tool failures go, with their
   * stack. The LLM connectors pass the application logger.
   */
  readonly logger?: Logger;
}

/**
 * @internal The driver also takes the Tool execution settings; `AgentRuntime`
 * reads them from `TOOL_EXECUTION_OPTIONS`, shared with `ToolRunner`.
 */
export interface AgentExecutionDriverOptions extends AgentRuntimeOptions {
  readonly toolExecutorOptions?: AgentToolExecutorOptions;
  /** Real tokens per estimated token, by model profile: one map for every run of a runtime. */
  readonly tokenScales?: Map<string, number>;
}

export interface AgentRuntimeInvokeOptions {
  readonly id?: string;
  readonly input?: unknown;
  readonly messages?: readonly AgentMessage[];
  /** Structured result: `{ mode: "json", schema }` makes `result.output` the validated value. */
  readonly output?: AgentOutputContract;
  readonly metadata?: unknown;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
  readonly maxToolCallsPerStep?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Per-provider-call timeout override; 0 explicitly disables it. */
  readonly timeoutMs?: number;
  /** The deadline of this whole run instead of the runtime's; 0 explicitly disables it. */
  readonly runTimeoutMs?: number;
  /** Compaction settings of this run over the runtime's; `false` keeps the dialog as written. */
  readonly compaction?: AgentCompactionOptions | false;
  readonly contextLimits?: AgentContextLimits;
  readonly signal?: AbortSignal;
  readonly toolExecution?: AgentRuntimeToolExecutionOptions;
  /** Ephemeral, provisional text; never persisted/replayed as a checkpoint or accepted output. */
  readonly onTextDelta?: (event: { readonly step: number; readonly text: string }) => void;
  /**
   * Watches the run as it goes: steps, text, Tool calls and their results,
   * repeats, compaction, the end. Synchronous; an exception it throws is
   * logged and does not stop the run. `AgentRuntime.stream` gives the same
   * events as an async iterator.
   */
  readonly onEvent?: (event: AgentRunEvent) => void;
}

export interface AgentRuntimeResult {
  readonly invocationId: string;
  readonly agentName: string;
  readonly status: AgentRuntimeStatus;
  readonly steps: number;
  readonly messages: readonly AgentMessage[];
  readonly responses: readonly AgentModelResponse[];
  readonly toolResults: readonly AgentToolResult[];
  readonly finalMessage?: AgentMessage;
  /** Validated structured value when `output` requested JSON. */
  readonly output?: JsonValue;
  /** The sum over every model call of the run, summaries included, when the provider reports usage. */
  readonly usage?: AgentUsage;
  /**
   * How many times the older part of the dialog was replaced by a summary
   * during this run. `messages` then start with the summary, a user message
   * with `metadata.runtime: "summary"`, not with the original dialog.
   */
  readonly compactions?: number;
  readonly error?: AgentToolError;
  readonly metadata: JsonObject;
}

type PreparedAgentPlan = {
  readonly agent: AgentDefinition;
  readonly invocationId: string;
  readonly metadata: JsonObject;
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly timeoutMs: number | undefined;
  readonly runTimeoutMs: number | undefined;
  readonly modelRetry: ModelRetrySettings;
  readonly maxOutputContinuations: number;
  readonly maxOutputRepairs: number;
  readonly maxParallelToolCalls: number;
  /** `undefined`: the dialog is never compacted. */
  readonly compaction: AgentCompactionOptions | undefined;
  /** What the run did besides its steps; filled while it runs. */
  readonly side: { readonly usage: AgentUsage[]; compactions: number };
  readonly modelProfile: string | undefined;
  readonly contextLimits: AgentContextLimits | undefined;
  readonly messages: AgentMessage[];
  readonly seenToolCallIds: Set<string>;
  readonly tools: readonly AgentToolContract[];
  readonly executorToolOptions: AgentToolExecutionOptions;
  readonly sessionToolTimeouts?: ReadonlyMap<string, number>;
  readonly options: AgentRuntimeInvokeOptions;
};

type AgentPreparation =
  | { readonly ok: true; readonly plan: PreparedAgentPlan }
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
      inputError: call.inputError as string | undefined,
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

/** The sum of what the provider reported for every model call. */
function totalUsage(usages: readonly (AgentUsage | undefined)[]): AgentUsage | undefined {
  const total: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; latencyMs?: number } = {};
  let amount: number | undefined;
  let currency: string | undefined;
  let mixedCurrency = false;
  let reported = false;
  for (const usage of usages) {
    if (usage === undefined) continue;
    reported = true;
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "latencyMs"] as const) {
      if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field];
    }
    if (usage.cost !== undefined) {
      if (currency !== undefined && currency !== usage.cost.currency) mixedCurrency = true;
      currency = usage.cost.currency;
      amount = (amount ?? 0) + usage.cost.amount;
    }
  }
  if (!reported) return undefined;
  return Object.freeze({
    ...total,
    ...(amount !== undefined && currency !== undefined && !mixedCurrency ? { cost: Object.freeze({ amount, currency }) } : {}),
  });
}

/** The drafts at the end of a dialog that the runtime asked the model to continue or correct. */
function runtimeChain(messages: readonly AgentMessage[]): { readonly start: number; readonly drafts: readonly AgentMessage[]; readonly continues: number; readonly repairs: number } {
  let start = messages.length;
  let continues = 0;
  let repairs = 0;
  const drafts: AgentMessage[] = [];
  while (start >= 2) {
    const ask = messages[start - 1]!;
    const draft = messages[start - 2]!;
    const kind = ask.role === "user" ? ask.metadata.runtime : undefined;
    if ((kind !== RUNTIME_CONTINUE && kind !== RUNTIME_REPAIR) || draft.role !== "assistant" || draft.content.some((part) => part.kind === "tool-call")) break;
    drafts.unshift(draft);
    if (kind === RUNTIME_CONTINUE) continues += 1;
    else repairs += 1;
    start -= 2;
  }
  return { start, drafts, continues, repairs };
}

/** An answer in words: text, with or without the reasoning that led to it. */
function isTextOnly(message: AgentMessage): boolean {
  return message.content.every((part) => part.kind === "text" || part.kind === "reasoning");
}

/**
 * A message without its reasoning parts. A provider ties reasoning to the
 * dialog it was written in, so it is dropped wherever the runtime rewrites
 * that dialog; the words and Tool calls stay.
 */
function withoutReasoning(message: AgentMessage): AgentMessage {
  if (!message.content.some((part) => part.kind === "reasoning")) return message;
  const content = message.content.filter((part) => part.kind !== "reasoning");
  if (content.length === 0) return message;
  return agentMessage(message.role, content, { id: message.id, name: message.name, toolCallId: message.toolCallId, createdAtUnixMs: message.createdAtUnixMs, metadata: message.metadata });
}

/** One answer out of the pieces the output limit cut it into. */
function joinedAnswer(pieces: readonly AgentMessage[]): AgentMessage {
  const last = pieces[pieces.length - 1]!;
  const text = pieces.map((piece) => piece.content.map((part) => part.kind === "text" ? part.text : "").join("")).join("");
  return agentMessage("assistant", text, { id: last.id, name: last.name, createdAtUnixMs: last.createdAtUnixMs, metadata: last.metadata });
}

function repairRequest(error: AgentToolError): string {
  const details = error.details;
  const issues = details !== undefined && details !== null && typeof details === "object" && !Array.isArray(details) ? (details as JsonObject).issues : undefined;
  const listed = issues === undefined ? "" : ` Issues: ${JSON.stringify(issues).slice(0, 2_000)}.`;
  return `Your answer was not accepted: ${error.message}${listed} Reply again with the corrected JSON only, without any other text.`;
}

function isInlineData(uri: string): boolean {
  return uri.startsWith("data:");
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [${text.length - maxChars} more characters]`;
}

/** A dialog as plain text for the model that writes its summary. */
function renderDialog(messages: readonly AgentMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    const speaker = message.metadata.runtime === RUNTIME_SUMMARY ? "Earlier summary" : message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool" : "Instructions";
    for (const part of message.content) {
      switch (part.kind) {
        case "text": lines.push(`${speaker}: ${clip(part.text, 8_000)}`); break;
        case "data": lines.push(`${speaker} (data${part.name === undefined ? "" : ` "${part.name}"`}): ${clip(JSON.stringify(part.value), 4_000)}`); break;
        case "image": lines.push(`${speaker}: [image${isInlineData(part.uri) ? "" : ` ${clip(part.uri, 200)}`}]`); break;
        case "file": lines.push(`${speaker}: [file ${part.name ?? (isInlineData(part.uri) ? "" : clip(part.uri, 200))}]`); break;
        // Reasoning is the model's own working; the summary is written from what was said and done.
        case "reasoning": break;
        case "tool-call": lines.push(`Assistant called ${part.call.name}: ${clip(JSON.stringify(part.call.input), 2_000)}`); break;
        case "tool-result": lines.push(`Result of ${part.result.name} (${part.result.status}): ${clip(JSON.stringify(part.result.status === "success" ? part.result.output : part.result.error), 4_000)}`); break;
      }
    }
  }
  const text = lines.join("\n");
  // The end of the part being summarized matters most: it is what the dialog continues from.
  return text.length <= maxChars ? text : `[The beginning of the conversation is omitted.]\n${text.slice(text.length - maxChars)}`;
}

/**
 * Where the dialog is cut: messages before the index are summarized, the rest
 * stay as written. A Tool call is never separated from its results.
 * `undefined` when there is nothing worth summarizing.
 */
function compactionCut(messages: readonly AgentMessage[], tokens: readonly number[], keepTokens: number): number | undefined {
  let cut = messages.length;
  let kept = 0;
  while (cut > 0 && kept + tokens[cut - 1]! <= keepTokens) {
    kept += tokens[cut - 1]!;
    cut -= 1;
  }
  // The kept part starts with a question or an answer, never with a Tool result.
  while (cut < messages.length && messages[cut]!.role === "tool") cut += 1;
  if (cut >= messages.length) {
    // The newest exchange alone is larger than what may be kept: it stays whole anyway.
    cut = messages.length - 1;
    while (cut > 0 && messages[cut]!.role === "tool") cut -= 1;
  }
  return cut >= 2 ? cut : undefined;
}

/** Waits unless the run is cancelled first; resolves `false` when it was. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(true); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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
  const usage = totalUsage(options.responses.map((response) => response.usage));
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
    ...(usage !== undefined ? { usage } : {}),
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

/** The size of a whole dialog as the context builder counted it, dropped messages included. */
function contextTokens(context: AgentContext): number {
  return context.trace.reduce((sum, entry) => sum + entry.tokens, 0);
}

const fallbackEstimator = new ApproximateAgentContextTokenEstimator();

/** Tokens of every dialog message: the builder's own count, or an estimate for a builder that keeps no such trace. */
function messageTokens(messages: readonly AgentMessage[], context: AgentContext, tokenScale: number): readonly number[] {
  const counted = context.trace.filter((entry) => entry.section.startsWith("conversation["));
  if (counted.length === messages.length) return counted.map((entry) => entry.tokens);
  return messages.map((message) => Math.ceil(fallbackEstimator.estimateMessage(message) * tokenScale));
}

export class AgentExecutionDriver {
  private readonly toolExecutor: AgentToolExecutor;
  private readonly defaultMaxSteps: number;
  private readonly defaultMaxToolCallsPerStep: number;
  private readonly defaultModelProfile?: string;
  readonly defaultTimeoutMs?: number;
  private readonly defaultRunTimeoutMs?: number;
  private readonly modelRetry: ModelRetrySettings;
  private readonly maxOutputContinuations: number;
  private readonly maxOutputRepairs: number;
  private readonly maxParallelToolCalls: number;
  private readonly compaction: AgentCompactionOptions | undefined;
  private readonly tokenScales: Map<string, number>;
  private readonly defaultContextLimits?: AgentContextLimits;
  private readonly contextBuilder: AgentContextBuilder;
  private readonly logger?: Logger;

  constructor(
    services: ServiceProvider,
    private readonly registry: AgentRegistry,
    private readonly modelProvider: AgentModelProvider,
    options: AgentExecutionDriverOptions = {},
  ) {
    assertPositiveInteger(options.maxSteps, "AgentRuntime.maxSteps");
    assertPositiveInteger(options.maxToolCallsPerStep, "AgentRuntime.maxToolCallsPerStep");
    assertNonNegativeInteger(options.timeoutMs, "AgentRuntime.timeoutMs");
    assertNonNegativeInteger(options.runTimeoutMs, "AgentRuntime.runTimeoutMs");
    assertPositiveInteger(options.modelRetry?.maxAttempts, "AgentRuntime.modelRetry.maxAttempts");
    assertNonNegativeInteger(options.modelRetry?.delayMs, "AgentRuntime.modelRetry.delayMs");
    assertNonNegativeInteger(options.modelRetry?.maxDelayMs, "AgentRuntime.modelRetry.maxDelayMs");
    assertNonNegativeInteger(options.maxOutputContinuations, "AgentRuntime.maxOutputContinuations");
    assertNonNegativeInteger(options.maxOutputRepairs, "AgentRuntime.maxOutputRepairs");
    assertPositiveInteger(options.maxParallelToolCalls, "AgentRuntime.maxParallelToolCalls");
    this.defaultRunTimeoutMs = options.runTimeoutMs === 0 ? undefined : options.runTimeoutMs;
    this.modelRetry = Object.freeze({
      maxAttempts: options.modelRetry?.maxAttempts ?? DEFAULT_MODEL_ATTEMPTS,
      delayMs: options.modelRetry?.delayMs ?? DEFAULT_MODEL_RETRY_DELAY_MS,
      maxDelayMs: options.modelRetry?.maxDelayMs ?? DEFAULT_MODEL_RETRY_MAX_DELAY_MS,
    });
    this.maxOutputContinuations = options.maxOutputContinuations ?? DEFAULT_MAX_OUTPUT_CONTINUATIONS;
    this.maxOutputRepairs = options.maxOutputRepairs ?? DEFAULT_MAX_OUTPUT_REPAIRS;
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
    this.compaction = this.compactionSettings(options.compaction, "AgentRuntime.compaction") ?? (options.compaction === false ? undefined : Object.freeze({}));
    this.tokenScales = options.tokenScales ?? new Map<string, number>();
    this.defaultMaxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.defaultMaxToolCallsPerStep = options.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP;
    this.defaultModelProfile = optionalText(options.modelProfile, "AgentRuntime.modelProfile");
    this.defaultTimeoutMs = options.timeoutMs === 0
      ? undefined
      : options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.defaultContextLimits = normalizeAgentContextLimits(options.contextLimits, "AgentRuntime.contextLimits");
    this.contextBuilder = options.contextBuilder ?? new DefaultAgentContextBuilder();
    this.logger = options.logger;
    this.toolExecutor = new AgentToolExecutor(services, registry, options.toolExecutorOptions, options.logger);
  }

  async invoke(agentName: string, options: AgentRuntimeInvokeOptions = {}): Promise<AgentRuntimeResult> {
    const prepared = await this.prepareAgent(agentName, options);
    const result = prepared.ok ? await this.drive(prepared.plan) : prepared.result;
    this.emit(options, { kind: "finished", invocationId: result.invocationId, result });
    return result;
  }

  /** Tells the run's observer what happened; an observer that throws does not stop the run. */
  private emit(options: AgentRuntimeInvokeOptions, event: AgentRunEvent): void {
    if (options.onEvent === undefined) return;
    try {
      options.onEvent(Object.freeze(event));
    } catch (error) {
      this.logger?.warn("Agent event observer failed", { invocationId: event.invocationId, event: event.kind, error: redactSensitive(error) });
    }
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
      const prepared = await this.prepareAgent(request.agentName, options);
      if (!prepared.ok) return { kind: "rejected", result: prepared.result };
      const plan = prepared.plan;
      const maxSteps = request.requested.maxSteps ?? request.module.maxSessionSteps;
      const maxToolCallsPerStep = request.requested.maxToolCallsPerStep ?? request.module.maxToolCallsPerStep;
      const runTimeoutMs = request.requested.runTimeoutMs ?? request.module.runTimeoutMs;
      const modelProfile = request.requested.modelProfile ?? plan.agent.modelProfile ?? null;
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
  }

  private initialCheckpoint(plan: PreparedAgentPlan, resolved: {
    readonly maxSteps: number; readonly maxToolCallsPerStep: number; readonly runTimeoutMs: number; readonly modelProfile: string | null;
    readonly providerTimeoutMs: number; readonly toolDefaultTimeoutMs: number; readonly scopeDisposeTimeoutMs: number;
  }): AgentExecutionCheckpointV1 {
    const input = normalizeJsonValue(plan.options.input, "agentSession.input");
    return agentExecutionCheckpointV1({
      version: "bazis.agent-execution-state/v1",
      invocation: {
        invocationId: plan.invocationId,
        agentName: plan.agent.name,
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
    return {
      agent,
      invocationId: checkpoint.invocation.invocationId,
      metadata: checkpoint.invocation.metadata,
      maxSteps,
      maxToolCallsPerStep,
      timeoutMs: providerTimeoutMs,
      // A Session owns its run deadline and runs Tools one by one behind its durable boundary.
      runTimeoutMs: undefined,
      modelRetry: this.modelRetry,
      maxOutputContinuations: this.maxOutputContinuations,
      maxOutputRepairs: this.maxOutputRepairs,
      maxParallelToolCalls: 1,
      // A Session keeps its dialog as written: a checkpoint ties it to the recorded responses.
      compaction: undefined,
      side: { usage: [], compactions: 0 },
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
      },
    };
  }

  private async prepareAgent(agentName: string, options: AgentRuntimeInvokeOptions): Promise<AgentPreparation> {
    const invocationId = options.id ?? generatedInvocationId();
    let metadata: JsonObject;
    let maxSteps: number;
    let maxToolCallsPerStep: number;
    let timeoutMs: number | undefined;
    let runTimeoutMs: number | undefined;
    let compaction: AgentCompactionOptions | undefined;
    let modelProfile: string | undefined;
    let contextLimits: AgentContextLimits | undefined;
    try {
      metadata = normalizeMetadata(options.metadata, "agentRuntime.metadata");
      assertPositiveInteger(options.maxSteps, "agentRuntime.maxSteps");
      assertPositiveInteger(options.maxToolCallsPerStep, "agentRuntime.maxToolCallsPerStep");
      assertNonNegativeInteger(options.timeoutMs, "agentRuntime.timeoutMs");
      assertNonNegativeInteger(options.runTimeoutMs, "agentRuntime.runTimeoutMs");
      runTimeoutMs = options.runTimeoutMs === 0 ? undefined : options.runTimeoutMs ?? this.defaultRunTimeoutMs;
      const ownCompaction = this.compactionSettings(options.compaction, "agentRuntime.compaction");
      compaction = options.compaction === false ? undefined
        : ownCompaction === undefined ? this.compaction
        : Object.freeze({ ...(this.compaction ?? {}), ...ownCompaction });
      maxSteps = options.maxSteps ?? this.defaultMaxSteps;
      maxToolCallsPerStep = options.maxToolCallsPerStep ?? this.defaultMaxToolCallsPerStep;
      timeoutMs = options.timeoutMs === 0 ? undefined : options.timeoutMs ?? this.defaultTimeoutMs;
      modelProfile = optionalText(options.modelProfile, "agentRuntime.modelProfile");
      contextLimits = mergeAgentContextLimits(
        this.defaultContextLimits,
        normalizeAgentContextLimits(options.contextLimits, "agentRuntime.contextLimits"),
      );
    } catch (error) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_RUNTIME_OPTIONS_INVALID", errorMessageOf(error)), metadata: Object.freeze({}) }) };
    }

    const agent = this.registry.getAgent(agentName);
    if (!agent) {
      return { ok: false, result: runtimeResult({ invocationId, agentName, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_NOT_REGISTERED", `Agent "${agentName}" is not registered.`), metadata }) };
    }

    let messages: AgentMessage[];
    let seenToolCallIds: Set<string>;
    try {
      messages = this.initialMessages(options);
      seenToolCallIds = this.initialToolCallIds(messages);
    } catch (error) {
      return { ok: false, result: runtimeResult({ invocationId, agentName: agent.name, status: "failed", steps: 0, messages: [], responses: [], toolResults: [], error: runtimeError("AGENT_INPUT_INVALID", errorMessageOf(error)), metadata }) };
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
        runTimeoutMs,
        modelRetry: this.modelRetry,
        maxOutputContinuations: this.maxOutputContinuations,
        maxOutputRepairs: this.maxOutputRepairs,
        maxParallelToolCalls: this.maxParallelToolCalls,
        compaction,
        side: { usage: [], compactions: 0 },
        modelProfile,
        contextLimits,
        messages,
        seenToolCallIds,
        tools: this.toolContracts(agent),
        executorToolOptions: this.executorToolOptions(options.toolExecution),
        options: { ...options, id: invocationId },
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
    // A dialog is compacted at most once before a step and once after a refusal of that step.
    const canCompact = !session && plan.compaction !== undefined;
    let sizeCheckedAtStep = 0;
    let overflowHandledAtStep = 0;
    const withMessages = (messages: readonly AgentMessage[]): TState => bridge.evolve(checkpoint, {
      phase: checkpoint.phase, steps: checkpoint.steps, messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
      seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined, terminal: undefined,
    });

    for (;;) {
      if (session && signal?.aborted) return suspend("aborted");
      if (checkpoint.phase === "pending-tools") {
        const pendingControl = await control(checkpoint);
        if (pendingControl !== undefined) return pendingControl;
        const pending = checkpoint.pendingToolBatch!;
        const response = checkpoint.responses[pending.responseIndex]!;
        const call = response.toolCalls[pending.nextToolIndex]!;
        const together = session ? [] : this.readTogether(plan, response.toolCalls, pending.nextToolIndex);
        if (together.length > 1) {
          const results = await Promise.all(together.map(async (item) => {
            this.emit(plan.options, { kind: "tool-started", invocationId: plan.invocationId, step: pending.step, call: item.call });
            const result = await this.toolExecutor.execute(item.call, {
              ...plan.executorToolOptions,
              agentName: plan.agent.name,
              invocationId: plan.invocationId,
              metadata: plan.metadata,
              signal,
              idempotencyKey: item.idempotencyKey,
            });
            this.emit(plan.options, { kind: "tool-finished", invocationId: plan.invocationId, step: pending.step, result });
            return result;
          }));
          const unknown = results.findIndex((result) => result.error?.code?.endsWith("_OUTCOME_UNKNOWN") === true);
          const nextToolIndex = pending.nextToolIndex + together.length;
          const finished = nextToolIndex === response.toolCalls.length;
          const candidate = bridge.evolve(checkpoint, {
            phase: unknown >= 0 ? "terminal" : finished ? "ready-model" : "pending-tools",
            steps: checkpoint.steps,
            // Results stand in the order the model wrote the calls, whichever finished first.
            messages: [...checkpoint.messages, ...results.map((result, index) => agentMessage("tool", agentToolResultPart(result), {
              toolCallId: together[index]!.call.id, metadata: { toolName: together[index]!.call.name },
            }))],
            responses: checkpoint.responses,
            toolResults: [...checkpoint.toolResults, ...results],
            seenToolCallIds: checkpoint.seenToolCallIds,
            pendingToolBatch: finished ? undefined : { ...pending, nextToolIndex },
            terminal: unknown >= 0 ? {
              status: "failed",
              error: runtimeError("AGENT_TOOL_OUTCOME_UNKNOWN", `Tool "${together[unknown]!.call.name}" finished with an unknown retry-safe side-effect outcome; automatic model continuation is blocked.`, {
                callId: together[unknown]!.call.id, toolName: together[unknown]!.call.name, idempotencyKey: together[unknown]!.idempotencyKey, toolErrorCode: results[unknown]!.error?.code ?? null,
              }),
            } : undefined,
          });
          const stopped = await committedControl(candidate);
          if (stopped !== undefined) return stopped;
          if (candidate.phase === "terminal") return terminal(candidate, this.resultFromCheckpoint(plan, candidate));
          continue;
        }
        let idempotencyKey: string;
        try {
          idempotencyKey = !session
            ? this.toolIdempotencyKey(plan.options.toolExecution, { invocationId: plan.invocationId, agentName: plan.agent.name, call })
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
        this.emit(plan.options, { kind: "tool-started", invocationId: plan.invocationId, step: pending.step, call });
        const result = await this.toolExecutor.execute(call, {
          ...plan.executorToolOptions,
          ...(toolTimeoutMs === undefined ? {} : { timeoutMs: toolTimeoutMs }),
          agentName: plan.agent.name,
          invocationId: plan.invocationId,
          metadata: plan.metadata,
          signal,
          idempotencyKey,
        });
        this.emit(plan.options, { kind: "tool-finished", invocationId: plan.invocationId, step: pending.step, result });
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
          terminal: { status: "failed", error: runtimeError("AGENT_MAX_STEPS_EXCEEDED", `Agent "${plan.agent.name}" exceeded maxSteps (${plan.maxSteps}).`, { maxSteps: plan.maxSteps }) },
        });
        const stopped = await control(candidate);
        return stopped ?? terminal(candidate, this.resultFromCheckpoint(plan, candidate));
      }

      const step = checkpoint.steps + 1;
      const readyControl = await control(checkpoint);
      if (readyControl !== undefined) return readyControl;
      let modelRequest: AgentModelRequest;
      let context: AgentContext;
      const tokenScale = this.tokenScales.get(plan.modelProfile ?? "") ?? 1;
      const build = (): AgentContext => this.contextBuilder.build({ invocationId: plan.invocationId, agent: plan.agent, messages: checkpoint.messages, metadata: plan.metadata, limits: plan.contextLimits, tokenScale });
      try {
        context = build();
        if (canCompact && sizeCheckedAtStep !== step) {
          sizeCheckedAtStep = step;
          const maxTokens = this.compactionThreshold(plan);
          if (maxTokens !== undefined && contextTokens(context) > maxTokens) {
            const compacted = await this.compact(plan, checkpoint.messages, context, tokenScale, plan.compaction!.keepTokens ?? Math.floor(maxTokens / 4), "size", signal);
            if (compacted !== undefined) {
              checkpoint = withMessages(compacted);
              context = build();
            }
          }
        }
        modelRequest = agentModelRequest({
          invocationId: plan.invocationId, messages: context.messages, tools: plan.tools,
          output: this.providerOutputContract(plan.options.output),
          modelProfile: plan.modelProfile,
          maxOutputTokens: plan.options.maxOutputTokens, temperature: plan.options.temperature,
          metadata: { ...plan.metadata, agentName: plan.agent.name, step, modelProfile: plan.modelProfile ?? null, agentContext: context.metadata },
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
      this.emit(plan.options, { kind: "step-started", invocationId: plan.invocationId, step });
      const response = await this.completeModel(modelRequest, plan.agent.name, plan.modelProfile, plan.metadata, signal, plan.timeoutMs, plan.modelRetry,
        plan.options.onTextDelta !== undefined || plan.options.onEvent !== undefined ? (text) => {
          plan.options.onTextDelta?.(Object.freeze({ step, text }));
          this.emit(plan.options, { kind: "text-delta", invocationId: plan.invocationId, step, text });
        } : undefined,
        (attempt, delayMs) => this.emit(plan.options, { kind: "model-retry", invocationId: plan.invocationId, step, attempt, maxAttempts: plan.modelRetry.maxAttempts, delayMs }));
      if (!response.ok) {
        // The provider says the request is too long: the dialog is compacted and the step is asked again.
        if (response.cause instanceof AgentModelContextOverflowError && canCompact && overflowHandledAtStep !== step) {
          overflowHandledAtStep = step;
          const compacted = await this.compact(plan, checkpoint.messages, context, tokenScale, plan.compaction!.keepTokens ?? Math.floor(contextTokens(context) / 4), "overflow", signal);
          if (compacted !== undefined) {
            checkpoint = withMessages(compacted);
            continue;
          }
        }
        const candidate = bridge.evolve(checkpoint, {
          phase: "terminal", steps: step, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
          seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined, terminal: { status: "failed", error: response.error },
        });
        try { await boundary.afterModelSettlement(checkpoint, candidate, step, { error: response.error }); } catch { throw bridge.boundaryError(checkpoint); }
        const stopped = await committedControl(candidate);
        return stopped ?? terminal(candidate, this.resultFromCheckpoint(plan, candidate));
      }
      this.learnTokenScale(plan.modelProfile, tokenScale, context, response.value);
      this.emit(plan.options, {
        kind: "model-answered", invocationId: plan.invocationId, step, toolCalls: response.value.toolCalls, finishReason: response.value.finishReason,
        ...(response.value.message === undefined ? {} : { message: response.value.message }),
        ...(response.value.usage === undefined ? {} : { usage: response.value.usage }),
      });
      const candidate = await this.modelCandidate(plan, checkpoint, step, response.value, bridge);
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
    return runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.name, status: terminal.status,
      steps: checkpoint.steps, messages: checkpoint.messages, responses: checkpoint.responses, toolResults: checkpoint.toolResults,
      finalMessage: terminal.finalMessage, output: terminal.output, error: terminal.error, metadata: plan.metadata });
  }

  private async modelCandidate<TState extends EngineProgress>(
    plan: PreparedAgentPlan, checkpoint: TState, step: number, response: AgentModelResponse, bridge: PhaseBridge<TState>,
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
    // No tool calls: a model response always carries a message then.
    const answer = message!;
    const chain = runtimeChain(checkpoint.messages);
    const responses = [...checkpoint.responses, response];
    const json = plan.options.output?.mode === "json";
    /** The draft stays in the dialog with the runtime's request, and the model is called again. */
    const askAgain = (kind: string, text: string): { readonly state: TState } => ({ state: bridge.evolve(checkpoint, {
      phase: "ready-model", steps: step,
      messages: [...checkpoint.messages, answer, agentMessage("user", text, { metadata: { runtime: kind } })],
      responses, toolResults: checkpoint.toolResults, seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined, terminal: undefined,
    }) });
    const mayAskAgain = step < plan.maxSteps;
    if (response.finishReason === "length" && !json && isTextOnly(answer) && mayAskAgain && chain.continues < plan.maxOutputContinuations) {
      return askAgain(RUNTIME_CONTINUE, CONTINUE_TEXT);
    }
    // The finished dialog keeps one answer: the pieces joined, without rejected drafts and the runtime's requests.
    const finalMessage = !json && chain.continues > 0 && chain.repairs === 0 && isTextOnly(answer) && chain.drafts.every(isTextOnly)
      ? joinedAnswer([...chain.drafts, answer])
      // Drafts are dropped from the dialog, so the answer's reasoning no longer matches it.
      : chain.drafts.length > 0 ? withoutReasoning(answer) : answer;
    const messages = [...checkpoint.messages.slice(0, chain.start), finalMessage];
    let result: AgentRuntimeResult;
    if (response.finishReason !== "stop") {
      result = runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.name, status: "failed", steps: step, messages, responses, toolResults: checkpoint.toolResults, finalMessage, metadata: plan.metadata,
        error: runtimeError("AGENT_PROVIDER_STOPPED", `Model provider stopped with finishReason "${response.finishReason}".`) });
    } else {
      result = runtimeResult({ invocationId: plan.invocationId, agentName: plan.agent.name, status: "completed", steps: step, messages, responses, toolResults: checkpoint.toolResults, finalMessage, metadata: plan.metadata });
      if (plan.options.output?.mode === "json") {
        result = this.validateExplicitOutput(result, plan.options.output);
        if (result.error?.code === "AGENT_OUTPUT_INVALID" && mayAskAgain && chain.repairs < plan.maxOutputRepairs) {
          return askAgain(RUNTIME_REPAIR, repairRequest(result.error));
        }
      }
    }
    const state = bridge.evolve(checkpoint, { phase: "terminal", steps: step, messages: result.messages, responses: result.responses, toolResults: result.toolResults, seenToolCallIds: checkpoint.seenToolCallIds, pendingToolBatch: undefined,
      terminal: result.status === "completed" ? { status: "completed", finalMessage: result.finalMessage, output: result.output } : { status: "failed", finalMessage: result.finalMessage, error: result.error! } });
    return { state, result };
  }

  private validateExplicitOutput(result: AgentRuntimeResult, contract: AgentOutputContract): AgentRuntimeResult {
    try {
      const output = normalizeJsonValue(this.parseJsonOutput(result.finalMessage), "agent.output");
      const declared = contract.schema;
      if (declared !== undefined) {
        const generated = declared.kind === "class" ? getGeneratedOpenApiMetadata().schemas[declared.name] : undefined;
        if (declared.kind === "class" && generated === undefined) {
          return this.failedResult(result, runtimeError("AGENT_OUTPUT_SCHEMA_UNAVAILABLE", `Output class "${declared.name}" has no generated JSON schema.`));
        }
        const schema = declared.kind === "json-schema" ? declared.schema : inlineGeneratedSchema(generated, getGeneratedOpenApiMetadata().schemas);
        const issues = validateAgentJsonSchema(output, schema);
        if (issues.length > 0) return this.failedResult(result, runtimeError("AGENT_OUTPUT_INVALID", "Agent output failed JSON Schema validation.", { schema: declared.name, issues }));
      }
      return runtimeResult({ ...result, output });
    } catch (error) {
      return this.failedResult(result, runtimeError("AGENT_OUTPUT_INVALID", errorMessageOf(error)));
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
    const resolvedPlan = { ...plan, modelProfile: plan.modelProfile ?? plan.agent.modelProfile ?? this.defaultModelProfile };
    if (plan.runTimeoutMs === undefined) {
      const outcome = await this.drivePhaseEngine(resolvedPlan, initial, inMemoryBoundary, plan.options.signal, inMemoryBridge, false);
      if (outcome.kind === "terminal") return this.withSideWork(outcome.result, plan);
      throw new AgentRuntimeError("in-memory execution cannot suspend.");
    }
    // The run deadline cancels whatever is in flight, like the caller's signal does.
    const deadline = new AbortController();
    const detach = attachAbortForwarding(plan.options.signal, deadline);
    let expired = false;
    const timer = setTimeout(() => { expired = true; deadline.abort(); }, plan.runTimeoutMs);
    try {
      const outcome = await this.drivePhaseEngine(resolvedPlan, initial, inMemoryBoundary, deadline.signal, inMemoryBridge, false);
      if (outcome.kind !== "terminal") throw new AgentRuntimeError("in-memory execution cannot suspend.");
      return this.withSideWork(expired && outcome.result.error?.code === "AGENT_ABORTED"
        ? this.failedResult(outcome.result, runtimeError("AGENT_RUN_TIMEOUT", `Agent "${plan.agent.name}" did not finish within runTimeoutMs (${plan.runTimeoutMs}).`, { runTimeoutMs: plan.runTimeoutMs }))
        : outcome.result, plan);
    } finally {
      clearTimeout(timer);
      detach?.();
    }
  }

  /** Adds to a result what the run did besides its steps: summaries and their usage. */
  private withSideWork(result: AgentRuntimeResult, plan: PreparedAgentPlan): AgentRuntimeResult {
    if (plan.side.compactions === 0) return result;
    const usage = totalUsage([result.usage, ...plan.side.usage]);
    return Object.freeze({ ...result, ...(usage === undefined ? {} : { usage }), compactions: plan.side.compactions });
  }

  private compactionSettings(value: AgentCompactionOptions | false | undefined, field: string): AgentCompactionOptions | undefined {
    if (value === undefined || value === false) return undefined;
    assertPositiveInteger(value.maxTokens, `${field}.maxTokens`);
    assertPositiveInteger(value.keepTokens, `${field}.keepTokens`);
    const modelProfile = optionalText(value.modelProfile, `${field}.modelProfile`);
    const instructions = optionalText(value.instructions, `${field}.instructions`);
    return Object.freeze({
      ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
      ...(value.keepTokens === undefined ? {} : { keepTokens: value.keepTokens }),
      ...(modelProfile === undefined ? {} : { modelProfile }),
      ...(instructions === undefined ? {} : { instructions }),
    });
  }

  /** The dialog size that starts compaction, when it is set or the model's window is known. */
  private compactionThreshold(plan: PreparedAgentPlan): number | undefined {
    if (plan.compaction?.maxTokens !== undefined) return plan.compaction.maxTokens;
    let window: number | undefined;
    try { window = this.modelProvider.contextTokens?.(plan.modelProfile); } catch { window = undefined; }
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? Math.floor(window * COMPACTION_WINDOW_SHARE) : undefined;
  }

  /**
   * Replaces the older part of a dialog with a summary the model writes.
   * `undefined` when there is nothing to summarize or the summary failed: the
   * dialog then stays as it is.
   */
  private async compact(
    plan: PreparedAgentPlan, messages: readonly AgentMessage[], context: AgentContext, tokenScale: number, keepTokens: number,
    reason: "size" | "overflow", signal: AbortSignal | undefined,
  ): Promise<readonly AgentMessage[] | undefined> {
    const tokens = messageTokens(messages, context, tokenScale);
    const cut = compactionCut(messages, tokens, keepTokens);
    if (cut === undefined) return undefined;
    const settings = plan.compaction!;
    const modelProfile = settings.modelProfile ?? plan.modelProfile;
    const before = tokens.reduce((sum, value) => sum + value, 0);
    const summarized = tokens.slice(0, cut).reduce((sum, value) => sum + value, 0);
    try {
      const request = agentModelRequest({
        invocationId: plan.invocationId,
        messages: [
          agentMessage("system", settings.instructions ?? SUMMARY_INSTRUCTIONS),
          // Plain text, so the request needs neither the Tools nor a valid tool-call order.
          agentMessage("user", `<conversation>\n${renderDialog(messages.slice(0, cut), Math.max(20_000, summarized * 4))}\n</conversation>\n\nWrite the summary of the conversation above.`),
        ],
        modelProfile,
        metadata: { ...plan.metadata, agentName: plan.agent.name, purpose: "compaction", modelProfile: modelProfile ?? null },
      });
      const response = await this.completeModel(request, plan.agent.name, modelProfile, plan.metadata, signal, plan.timeoutMs, plan.modelRetry);
      if (!response.ok) {
        if (response.error.code !== "AGENT_ABORTED") this.logger?.warn("Agent context was not compacted", { agent: plan.agent.name, invocationId: plan.invocationId, reason, code: response.error.code });
        return undefined;
      }
      if (response.value.usage !== undefined) plan.side.usage.push(response.value.usage);
      const summary = (response.value.message?.content ?? []).map((part) => part.kind === "text" ? part.text : "").join("").trim();
      if (summary.length === 0 || response.value.toolCalls.length > 0) {
        this.logger?.warn("Agent context was not compacted", { agent: plan.agent.name, invocationId: plan.invocationId, reason, code: "AGENT_SUMMARY_EMPTY" });
        return undefined;
      }
      plan.side.compactions += 1;
      this.emit(plan.options, { kind: "compacted", invocationId: plan.invocationId, reason, messages: cut });
      this.logger?.info("Agent context compacted", { agent: plan.agent.name, invocationId: plan.invocationId, reason, messages: cut, tokensBefore: before, tokensSummarized: summarized });
      return Object.freeze([
        agentMessage("user", `${SUMMARY_PREFIX}\n\n${summary}`, { metadata: { runtime: RUNTIME_SUMMARY, messages: cut } }),
        // The kept messages were reasoned about with the whole dialog in front of the model.
        ...messages.slice(cut).map(withoutReasoning),
      ]);
    } catch (error) {
      this.logger?.warn("Agent context was not compacted", { agent: plan.agent.name, invocationId: plan.invocationId, reason, error: redactSensitive(error) });
      return undefined;
    }
  }

  /** Remembers how many real tokens an estimated one is for a model, from the usage it reported. */
  private learnTokenScale(modelProfile: string | undefined, usedScale: number, context: AgentContext, response: AgentModelResponse): void {
    const reported = response.usage?.inputTokens;
    const counted = context.metadata.tokenCount;
    if (typeof reported !== "number" || reported <= 0 || typeof counted !== "number" || counted <= 0) return;
    const measured = Math.min(6, Math.max(0.5, reported / (counted / usedScale)));
    const key = modelProfile ?? "";
    const known = this.tokenScales.get(key);
    // Half-way to the new measurement: one unusual request does not swing the estimate.
    this.tokenScales.set(key, known === undefined ? measured : (known + measured) / 2);
  }

  /**
   * The calls from `from` on that may run at the same time: Tools that change
   * nothing, standing next to each other. One call, or a call that changes
   * something, runs alone through the ordinary path.
   */
  private readTogether(plan: PreparedAgentPlan, calls: readonly AgentModelResponse["toolCalls"][number][], from: number): readonly { readonly call: AgentModelResponse["toolCalls"][number]; readonly idempotencyKey: string }[] {
    const together: { call: AgentModelResponse["toolCalls"][number]; idempotencyKey: string }[] = [];
    for (let index = from; index < calls.length && together.length < plan.maxParallelToolCalls; index += 1) {
      const call = calls[index]!;
      const sideEffect = plan.agent.tools.find((tool) => tool.metadata.name === call.name)?.metadata.sideEffect;
      if (sideEffect !== "none" && sideEffect !== "read") break;
      try {
        together.push({ call, idempotencyKey: this.toolIdempotencyKey(plan.options.toolExecution, { invocationId: plan.invocationId, agentName: plan.agent.name, call }) });
      } catch {
        // A wrong idempotency setting is reported by the ordinary one-call path.
        break;
      }
    }
    return together;
  }
  private parseJsonOutput(message: AgentMessage | undefined): unknown {
    if (message === undefined) {
      throw new AgentRuntimeError("Model response does not contain a final message.");
    }
    const content = message.content.filter((part) => part.kind !== "reasoning");
    if (content.length === 1 && content[0]?.kind === "data") {
      return content[0].value;
    }
    if (!content.every((part) => part.kind === "text")) {
      throw new AgentRuntimeError("JSON output must contain only text or one data part.");
    }
    const text = content.map((part) => part.kind === "text" ? part.text : "").join("\n").trim();
    if (text.length === 0) {
      throw new AgentRuntimeError("JSON output is empty.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AgentRuntimeError("JSON output is malformed.");
    }
  }

  private failedResult(result: AgentRuntimeResult, error: AgentToolError): AgentRuntimeResult {
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

  /** One model request, repeated while the provider cannot serve it right now. */
  private async completeModel(
    request: AgentModelRequest,
    agentName: string,
    modelProfile: string | undefined,
    metadata: JsonObject,
    sourceSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    retry: ModelRetrySettings,
    onTextDelta?: (text: string) => void,
    onRetry?: (attempt: number, delayMs: number) => void,
  ): Promise<{ readonly ok: true; readonly value: AgentModelResponse } | { readonly ok: false; readonly error: AgentToolError; readonly cause?: unknown }> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.completeModelOnce(request, agentName, modelProfile, metadata, sourceSignal, timeoutMs, onTextDelta);
      if (outcome.ok) return outcome;
      // Text already shown to the user is not followed by a second answer.
      const repeat = outcome.cause instanceof AgentModelUnavailableError && attempt < retry.maxAttempts && !outcome.textEmitted && sourceSignal?.aborted !== true;
      if (!repeat) {
        if (outcome.error.code !== "AGENT_ABORTED" && !outcome.logged) {
          this.logger?.error("Agent model call failed", { agent: agentName, invocationId: request.invocationId, code: outcome.error.code, ...(attempt > 1 ? { attempts: attempt } : {}), error: redactSensitive(outcome.cause) });
        }
        return { ok: false, error: outcome.error, cause: outcome.cause };
      }
      const asked = (outcome.cause as AgentModelUnavailableError).retryAfterMs ?? 0;
      const delayMs = Math.min(retry.maxDelayMs, Math.max(asked, retry.delayMs * 2 ** (attempt - 1)));
      this.logger?.warn("Agent model call failed, repeating", { agent: agentName, invocationId: request.invocationId, attempt, maxAttempts: retry.maxAttempts, delayMs, error: redactSensitive(outcome.cause) });
      onRetry?.(attempt, delayMs);
      if (!await pause(delayMs, sourceSignal)) {
        return { ok: false, error: runtimeError("AGENT_ABORTED", "Agent runtime invocation was aborted.") };
      }
    }
  }

  private async completeModelOnce(
    request: AgentModelRequest,
    agentName: string,
    modelProfile: string | undefined,
    metadata: JsonObject,
    sourceSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    onTextDelta?: (text: string) => void,
  ): Promise<{ readonly ok: true; readonly value: AgentModelResponse } | { readonly ok: false; readonly error: AgentToolError; readonly cause: unknown; readonly textEmitted: boolean; readonly logged: boolean }> {
    const abortController = new AbortController();
    const detach = attachAbortForwarding(sourceSignal, abortController);
    let acceptingText = true;
    let textEmitted = false;
    const context: AgentModelProviderContext = Object.freeze({
      invocationId: request.invocationId,
      agentName,
      ...(modelProfile !== undefined ? { modelProfile } : {}),
      metadata,
      signal: abortController.signal,
      ...(onTextDelta ? { onTextDelta: (text: string) => {
        if (!acceptingText || abortController.signal.aborted) return;
        if (typeof text !== "string") throw new AgentRuntimeError("Model text delta must be a string.");
        if (text) { textEmitted = true; onTextDelta(text); }
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
        this.logger?.error("Agent model call failed", { agent: agentName, invocationId: request.invocationId, code: "AGENT_PROVIDER_RESPONSE_INVALID", error: redactSensitive(error) });
        return {
          ok: false, cause: error, textEmitted, logged: true,
          error: runtimeError("AGENT_PROVIDER_RESPONSE_INVALID", `Model provider returned an invalid response: ${errorMessageOf(error)}`),
        };
      }
    } catch (error) {
      const code = error instanceof AgentRuntimeTimeoutError || error instanceof AgentModelTimeoutError
        ? "AGENT_PROVIDER_TIMEOUT"
        : error instanceof AgentRuntimeAbortError
          ? "AGENT_ABORTED"
          : error instanceof AgentModelContextOverflowError
            ? "AGENT_CONTEXT_OVERFLOW"
            : "AGENT_PROVIDER_FAILED";
      return { ok: false, cause: error, textEmitted, logged: false, error: runtimeError(code, errorMessageOf(error)) };
    } finally {
      acceptingText = false;
      detach?.();
    }
  }
}
