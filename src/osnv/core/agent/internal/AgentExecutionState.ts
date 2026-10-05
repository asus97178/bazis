import {
  canonicalBoundaryJsonV1,
  decodeBoundedJsonV1,
  normalizeBoundedJsonV1,
  type BoundaryJsonObject,
  type BoundaryJsonValue,
} from "../../../library/boundary";
import {
  agentData,
  agentMessage,
  agentModelResponse,
  agentText,
  agentToolCall,
  agentToolCallPart,
  agentToolResult,
  agentToolResultPart,
  type AgentContentPart,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolCall,
  type AgentToolError,
  type AgentToolResult,
  type JsonObject,
  type JsonValue,
} from "../semantic";

const VERSION = "osnv.agent-execution-state/v1";
const PHASES = new Set(["ready-model", "pending-tools", "terminal"]);
const FINISH_REASONS = new Set(["stop", "tool-calls", "length", "content-filter", "error"]);
const TOOL_STATUSES = new Set(["success", "error", "denied"]);
/**
 * A semantic checkpoint is trusted by the driver only when it was produced by
 * this parser or by the transition function below.  This is intentionally an
 * identity check: it must not inspect arbitrary objects (including accessors).
 */
const issuedCheckpoints = new WeakSet<object>();

export type AgentExecutionPhase = "ready-model" | "pending-tools" | "terminal";

export interface AgentExecutionInvocationState {
  readonly kind: "agent" | "task";
  readonly invocationId: string;
  readonly agentName: string;
  readonly taskName?: string;
  readonly input: JsonValue;
  readonly metadata: JsonObject;
  /** Resolved Session data only; never classes, callbacks, DI or policies. */
  readonly options: JsonObject;
}

export interface AgentExecutionPendingToolBatch {
  readonly step: number;
  readonly responseIndex: number;
  readonly assistantMessageIndex: number;
  readonly nextToolIndex: number;
}

export interface AgentExecutionTerminalState {
  readonly status: "completed" | "failed";
  readonly finalMessage?: AgentMessage;
  readonly output?: JsonValue;
  readonly error?: AgentToolError;
}

/** A rejected provider batch is retained exactly, before semantic admission. */
interface AgentExecutionResponse {
  readonly invocationId: string;
  readonly finishReason: AgentModelResponse["finishReason"];
  readonly message?: AgentMessage;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage?: AgentModelResponse["usage"];
  readonly metadata: JsonObject;
}

export interface AgentExecutionCheckpointV1 {
  readonly version: typeof VERSION;
  readonly invocation: AgentExecutionInvocationState;
  readonly phase: AgentExecutionPhase;
  readonly steps: number;
  readonly messages: readonly AgentMessage[];
  readonly responses: readonly AgentExecutionResponse[];
  readonly toolResults: readonly AgentToolResult[];
  readonly seenToolCallIds: readonly string[];
  readonly pendingToolBatch?: AgentExecutionPendingToolBatch;
  readonly terminal?: AgentExecutionTerminalState;
}

export class AgentExecutionStateError extends Error {
  readonly code = "AGENT_EXECUTION_STATE_INVALID" as const;

  constructor() {
    super("Agent execution checkpoint is invalid.");
    this.name = "AgentExecutionStateError";
  }
}

export type AgentExecutionControlDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "suspend"; readonly reason: string };

/** Owner-private durable boundary. The driver wires this in WP2-B2. */
export interface AgentExecutionBoundary {
  checkControl(checkpoint: AgentExecutionCheckpointV1, next: AgentExecutionCheckpointV1): Promise<AgentExecutionControlDecision>;
  beforeModelDispatch(checkpoint: AgentExecutionCheckpointV1, step: number, request: AgentModelRequest): Promise<void>;
  afterModelSettlement(
    previous: AgentExecutionCheckpointV1,
    candidate: AgentExecutionCheckpointV1,
    step: number,
    outcome: { readonly response: AgentModelResponse } | { readonly error: AgentToolError },
  ): Promise<void>;
  beforeToolDispatch(
    checkpoint: AgentExecutionCheckpointV1,
    step: number,
    toolIndex: number,
    call: AgentToolCall,
    idempotencyKey: string,
  ): Promise<void>;
  afterToolSettlement(
    previous: AgentExecutionCheckpointV1,
    candidate: AgentExecutionCheckpointV1,
    step: number,
    toolIndex: number,
    call: AgentToolCall,
    idempotencyKey: string,
    result: AgentToolResult,
  ): Promise<void>;
}

