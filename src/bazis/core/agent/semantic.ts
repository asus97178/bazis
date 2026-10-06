import { AgentSemanticError } from "./errors";
import type { ToolApproval, ToolSideEffect } from "./metadata";

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type AgentMessageRole = "system" | "developer" | "user" | "assistant" | "tool";
export type AgentContentPart =
  | AgentTextPart
  | AgentDataPart
  | AgentImagePart
  | AgentFilePart
  | AgentToolCallPart
  | AgentToolResultPart;
export type AgentContentInput = string | AgentContentPart | readonly AgentContentPart[];

export interface AgentTextPart {
  readonly kind: "text";
  readonly text: string;
}

export interface AgentDataPart {
  readonly kind: "data";
  readonly value: JsonValue;
  readonly name?: string;
}

export interface AgentImagePart {
  readonly kind: "image";
  readonly uri: string;
  readonly mediaType?: string;
  readonly detail: "auto" | "low" | "high";
}

export interface AgentFilePart {
  readonly kind: "file";
  readonly uri: string;
  readonly mediaType?: string;
  readonly name?: string;
}

export interface AgentToolResultPart {
  readonly kind: "tool-result";
  readonly result: AgentToolResult;
}

/** Provider-neutral assistant tool-call transcript part. */
export interface AgentToolCallPart {
  readonly kind: "tool-call";
  readonly call: AgentToolCall;
}

export interface AgentMessage {
  readonly role: AgentMessageRole;
  readonly content: readonly AgentContentPart[];
  readonly id?: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly createdAtUnixMs?: number;
  readonly metadata: JsonObject;
}

export interface AgentMessageOptions {
  readonly id?: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly createdAtUnixMs?: number;
  readonly metadata?: unknown;
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly metadata: JsonObject;
}

export interface AgentToolCallOptions {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
  readonly metadata?: unknown;
}

export type AgentToolResultStatus = "success" | "error" | "denied";