/** Decodes strict bounded JSON before validating and rehydrating semantic values. */
export function parseAgentExecutionCheckpointV1(text: string): AgentExecutionCheckpointV1 {
  const decoded = decodeBoundedJsonV1(text);
  if (!decoded.ok) throw invalid();
  return parseBoundaryCheckpoint(decoded.value);
}

/** Validates an in-memory checkpoint and emits the shared canonical JSON representation. */
export function canonicalAgentExecutionCheckpointV1(value: unknown): string {
  if (isIssuedCheckpoint(value)) {
    try {
      return canonicalBoundaryJsonV1(checkpointRecord(value));
    } catch {
      throw invalid();
    }
  }
  const normalized = normalizeBoundedJsonV1(value);
  if (!normalized.ok) throw invalid();
  const checkpoint = parseBoundaryCheckpoint(normalized.value);
  try {
    return canonicalBoundaryJsonV1(checkpointRecord(checkpoint));
  } catch {
    throw invalid();
  }
}

/** Validates an in-memory checkpoint and returns a fully immutable semantic state. */
export function agentExecutionCheckpointV1(value: unknown): AgentExecutionCheckpointV1 {
  const normalized = normalizeBoundedJsonV1(value);
  if (!normalized.ok) throw invalid();
  return parseBoundaryCheckpoint(normalized.value);
}

/** Owner-private admission used by the execution driver before rehydration. */
export function requireIssuedAgentExecutionCheckpointV1(value: unknown): AgentExecutionCheckpointV1 {
  if (!isIssuedCheckpoint(value)) throw invalid();
  return value;
}

/**
 * Produces a fully validated next state while retaining immutable invocation
 * identity.  The complete next progress is required so a caller cannot apply
 * an open-ended patch to a checkpoint.
 */
export function evolveAgentExecutionCheckpointV1(
  previous: AgentExecutionCheckpointV1,
  progress: Pick<
    AgentExecutionCheckpointV1,
    "phase" | "steps" | "messages" | "responses" | "toolResults" | "seenToolCallIds" | "pendingToolBatch" | "terminal"
  >,
): AgentExecutionCheckpointV1 {
  requireIssuedAgentExecutionCheckpointV1(previous);
  return agentExecutionCheckpointV1({
    ...checkpointRecord(previous),
    phase: progress.phase,
    steps: progress.steps,
    messages: progress.messages.map(messageRecord),
    responses: progress.responses.map(responseRecord),
    toolResults: progress.toolResults.map(toolResultRecord),
    seenToolCallIds: progress.seenToolCallIds,
    pendingToolBatch: progress.pendingToolBatch ?? null,
    terminal: progress.terminal === undefined ? null : terminalRecord(progress.terminal),
  });
}

function isIssuedCheckpoint(value: unknown): value is AgentExecutionCheckpointV1 {
  return typeof value === "object" && value !== null && issuedCheckpoints.has(value);
}

function parseBoundaryCheckpoint(value: BoundaryJsonValue): AgentExecutionCheckpointV1 {
  try {
    return checkpointFromBoundary(value);
  } catch (error) {
    if (error instanceof AgentExecutionStateError) throw error;
    throw invalid();
  }
}