export interface AgentToolError {
  readonly code?: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface AgentToolResult {
  readonly callId: string;
  readonly name: string;
  readonly status: AgentToolResultStatus;
  readonly output?: JsonValue;
  readonly error?: AgentToolError;
  readonly durationMs?: number;
  readonly metadata: JsonObject;
}

export interface AgentToolResultOptions {
  readonly callId: string;
  readonly name: string;
  readonly status?: AgentToolResultStatus;
  readonly output?: unknown;
  readonly error?: AgentToolErrorInput;
  readonly durationMs?: number;
  readonly metadata?: unknown;
}

export interface AgentToolErrorInput {
  readonly code?: string;
  readonly message: string;
  readonly details?: unknown;
}

export type AgentSchemaContract =
  | AgentJsonSchemaContract
  | AgentClassSchemaContract;

export interface AgentJsonSchemaContract {
  readonly kind: "json-schema";
  readonly name: string;
  readonly schema: JsonObject;
  readonly strict: boolean;
}

export interface AgentClassSchemaContract {
  readonly kind: "class";
  readonly name: string;
  readonly strict: boolean;
}

export type AgentOutputMode = "text" | "json" | "artifact";

export interface AgentOutputContract {
  readonly mode: AgentOutputMode;
  readonly description?: string;
  readonly schema?: AgentSchemaContract;
  readonly artifactType?: string;
}

export interface AgentOutputContractOptions {
  readonly mode: AgentOutputMode;
  readonly description?: string;
  readonly schema?: AgentSchemaContract;
  readonly artifactType?: string;
}

export interface AgentToolContract {
  readonly name: string;
  readonly description: string;
  readonly input?: AgentSchemaContract;
  readonly output?: AgentSchemaContract;
  readonly sideEffect: ToolSideEffect;
  readonly approval: ToolApproval;
  readonly timeoutMs?: number;
}

export interface AgentToolContractOptions {
  readonly name: string;
  readonly description: string;
  readonly input?: AgentSchemaContract;
  readonly output?: AgentSchemaContract;
  readonly sideEffect?: ToolSideEffect;
  readonly approval?: ToolApproval;
  readonly timeoutMs?: number;
}

export interface AgentModelCapabilities {
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly jsonMode: boolean;
  readonly multimodalInput: boolean;
  readonly imageOutput: boolean;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentModelCapabilitiesOptions {
  readonly toolCalling?: boolean;
  readonly streaming?: boolean;
  readonly structuredOutput?: boolean;
  readonly jsonMode?: boolean;
  readonly multimodalInput?: boolean;
  readonly imageOutput?: boolean;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentInvocation {
  readonly id: string;
  readonly agentName: string;
  readonly input?: JsonValue;
  readonly messages: readonly AgentMessage[];
  readonly output?: AgentOutputContract;
  readonly createdAtUnixMs?: number;
  readonly metadata: JsonObject;
}

export interface AgentInvocationOptions {
  readonly id: string;
  readonly agentName: string;
  readonly input?: unknown;
  readonly messages?: readonly AgentMessage[];
  readonly output?: AgentOutputContract;
  readonly createdAtUnixMs?: number;
  readonly metadata?: unknown;
}

export interface AgentModelRequest {
  readonly invocationId: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentToolContract[];
  readonly output?: AgentOutputContract;
  readonly capabilities?: AgentModelCapabilities;
  readonly modelProfile?: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata: JsonObject;
}

export interface AgentModelRequestOptions {
  readonly invocationId: string;
  readonly messages: readonly AgentMessage[];
  readonly tools?: readonly AgentToolContract[];
  readonly output?: AgentOutputContract;
  readonly capabilities?: AgentModelCapabilities;
  readonly modelProfile?: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: unknown;
}

export type AgentFinishReason = "stop" | "tool-calls" | "length" | "content-filter" | "error";

export interface AgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly latencyMs?: number;
  readonly cost?: AgentUsageCost;
  readonly cacheHit?: boolean;
}

export interface AgentUsageCost {
  readonly amount: number;
  readonly currency: string;
}

export interface AgentUsageInput {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly latencyMs?: number;
  readonly cost?: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly cacheHit?: boolean;
}

export interface AgentModelResponse {
  readonly invocationId: string;
  readonly finishReason: AgentFinishReason;
  readonly message?: AgentMessage;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage?: AgentUsage;
  readonly metadata: JsonObject;
}

export interface AgentModelResponseOptions {
  readonly invocationId: string;
  readonly finishReason: AgentFinishReason;
  readonly message?: AgentMessage;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly usage?: AgentUsageInput;
  readonly metadata?: unknown;
}

export type AgentStreamEvent =
  | AgentMessageDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentUsageEvent
  | AgentDoneEvent
  | AgentErrorEvent;

export interface AgentMessageDeltaEvent {
  readonly kind: "message-delta";
  readonly invocationId: string;
  readonly text: string;
}

export interface AgentToolCallEvent {
  readonly kind: "tool-call";
  readonly invocationId: string;
  readonly toolCall: AgentToolCall;
}

export interface AgentToolResultEvent {
  readonly kind: "tool-result";
  readonly invocationId: string;
  readonly toolResult: AgentToolResult;
}

export interface AgentUsageEvent {
  readonly kind: "usage";
  readonly invocationId: string;
  readonly usage: AgentUsage;
}

export interface AgentDoneEvent {
  readonly kind: "done";
  readonly response: AgentModelResponse;
}

export interface AgentErrorEvent {
  readonly kind: "error";
  readonly invocationId: string;
  readonly error: AgentToolError;
}

export function normalizeJsonValue(value: unknown, field = "value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentSemanticError(`${field} must be a finite JSON number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      normalized.push(normalizeJsonValue(value[index], `${field}[${index}]`));
    }
    return Object.freeze(normalized);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentSemanticError(`${field} must be a plain JSON object.`);
    }
    const normalized: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        throw new AgentSemanticError(`${field}.${key} is not an allowed JSON key.`);
      }
      if (item === undefined) {
        throw new AgentSemanticError(`${field}.${key} must not be undefined.`);
      }
      normalized[key] = normalizeJsonValue(item, `${field}.${key}`);
    }
    return Object.freeze(normalized) as JsonObject;
  }
  throw new AgentSemanticError(`${field} must be JSON-serializable.`);
}

export function agentOutput<T = never>(): T {
  throw new AgentSemanticError("agentOutput() is an agent task marker and must not be called directly.");
}

export function agentText(text: string): AgentTextPart {
  const value = requiredContentText(text, "text");
  return Object.freeze({ kind: "text", text: value });
}

export function agentData(value: unknown, options: { readonly name?: string } = {}): AgentDataPart {
  const part: AgentDataPart = {
    kind: "data",
    value: normalizeJsonValue(value, "data"),
    name: optionalName(options.name, "data.name"),
  };
  return freezeWithoutUndefined(part);
}

export function agentImage(
  uri: string,
  options: { readonly mediaType?: string; readonly detail?: "auto" | "low" | "high" } = {},
): AgentImagePart {
  const detail = options.detail ?? "auto";
  if (detail !== "auto" && detail !== "low" && detail !== "high") {
    throw new AgentSemanticError("image.detail must be auto, low or high.");
  }
  return freezeWithoutUndefined({
    kind: "image",
    uri: requiredName(uri, "image.uri"),
    mediaType: optionalName(options.mediaType, "image.mediaType"),
    detail,
  });
}

export function agentFile(uri: string, options: { readonly mediaType?: string; readonly name?: string } = {}): AgentFilePart {
  return freezeWithoutUndefined({
    kind: "file",
    uri: requiredName(uri, "file.uri"),
    mediaType: optionalName(options.mediaType, "file.mediaType"),
    name: optionalName(options.name, "file.name"),
  });
}

export function agentToolResultPart(result: AgentToolResult): AgentToolResultPart {
  return Object.freeze({ kind: "tool-result", result: normalizeToolResult(result) });
}

export function agentToolCallPart(call: AgentToolCall): AgentToolCallPart {
  return Object.freeze({ kind: "tool-call", call: agentToolCall(call) });
}

export function agentMessage(role: AgentMessageRole, content: AgentContentInput, options: AgentMessageOptions = {}): AgentMessage {
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new AgentSemanticError("message.role is not supported.");
  }
  const parts = normalizeContent(content);
  if (role === "tool" && options.toolCallId === undefined) {
    throw new AgentSemanticError('tool messages require "toolCallId".');
  }
  if (role !== "tool" && options.toolCallId !== undefined) {
    throw new AgentSemanticError('only tool messages may have "toolCallId".');
  }
  if (role !== "assistant" && parts.some((part) => part.kind === "tool-call")) {
    throw new AgentSemanticError("tool-call content parts require an assistant message.");
  }
  const resultParts = parts.filter((part) => part.kind === "tool-result");
  if (role === "tool") {
    if (parts.length !== 1 || resultParts.length !== 1) {
      throw new AgentSemanticError("tool messages require exactly one tool-result content part.");
    }
    if (resultParts[0]?.result.callId !== options.toolCallId) {
      throw new AgentSemanticError("tool message toolCallId must match its tool-result callId.");
    }
  } else if (resultParts.length > 0) {
    throw new AgentSemanticError("tool-result content parts require a tool message.");
  }

  return freezeWithoutUndefined({
    role,
    content: parts,
    id: optionalName(options.id, "message.id"),
    name: optionalName(options.name, "message.name"),
    toolCallId: optionalName(options.toolCallId, "message.toolCallId"),
    createdAtUnixMs: optionalNonNegativeInteger(options.createdAtUnixMs, "message.createdAtUnixMs"),
    metadata: normalizeJsonObject(options.metadata ?? {}, "message.metadata"),
  });
}

export function agentToolCall(options: AgentToolCallOptions): AgentToolCall {
  return Object.freeze({
    id: requiredName(options.id, "toolCall.id"),
    name: requiredName(options.name, "toolCall.name"),
    input: normalizeJsonValue(options.input ?? {}, "toolCall.input"),
    metadata: normalizeJsonObject(options.metadata ?? {}, "toolCall.metadata"),
  });
}