function checkpointFromBoundary(value: BoundaryJsonValue): AgentExecutionCheckpointV1 {
  const root = closed(value, ["version", "invocation", "phase", "steps", "messages", "responses", "toolResults", "seenToolCallIds", "pendingToolBatch", "terminal"]);
  if (root.version !== VERSION || !isPhase(root.phase)) throw invalid();

  const invocation = parseInvocation(root.invocation);
  const messages = parseArray(root.messages, parseMessage);
  const responses = parseArray(root.responses, parseResponse);
  const toolResults = parseArray(root.toolResults, parseToolResult);
  const seenToolCallIds = parseArray(root.seenToolCallIds, requiredString);
  const steps = nonNegativeInteger(root.steps);
  const pendingToolBatch = root.pendingToolBatch === null ? undefined : parsePendingToolBatch(root.pendingToolBatch);
  const terminal = root.terminal === null ? undefined : parseTerminal(root.terminal);

  const checkpoint: AgentExecutionCheckpointV1 = Object.freeze({
    version: VERSION,
    invocation,
    phase: root.phase,
    steps,
    messages: Object.freeze(messages),
    responses: Object.freeze(responses),
    toolResults: Object.freeze(toolResults),
    seenToolCallIds: Object.freeze(seenToolCallIds),
    pendingToolBatch,
    terminal,
  });
  validateCheckpoint(checkpoint);
  issuedCheckpoints.add(checkpoint);
  return checkpoint;
}

function parseInvocation(value: BoundaryJsonValue): AgentExecutionInvocationState {
  const record = closed(value, ["kind", "invocationId", "agentName", "taskName", "input", "metadata", "options"]);
  if (record.kind !== "agent" && record.kind !== "task") throw invalid();
  if ((record.kind === "agent" && record.taskName !== null) || (record.kind === "task" && typeof record.taskName !== "string")) throw invalid();
  return Object.freeze({
    kind: record.kind,
    invocationId: requiredString(record.invocationId),
    agentName: requiredString(record.agentName),
    taskName: record.taskName === null ? undefined : requiredString(record.taskName),
    input: asJsonValue(record.input),
    metadata: asJsonObject(record.metadata),
    options: parseResolvedOptions(record.options),
  });
}

/**
 * The checkpoint stores resolved data, not an invocation's mutable runtime
 * options.  Keeping this record closed prevents a later driver default from
 * silently changing a resumed execution.
 */
function parseResolvedOptions(value: BoundaryJsonValue): JsonObject {
  const record = closed(value, [
    "maxSteps",
    "maxToolCallsPerStep",
    "runTimeoutMs",
    "modelProfile",
    "provider",
    "context",
    "output",
    "tool",
  ]);
  const provider = closed(record.provider, ["timeoutMs"]);
  const context = closed(record.context, ["maxMessages", "maxChars", "maxTokens"]);
  const output = closed(record.output, ["maxOutputTokens", "temperature"]);
  const tool = closed(record.tool, ["defaultTimeoutMs", "scopeDisposeTimeoutMs", "maxAttempts", "timeouts"]);
  if (record.modelProfile !== null) requiredString(record.modelProfile);
  if (tool.maxAttempts !== 1) throw invalid();

  const timeouts = parseArray(tool.timeouts, (item) => {
    const timeout = closed(item, ["name", "timeoutMs"]);
    return { name: requiredString(timeout.name), timeoutMs: positiveSafeInteger(timeout.timeoutMs) };
  });
  for (let index = 1; index < timeouts.length; index += 1) {
    if (timeouts[index - 1]!.name >= timeouts[index]!.name) throw invalid();
  }

  return Object.freeze({
    maxSteps: positiveSafeInteger(record.maxSteps),
    maxToolCallsPerStep: positiveSafeInteger(record.maxToolCallsPerStep),
    runTimeoutMs: positiveSafeInteger(record.runTimeoutMs),
    modelProfile: record.modelProfile === null ? null : requiredString(record.modelProfile),
    provider: Object.freeze({ timeoutMs: positiveSafeInteger(provider.timeoutMs) }),
    context: Object.freeze({
      maxMessages: nullablePositiveSafeInteger(context.maxMessages),
      maxChars: nullablePositiveSafeInteger(context.maxChars),
      maxTokens: nullablePositiveSafeInteger(context.maxTokens),
    }),
    output: Object.freeze({
      maxOutputTokens: nullablePositiveSafeInteger(output.maxOutputTokens),
      temperature: nullableTemperature(output.temperature),
    }),
    tool: Object.freeze({
      defaultTimeoutMs: positiveSafeInteger(tool.defaultTimeoutMs),
      scopeDisposeTimeoutMs: positiveSafeInteger(tool.scopeDisposeTimeoutMs),
      maxAttempts: 1,
      timeouts: Object.freeze(timeouts.map((timeout) => Object.freeze(timeout))),
    }),
  });
}

function parsePendingToolBatch(value: BoundaryJsonValue): AgentExecutionPendingToolBatch {
  const record = closed(value, ["step", "responseIndex", "assistantMessageIndex", "nextToolIndex"]);
  return Object.freeze({
    step: nonNegativeInteger(record.step),
    responseIndex: nonNegativeInteger(record.responseIndex),
    assistantMessageIndex: nonNegativeInteger(record.assistantMessageIndex),
    nextToolIndex: nonNegativeInteger(record.nextToolIndex),
  });
}

function parseTerminal(value: BoundaryJsonValue): AgentExecutionTerminalState {
  const record = closed(value, ["status", "finalMessage", "hasOutput", "output", "error"]);
  if (record.status !== "completed" && record.status !== "failed") throw invalid();
  if (typeof record.hasOutput !== "boolean" || (!record.hasOutput && record.output !== null)) throw invalid();
  if (record.status === "completed" && record.error !== null) throw invalid();
  if (record.status === "failed" && record.error === null) throw invalid();
  return freezeWithoutUndefined({
    status: record.status,
    finalMessage: record.finalMessage === null ? undefined : parseMessage(record.finalMessage),
    output: record.hasOutput ? asJsonValue(record.output) : undefined,
    error: record.error === null ? undefined : parseToolError(record.error),
  });
}

function parseResponse(value: BoundaryJsonValue): AgentExecutionResponse {
  const record = closed(value, ["invocationId", "finishReason", "message", "toolCalls", "usage", "metadata"]);
  if (typeof record.finishReason !== "string" || !FINISH_REASONS.has(record.finishReason)) throw invalid();
  return Object.freeze({
    invocationId: requiredString(record.invocationId),
    finishReason: record.finishReason as AgentModelResponse["finishReason"],
    message: record.message === null ? undefined : parseMessage(record.message),
    toolCalls: Object.freeze(parseArray(record.toolCalls, parseToolCall)),
    usage: record.usage === null ? undefined : parseUsage(record.usage),
    metadata: asJsonObject(record.metadata),
  });
}

function parseUsage(value: BoundaryJsonValue): NonNullable<AgentModelResponse["usage"]> {
  const record = closed(value, ["inputTokens", "outputTokens", "totalTokens", "latencyMs", "cost", "cacheHit"]);
  if (record.cacheHit !== null && typeof record.cacheHit !== "boolean") throw invalid();
  const cost = record.cost === null ? undefined : parseCost(record.cost);
  return freezeWithoutUndefined({
    inputTokens: record.inputTokens === null ? undefined : nonNegativeInteger(record.inputTokens),
    outputTokens: record.outputTokens === null ? undefined : nonNegativeInteger(record.outputTokens),
    totalTokens: record.totalTokens === null ? undefined : nonNegativeInteger(record.totalTokens),
    latencyMs: record.latencyMs === null ? undefined : nonNegativeInteger(record.latencyMs),
    cost,
    cacheHit: record.cacheHit === null ? undefined : record.cacheHit,
  });
}

function parseCost(value: BoundaryJsonValue): NonNullable<NonNullable<AgentModelResponse["usage"]>["cost"]> {
  const record = closed(value, ["amount", "currency"]);
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount) || record.amount < 0) throw invalid();
  return Object.freeze({ amount: record.amount, currency: requiredString(record.currency) });
}

function parseMessage(value: BoundaryJsonValue): AgentMessage {
  const record = closed(value, ["role", "content", "id", "name", "toolCallId", "createdAtUnixMs", "metadata"]);
  if (record.role !== "system" && record.role !== "developer" && record.role !== "user" && record.role !== "assistant" && record.role !== "tool") throw invalid();
  return agentMessage(record.role, parseArray(record.content, parseContentPart), {
    id: record.id === null ? undefined : requiredString(record.id),
    name: record.name === null ? undefined : requiredString(record.name),
    toolCallId: record.toolCallId === null ? undefined : requiredString(record.toolCallId),
    createdAtUnixMs: record.createdAtUnixMs === null ? undefined : nonNegativeInteger(record.createdAtUnixMs),
    metadata: asJsonObject(record.metadata),
  });
}