export function agentToolResult(options: AgentToolResultOptions): AgentToolResult {
  const status = options.status ?? (options.error ? "error" : "success");
  if (status !== "success" && status !== "error" && status !== "denied") {
    throw new AgentSemanticError("toolResult.status must be success, error or denied.");
  }
  if (status === "success" && options.error !== undefined) {
    throw new AgentSemanticError("successful tool results cannot include error.");
  }
  if (status !== "success" && options.error === undefined) {
    throw new AgentSemanticError("failed or denied tool results require error.");
  }
  if (status !== "success" && options.output !== undefined) {
    throw new AgentSemanticError("failed or denied tool results cannot include output.");
  }

  return freezeWithoutUndefined({
    callId: requiredName(options.callId, "toolResult.callId"),
    name: requiredName(options.name, "toolResult.name"),
    status,
    output: status === "success" ? normalizeJsonValue(options.output ?? null, "toolResult.output") : undefined,
    error: options.error ? normalizeToolError(options.error, "toolResult.error") : undefined,
    durationMs: optionalNonNegativeInteger(options.durationMs, "toolResult.durationMs"),
    metadata: normalizeJsonObject(options.metadata ?? {}, "toolResult.metadata"),
  });
}

export function agentJsonSchema(name: string, schema: unknown, options: { readonly strict?: boolean } = {}): AgentJsonSchemaContract {
  if (options.strict !== undefined && typeof options.strict !== "boolean") throw new AgentSemanticError("schema.strict must be a boolean.");
  return Object.freeze({
    kind: "json-schema",
    name: requiredName(name, "schema.name"),
    schema: normalizeJsonObject(schema, "schema"),
    strict: options.strict ?? true,
  });
}

export function agentClassSchema(name: string, options: { readonly strict?: boolean } = {}): AgentClassSchemaContract {
  if (options.strict !== undefined && typeof options.strict !== "boolean") throw new AgentSemanticError("schema.strict must be a boolean.");
  return Object.freeze({
    kind: "class",
    name: requiredName(name, "schema.name"),
    strict: options.strict ?? true,
  });
}

export function agentOutputContract(options: AgentOutputContractOptions): AgentOutputContract {
  if (options.mode !== "text" && options.mode !== "json" && options.mode !== "artifact") {
    throw new AgentSemanticError("output.mode must be text, json or artifact.");
  }
  if (options.mode === "artifact" && options.artifactType === undefined) {
    throw new AgentSemanticError("artifact output requires artifactType.");
  }
  return freezeWithoutUndefined({
    mode: options.mode,
    description: optionalContentText(options.description, "output.description"),
    schema: options.schema === undefined ? undefined : normalizeSchemaContract(options.schema),
    artifactType: optionalName(options.artifactType, "output.artifactType"),
  });
}

export function agentToolContract(options: AgentToolContractOptions): AgentToolContract {
  const sideEffect = options.sideEffect ?? "none";
  if (sideEffect !== "none" && sideEffect !== "read" && sideEffect !== "write" && sideEffect !== "external") {
    throw new AgentSemanticError("tool.sideEffect must be none, read, write or external.");
  }
  const approval = options.approval ?? (sideEffect === "write" || sideEffect === "external" ? "required" : "policy");
  if (approval !== "never" && approval !== "policy" && approval !== "required") {
    throw new AgentSemanticError("tool.approval must be never, policy or required.");
  }
  if ((sideEffect === "write" || sideEffect === "external") && approval === "never") {
    throw new AgentSemanticError('write/external tools cannot use approval: "never".');
  }
  return freezeWithoutUndefined({
    name: requiredName(options.name, "tool.name"),
    description: requiredContentText(options.description, "tool.description"),
    input: options.input === undefined ? undefined : normalizeSchemaContract(options.input),
    output: options.output === undefined ? undefined : normalizeSchemaContract(options.output),
    sideEffect,
    approval,
    timeoutMs: optionalPositiveInteger(options.timeoutMs, "tool.timeoutMs"),
  });
}

export function agentModelCapabilities(options: AgentModelCapabilitiesOptions = {}): AgentModelCapabilities {
  for (const name of ["toolCalling", "streaming", "structuredOutput", "jsonMode", "multimodalInput", "imageOutput"] as const) {
    const value = options[name];
    if (value !== undefined && typeof value !== "boolean") throw new AgentSemanticError(`capabilities.${name} must be a boolean.`);
  }
  return freezeWithoutUndefined({
    toolCalling: options.toolCalling ?? false,
    streaming: options.streaming ?? false,
    structuredOutput: options.structuredOutput ?? false,
    jsonMode: options.jsonMode ?? false,
    multimodalInput: options.multimodalInput ?? false,
    imageOutput: options.imageOutput ?? false,
    maxContextTokens: optionalPositiveInteger(options.maxContextTokens, "capabilities.maxContextTokens"),
    maxOutputTokens: optionalPositiveInteger(options.maxOutputTokens, "capabilities.maxOutputTokens"),
  });
}

export function agentInvocation(options: AgentInvocationOptions): AgentInvocation {
  return freezeWithoutUndefined({
    id: requiredName(options.id, "invocation.id"),
    agentName: requiredName(options.agentName, "invocation.agentName"),
    input: options.input === undefined ? undefined : normalizeJsonValue(options.input, "invocation.input"),
    messages: freezeMessageList(options.messages ?? [], "invocation.messages"),
    output: options.output === undefined ? undefined : normalizeOutputContract(options.output),
    createdAtUnixMs: optionalNonNegativeInteger(options.createdAtUnixMs, "invocation.createdAtUnixMs"),
    metadata: normalizeJsonObject(options.metadata ?? {}, "invocation.metadata"),
  });
}

export function agentModelRequest(options: AgentModelRequestOptions): AgentModelRequest {
  const messages = freezeMessageList(options.messages, "modelRequest.messages");
  if (messages.length === 0) {
    throw new AgentSemanticError("modelRequest.messages must not be empty.");
  }
  validateCompleteToolTranscript(messages);
  return freezeWithoutUndefined({
    invocationId: requiredName(options.invocationId, "modelRequest.invocationId"),
    messages,
    tools: freezeToolContracts(options.tools ?? []),
    output: options.output === undefined ? undefined : normalizeOutputContract(options.output),
    capabilities: options.capabilities === undefined ? undefined : agentModelCapabilities(options.capabilities),
    modelProfile: optionalName(options.modelProfile, "modelRequest.modelProfile"),
    model: optionalName(options.model, "modelRequest.model"),
    maxOutputTokens: optionalPositiveInteger(options.maxOutputTokens, "modelRequest.maxOutputTokens"),
    temperature: optionalProbability(options.temperature, "modelRequest.temperature"),
    metadata: normalizeJsonObject(options.metadata ?? {}, "modelRequest.metadata"),
  });
}

export function agentModelResponse(options: AgentModelResponseOptions): AgentModelResponse {
  const toolCalls = freezeToolCalls(options.toolCalls ?? []);
  if (options.finishReason === "tool-calls" && toolCalls.length === 0) {
    throw new AgentSemanticError('finishReason "tool-calls" requires at least one tool call.');
  }
  if (options.message === undefined && toolCalls.length === 0) {
    throw new AgentSemanticError("modelResponse requires a message or at least one tool call.");
  }
  const message = options.message === undefined ? undefined : agentMessage(
    options.message.role,
    options.message.content,
    { id: options.message.id, name: options.message.name, toolCallId: options.message.toolCallId, createdAtUnixMs: options.message.createdAtUnixMs, metadata: options.message.metadata },
  );
  if (message !== undefined) {
    if (message.role !== "assistant") {
      throw new AgentSemanticError("modelResponse.message must have assistant role.");
    }
    if (message.content.some((part) => part.kind === "tool-call")) {
      throw new AgentSemanticError("modelResponse tool calls belong in modelResponse.toolCalls, not message content.");
    }
  }
  return freezeWithoutUndefined({
    invocationId: requiredName(options.invocationId, "modelResponse.invocationId"),
    finishReason: normalizeFinishReason(options.finishReason),
    message,
    toolCalls,
    usage: options.usage ? normalizeUsage(options.usage) : undefined,
    metadata: normalizeJsonObject(options.metadata ?? {}, "modelResponse.metadata"),
  });
}