function parseContentPart(value: BoundaryJsonValue): AgentContentPart {
  const record = object(value);
  if (record.kind === "text") {
    const text = closed(record, ["kind", "text"]);
    return agentText(requiredString(text.text));
  }
  if (record.kind === "data") {
    const data = closed(record, ["kind", "value", "name"]);
    return agentData(asJsonValue(data.value), { name: data.name === null ? undefined : requiredString(data.name) });
  }
  if (record.kind === "tool-call") {
    const call = closed(record, ["kind", "call"]);
    return agentToolCallPart(parseToolCall(call.call));
  }
  if (record.kind === "tool-result") {
    const result = closed(record, ["kind", "result"]);
    return agentToolResultPart(parseToolResult(result.result));
  }
  throw invalid();
}

function parseToolCall(value: BoundaryJsonValue): AgentToolCall {
  const record = closed(value, ["id", "name", "input", "metadata"]);
  return agentToolCall({
    id: requiredString(record.id),
    name: requiredString(record.name),
    input: asJsonValue(record.input),
    metadata: asJsonObject(record.metadata),
  });
}

function parseToolResult(value: BoundaryJsonValue): AgentToolResult {
  const record = closed(value, ["callId", "name", "status", "output", "error", "durationMs", "metadata"]);
  if (typeof record.status !== "string" || !TOOL_STATUSES.has(record.status)) throw invalid();
  if ((record.status === "success" && record.error !== null) || (record.status !== "success" && record.error === null)) throw invalid();
  if (record.status !== "success" && record.output !== null) throw invalid();
  return agentToolResult({
    callId: requiredString(record.callId),
    name: requiredString(record.name),
    status: record.status as AgentToolResult["status"],
    output: record.output === null ? undefined : asJsonValue(record.output),
    error: record.error === null ? undefined : parseToolError(record.error),
    durationMs: record.durationMs === null ? undefined : nonNegativeInteger(record.durationMs),
    metadata: asJsonObject(record.metadata),
  });
}

function parseToolError(value: BoundaryJsonValue): AgentToolError {
  const record = closed(value, ["code", "message", "details"]);
  return freezeWithoutUndefined({
    code: record.code === null ? undefined : requiredString(record.code),
    message: requiredString(record.message),
    details: record.details === null ? undefined : asJsonValue(record.details),
  });
}

function validateCheckpoint(checkpoint: AgentExecutionCheckpointV1): void {
  const seen = new Set<string>();
  const recomputedSeen: string[] = [];
  const transcriptResults: AgentToolResult[] = [];
  for (const message of checkpoint.messages) {
    for (const part of message.content) {
      if (part.kind !== "tool-call") continue;
      if (seen.has(part.call.id)) throw invalid();
      seen.add(part.call.id);
      recomputedSeen.push(part.call.id);
    }
    if (message.role === "tool") {
      const result = message.content[0];
      if (result?.kind !== "tool-result") throw invalid();
      transcriptResults.push(result.result);
    }
  }
  if (!sameStringList(checkpoint.seenToolCallIds, recomputedSeen)) throw invalid();
  if (!sameResults(checkpoint.toolResults, transcriptResults)) throw invalid();
  for (const response of checkpoint.responses) {
    if (response.invocationId !== checkpoint.invocation.invocationId) throw invalid();
  }

  if (checkpoint.phase === "ready-model") {
    if (checkpoint.pendingToolBatch !== undefined || checkpoint.terminal !== undefined) throw invalid();
    assertAdmittedResponseBatches(checkpoint.responses, checkpoint.messages);
    assertCompleteTranscript(checkpoint.messages);
    return;
  }
  if (checkpoint.phase === "terminal") {
    if (checkpoint.terminal === undefined) throw invalid();
    if (checkpoint.terminal.status === "failed" && checkpoint.pendingToolBatch !== undefined) {
      validateUnknownPrefixTerminal(checkpoint);
      return;
    }
    if (checkpoint.terminal.status === "failed" && isRejectedProviderTerminal(checkpoint)) {
      validateRejectedProviderTerminal(checkpoint);
      return;
    }
    if (checkpoint.pendingToolBatch !== undefined) throw invalid();
    assertAdmittedResponseBatches(checkpoint.responses, checkpoint.messages);
    assertCompleteTranscript(checkpoint.messages);
    return;
  }
  if (checkpoint.pendingToolBatch === undefined || checkpoint.terminal !== undefined) throw invalid();
  assertAdmittedResponseBatches(checkpoint.responses, checkpoint.messages);
  validatePendingBatch(checkpoint);
}