function normalizeContent(content: AgentContentInput): readonly AgentContentPart[] {
  if (typeof content === "string") {
    return Object.freeze([agentText(content)]);
  }
  if (isContentPartArray(content)) {
    if (content.length === 0) {
      throw new AgentSemanticError("message.content must not be empty.");
    }
    return Object.freeze(content.map((part, index) => normalizeContentPart(part, `message.content[${index}]`)));
  }
  return Object.freeze([normalizeContentPart(content, "message.content")]);
}

function isContentPartArray(content: AgentContentInput): content is readonly AgentContentPart[] {
  return Array.isArray(content);
}

function normalizeContentPart(part: AgentContentPart, field: string): AgentContentPart {
  if (!part || typeof part !== "object") {
    throw new AgentSemanticError(`${field} must be a content part.`);
  }
  switch (part.kind) {
    case "text":
      return agentText(part.text);
    case "data":
      return agentData(part.value, { name: part.name });
    case "image":
      return agentImage(part.uri, { mediaType: part.mediaType, detail: part.detail });
    case "file":
      return agentFile(part.uri, { mediaType: part.mediaType, name: part.name });
    case "tool-result":
      return agentToolResultPart(part.result);
    case "tool-call":
      return agentToolCallPart(part.call);
    default:
      throw new AgentSemanticError(`${field} has unsupported content kind.`);
  }
}

function normalizeToolResult(result: AgentToolResult): AgentToolResult {
  return agentToolResult({
    callId: result.callId,
    name: result.name,
    status: result.status,
    output: result.output,
    error: result.error,
    durationMs: result.durationMs,
    metadata: result.metadata,
  });
}

function normalizeToolError(error: AgentToolErrorInput, field: string): AgentToolError {
  return freezeWithoutUndefined({
    code: optionalName(error.code, `${field}.code`),
    message: requiredContentText(error.message, `${field}.message`),
    details: error.details === undefined ? undefined : normalizeJsonValue(error.details, `${field}.details`),
  });
}

function normalizeSchemaContract(schema: AgentSchemaContract): AgentSchemaContract {
  if (!schema || typeof schema !== "object") throw new AgentSemanticError("schema must be a schema contract.");
  if (schema.kind === "json-schema") return agentJsonSchema(schema.name, schema.schema, { strict: schema.strict });
  if (schema.kind === "class") return agentClassSchema(schema.name, { strict: schema.strict });
  throw new AgentSemanticError("schema.kind must be json-schema or class.");
}

function normalizeOutputContract(output: AgentOutputContract): AgentOutputContract {
  return agentOutputContract({ mode: output.mode, description: output.description, schema: output.schema, artifactType: output.artifactType });
}

function normalizeJsonObject(value: unknown, field: string): JsonObject {
  const normalized = normalizeJsonValue(value, field);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new AgentSemanticError(`${field} must be a JSON object.`);
  }
  return normalized as JsonObject;
}

function normalizeUsage(usage: AgentUsageInput): AgentUsage {
  if (usage.cacheHit !== undefined && typeof usage.cacheHit !== "boolean") throw new AgentSemanticError("usage.cacheHit must be a boolean.");
  return freezeWithoutUndefined({
    inputTokens: optionalNonNegativeInteger(usage.inputTokens, "usage.inputTokens"),
    outputTokens: optionalNonNegativeInteger(usage.outputTokens, "usage.outputTokens"),
    totalTokens: optionalNonNegativeInteger(usage.totalTokens, "usage.totalTokens"),
    latencyMs: optionalNonNegativeInteger(usage.latencyMs, "usage.latencyMs"),
    cost: usage.cost
      ? Object.freeze({
          amount: optionalNonNegativeNumber(usage.cost.amount, "usage.cost.amount") as number,
          currency: requiredName(usage.cost.currency, "usage.cost.currency"),
        })
      : undefined,
    cacheHit: usage.cacheHit,
  });
}