function assertAdmittedResponseBatches(
  responses: readonly AgentExecutionResponse[],
  messages: readonly AgentMessage[],
): void {
  const responseBatches = responses.filter((response) => response.toolCalls.length > 0);
  const assistantBatches = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.filter((part): part is Extract<AgentContentPart, { readonly kind: "tool-call" }> => part.kind === "tool-call"))
    .filter((calls) => calls.length > 0);
  if (responseBatches.length !== assistantBatches.length) throw invalid();
  for (let batchIndex = 0; batchIndex < responseBatches.length; batchIndex += 1) {
    const response = responseBatches[batchIndex]!;
    assertSemanticResponse(response);
    const assistantCalls = assistantBatches[batchIndex]!;
    if (response.toolCalls.length !== assistantCalls.length) throw invalid();
    for (let callIndex = 0; callIndex < response.toolCalls.length; callIndex += 1) {
      if (!sameCall(response.toolCalls[callIndex]!, assistantCalls[callIndex]!.call)) throw invalid();
    }
  }
  for (const response of responses) assertSemanticResponse(response);
}

function assertSemanticResponse(response: AgentExecutionResponse): void {
  try {
    agentModelResponse(response);
  } catch {
    throw invalid();
  }
}

function validateUnknownPrefixTerminal(checkpoint: AgentExecutionCheckpointV1): void {
  const terminal = checkpoint.terminal!;
  const pending = checkpoint.pendingToolBatch!;
  if (terminal.error?.code !== "AGENT_TOOL_OUTCOME_UNKNOWN" || terminal.finalMessage !== undefined || terminal.output !== undefined) throw invalid();
  assertAdmittedResponseBatches(checkpoint.responses, checkpoint.messages);
  validatePendingBatch(checkpoint);
  if (pending.nextToolIndex < 1) throw invalid();
  const response = checkpoint.responses[pending.responseIndex]!;
  const result = checkpoint.toolResults[checkpoint.toolResults.length - 1];
  const expectedCall = response.toolCalls[pending.nextToolIndex - 1];
  if (result === undefined || expectedCall === undefined || result.callId !== expectedCall.id || result.name !== expectedCall.name || result.error?.code?.endsWith("_OUTCOME_UNKNOWN") !== true) throw invalid();
}

function isRejectedProviderTerminal(checkpoint: AgentExecutionCheckpointV1): boolean {
  const terminal = checkpoint.terminal!;
  const responseBatches = checkpoint.responses.filter((response) => response.toolCalls.length > 0).length;
  const assistantBatches = checkpoint.messages.filter((message) => message.role === "assistant" && message.content.some((part) => part.kind === "tool-call")).length;
  return checkpoint.pendingToolBatch === undefined
    && terminal.status === "failed"
    && terminal.finalMessage === undefined
    && terminal.output === undefined
    && responseBatches > assistantBatches;
}

function validateRejectedProviderTerminal(checkpoint: AgentExecutionCheckpointV1): void {
  const terminal = checkpoint.terminal!;
  const rejected = checkpoint.responses[checkpoint.responses.length - 1]!;
  if (rejected.toolCalls.length === 0) throw invalid();
  const admitted = checkpoint.responses.slice(0, -1);
  assertAdmittedResponseBatches(admitted, checkpoint.messages);
  assertCompleteTranscript(checkpoint.messages);
  const limit = checkpoint.invocation.options.maxToolCallsPerStep;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) throw invalid();
  const errorCode = terminal.error?.code;
  if (rejected.toolCalls.length > limit) {
    if (errorCode !== "AGENT_TOOL_CALL_LIMIT_EXCEEDED") throw invalid();
    return;
  }
  const ids = new Set<string>();
  const duplicateOrReused = rejected.toolCalls.some((call) => {
    if (ids.has(call.id) || checkpoint.seenToolCallIds.includes(call.id)) return true;
    ids.add(call.id);
    return false;
  });
  if (duplicateOrReused) {
    if (errorCode !== "AGENT_PROVIDER_RESPONSE_INVALID") throw invalid();
    return;
  }
  if (rejected.message !== undefined && rejected.message.role !== "assistant") {
    if (errorCode !== "AGENT_PROVIDER_RESPONSE_INVALID") throw invalid();
    return;
  }
  throw invalid();
}

function validatePendingBatch(checkpoint: AgentExecutionCheckpointV1): void {
  const pending = checkpoint.pendingToolBatch!;
  if (pending.step !== checkpoint.steps || pending.step < 1 || pending.responseIndex !== checkpoint.responses.length - 1) throw invalid();
  const response = checkpoint.responses[pending.responseIndex];
  const assistant = checkpoint.messages[pending.assistantMessageIndex];
  if (response === undefined || assistant === undefined || assistant.role !== "assistant") throw invalid();
  if (response.toolCalls.length === 0 || pending.nextToolIndex >= response.toolCalls.length) throw invalid();
  assertCompleteTranscript(checkpoint.messages.slice(0, pending.assistantMessageIndex));
  const assistantCalls = assistant.content.filter((part): part is Extract<AgentContentPart, { readonly kind: "tool-call" }> => part.kind === "tool-call");
  if (assistantCalls.length !== response.toolCalls.length) throw invalid();
  for (let index = 0; index < response.toolCalls.length; index += 1) {
    if (!sameCall(assistantCalls[index]!.call, response.toolCalls[index]!)) throw invalid();
  }
  if (checkpoint.messages.length !== pending.assistantMessageIndex + 1 + pending.nextToolIndex) throw invalid();
  for (let index = 0; index < pending.nextToolIndex; index += 1) {
    const resultMessage = checkpoint.messages[pending.assistantMessageIndex + 1 + index];
    const call = response.toolCalls[index]!;
    if (resultMessage?.role !== "tool" || resultMessage.toolCallId !== call.id) throw invalid();
    const part = resultMessage.content[0];
    if (part?.kind !== "tool-result" || part.result.callId !== call.id || part.result.name !== call.name) throw invalid();
  }
}

function assertCompleteTranscript(messages: readonly AgentMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool") throw invalid();
    if (message.role !== "assistant") continue;
    const calls = message.content.filter((part): part is Extract<AgentContentPart, { readonly kind: "tool-call" }> => part.kind === "tool-call");
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const resultMessage = messages[index + 1 + callIndex];
      const call = calls[callIndex]!.call;
      const part = resultMessage?.content[0];
      if (resultMessage?.role !== "tool" || resultMessage.toolCallId !== call.id || part?.kind !== "tool-result" || part.result.callId !== call.id || part.result.name !== call.name) throw invalid();
    }
    index += calls.length;
  }
}

function checkpointRecord(checkpoint: AgentExecutionCheckpointV1): Record<string, unknown> {
  return {
    version: checkpoint.version,
    invocation: {
      kind: checkpoint.invocation.kind,
      invocationId: checkpoint.invocation.invocationId,
      agentName: checkpoint.invocation.agentName,
      taskName: checkpoint.invocation.taskName ?? null,
      input: checkpoint.invocation.input,
      metadata: checkpoint.invocation.metadata,
      options: checkpoint.invocation.options,
    },
    phase: checkpoint.phase,
    steps: checkpoint.steps,
    messages: checkpoint.messages.map(messageRecord),
    responses: checkpoint.responses.map(responseRecord),
    toolResults: checkpoint.toolResults.map(toolResultRecord),
    seenToolCallIds: checkpoint.seenToolCallIds,
    pendingToolBatch: checkpoint.pendingToolBatch ?? null,
    terminal: checkpoint.terminal === undefined ? null : terminalRecord(checkpoint.terminal),
  };
}

function responseRecord(response: AgentExecutionResponse): Record<string, unknown> {
  return {
    invocationId: response.invocationId,
    finishReason: response.finishReason,
    message: response.message === undefined ? null : messageRecord(response.message),
    toolCalls: response.toolCalls.map(toolCallRecord),
    usage: response.usage === undefined ? null : {
      inputTokens: response.usage.inputTokens ?? null,
      outputTokens: response.usage.outputTokens ?? null,
      totalTokens: response.usage.totalTokens ?? null,
      latencyMs: response.usage.latencyMs ?? null,
      cost: response.usage.cost ?? null,
      cacheHit: response.usage.cacheHit ?? null,
    },
    metadata: response.metadata,
  };
}