function normalizeFinishReason(reason: AgentFinishReason): AgentFinishReason {
  if (
    reason !== "stop" &&
    reason !== "tool-calls" &&
    reason !== "length" &&
    reason !== "content-filter" &&
    reason !== "error"
  ) {
    throw new AgentSemanticError("finishReason is not supported.");
  }
  return reason;
}

function freezeMessageList(messages: readonly AgentMessage[], field: string): readonly AgentMessage[] {
  const normalized: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as AgentMessage;
    if (!message || typeof message !== "object") {
      throw new AgentSemanticError(`${field}[${index}] must be an agent message.`);
    }
    normalized.push(agentMessage(message.role, message.content, {
      id: message.id,
      name: message.name,
      toolCallId: message.toolCallId,
      createdAtUnixMs: message.createdAtUnixMs,
      metadata: message.metadata,
    }));
  }
  return Object.freeze(normalized);
}

function freezeToolCalls(toolCalls: readonly AgentToolCall[]): readonly AgentToolCall[] {
  const normalized: AgentToolCall[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index] as AgentToolCall;
    const call = agentToolCall(toolCall);
    if (ids.has(call.id)) {
      throw new AgentSemanticError(`modelResponse.toolCalls contains duplicate id "${call.id}".`);
    }
    ids.add(call.id);
    normalized.push(call);
  }
  return Object.freeze(normalized);
}

function validateCompleteToolTranscript(messages: readonly AgentMessage[]): void {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (pending.size > 0 && message.role !== "tool") {
      throw new AgentSemanticError(
        "modelRequest.messages must place every tool result immediately after its assistant tool-call message.",
      );
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.kind !== "tool-call") continue;
        if (seen.has(part.call.id)) {
          throw new AgentSemanticError(`modelRequest.messages contains duplicate tool call id "${part.call.id}".`);
        }
        seen.add(part.call.id);
        pending.set(part.call.id, part.call.name);
      }
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId as string;
      const expectedName = pending.get(id);
      if (expectedName === undefined) {
        throw new AgentSemanticError(`modelRequest.messages contains orphan tool result "${id}".`);
      }
      const result = message.content[0]?.kind === "tool-result" ? message.content[0].result : undefined;
      if (result?.name !== expectedName) {
        throw new AgentSemanticError(
          `modelRequest.messages tool result "${id}" names "${result?.name ?? "<missing>"}" instead of "${expectedName}".`,
        );
      }
      pending.delete(id);
    }
  }
  if (pending.size > 0) {
    throw new AgentSemanticError("modelRequest.messages contains tool calls without results.");
  }
}

function freezeToolContracts(tools: readonly AgentToolContract[]): readonly AgentToolContract[] {
  const normalized: AgentToolContract[] = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index] as AgentToolContract;
    normalized.push(agentToolContract(tool));
  }
  return Object.freeze(normalized);
}

function requiredName(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new AgentSemanticError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentSemanticError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function optionalName(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredName(value, field);
}

function requiredContentText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new AgentSemanticError(`${field} must be a string.`);
  }
  if (value.trim().length === 0) {
    throw new AgentSemanticError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalContentText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredContentText(value, field);
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentSemanticError(`${field} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentSemanticError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalNonNegativeNumber(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentSemanticError(`${field} must be a non-negative number.`);
  }
  return value;
}

function optionalProbability(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new AgentSemanticError(`${field} must be a number between 0 and 2.`);
  }
  return value;
}

function freezeWithoutUndefined<T extends object>(value: T): Readonly<T> {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return Object.freeze(value);
}