function messageRecord(message: AgentMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content.map(contentPartRecord),
    id: message.id ?? null,
    name: message.name ?? null,
    toolCallId: message.toolCallId ?? null,
    createdAtUnixMs: message.createdAtUnixMs ?? null,
    metadata: message.metadata,
  };
}

function contentPartRecord(part: AgentContentPart): Record<string, unknown> {
  if (part.kind === "text") return { kind: "text", text: part.text };
  if (part.kind === "data") return { kind: "data", value: part.value, name: part.name ?? null };
  if (part.kind === "tool-call") return { kind: "tool-call", call: toolCallRecord(part.call) };
  if (part.kind === "tool-result") return { kind: "tool-result", result: toolResultRecord(part.result) };
  throw invalid();
}

function toolCallRecord(call: AgentToolCall): Record<string, unknown> {
  return { id: call.id, name: call.name, input: call.input, metadata: call.metadata };
}

function toolResultRecord(result: AgentToolResult): Record<string, unknown> {
  return {
    callId: result.callId,
    name: result.name,
    status: result.status,
    output: result.output ?? null,
    error: result.error === undefined ? null : { code: result.error.code ?? null, message: result.error.message, details: result.error.details ?? null },
    durationMs: result.durationMs ?? null,
    metadata: result.metadata,
  };
}

function terminalRecord(terminal: AgentExecutionTerminalState): Record<string, unknown> {
  return {
    status: terminal.status,
    finalMessage: terminal.finalMessage === undefined ? null : messageRecord(terminal.finalMessage),
    hasOutput: terminal.output !== undefined,
    output: terminal.output ?? null,
    error: terminal.error === undefined ? null : { code: terminal.error.code ?? null, message: terminal.error.message, details: terminal.error.details ?? null },
  };
}

function closed<const Keys extends readonly string[]>(
  value: BoundaryJsonValue,
  keys: Keys,
): { readonly [Key in Keys[number]]: BoundaryJsonValue } {
  const record = object(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid();
  const output = Object.create(null) as Record<Keys[number], BoundaryJsonValue>;
  for (const key of keys as readonly Keys[number][]) output[key] = record[key]!;
  return Object.freeze(output);
}

function object(value: BoundaryJsonValue): BoundaryJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as BoundaryJsonObject;
}

function parseArray<T>(value: BoundaryJsonValue, parse: (item: BoundaryJsonValue) => T): T[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(parse);
}

function asJsonValue(value: BoundaryJsonValue): JsonValue {
  return value as JsonValue;
}

function asJsonObject(value: BoundaryJsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as JsonObject;
}

function requiredString(value: BoundaryJsonValue): string {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  return value;
}

function nonNegativeInteger(value: BoundaryJsonValue): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function positiveSafeInteger(value: BoundaryJsonValue): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
}

function nullablePositiveSafeInteger(value: BoundaryJsonValue): number | null {
  return value === null ? null : positiveSafeInteger(value);
}

function nullableTemperature(value: BoundaryJsonValue): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) throw invalid();
  return value;
}

function isPhase(value: BoundaryJsonValue): value is AgentExecutionPhase {
  return typeof value === "string" && PHASES.has(value);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCall(left: AgentToolCall, right: AgentToolCall): boolean {
  return canonicalBoundaryJsonV1(toolCallRecord(left)) === canonicalBoundaryJsonV1(toolCallRecord(right));
}

function sameResults(left: readonly AgentToolResult[], right: readonly AgentToolResult[]): boolean {
  return left.length === right.length && left.every((result, index) => canonicalBoundaryJsonV1(toolResultRecord(result)) === canonicalBoundaryJsonV1(toolResultRecord(right[index]!)));
}

function freezeWithoutUndefined<T extends object>(value: T): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T);
}

function invalid(): AgentExecutionStateError {
  return new AgentExecutionStateError();
}
