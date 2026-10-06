import {
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentContentPart,
  type AgentFinishReason,
  type AgentMessage,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolCall,
  type AgentToolContract,
  type JsonObject,
  type JsonValue,
  normalizeJsonValue,
} from "../../agent";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  type LlmConnectionOptions,
  type LlmProviderAdapter,
} from "./llm";
import { readOpenAiTextStream } from "./openaiTextStream";

const DEFAULT_CHAT_COMPLETIONS_PATH = "/chat/completions";
const DEFAULT_HEALTH_PATH = "/models";
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OpenAiCompatibleAdapterOptions {
  readonly fetch?: OpenAiCompatibleFetch;
  readonly chatCompletionsPath?: string;
  readonly healthPath?: string;
  readonly healthCheck?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Maximum successful provider response size. Defaults to 16 MiB. */
  readonly maxResponseBytes?: number;
}

export type OpenAiCompatibleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OpenAiCompatibleProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenAiCompatibleProviderError";
  }
}

type OpenAiChatRole = "system" | "user" | "assistant" | "tool";

interface OpenAiChatMessage {
  readonly role: OpenAiChatRole;
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

interface OpenAiToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}

interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface OpenAiChatChoice {
  readonly finish_reason?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | null;
    readonly tool_calls?: readonly OpenAiToolCall[];
  };
}

interface OpenAiChatResponse {
  readonly choices?: readonly OpenAiChatChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
  };
}

interface ToolNameMapping {
  readonly providerToBazis: ReadonlyMap<string, string>;
  readonly bazisToProvider: ReadonlyMap<string, string>;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === "string" ? error.message : String(error);
  } catch {
    return "Unknown error.";
  }
}

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null | undefined, reason?: unknown): void {
  if (body === null || body === undefined) return;
  // Cleanup is deliberately not part of the provider terminal boundary: a
  // hostile/custom stream may never settle cancel().
  void body.cancel(reason).catch(() => undefined);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function providerToolName(name: string, used: Set<string>): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefixed = /^[a-zA-Z_]/.test(replaced) ? replaced : `tool_${replaced}`;
  const trimmed = prefixed.length <= 64 ? prefixed : `${prefixed.slice(0, 55)}_${shortHash(name)}`;
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }

  const suffix = shortHash(name);
  const base = trimmed.slice(0, Math.max(1, 63 - suffix.length));
  const unique = `${base}_${suffix}`;
  if (used.has(unique)) {
    throw new OpenAiCompatibleProviderError(`Tool name "${name}" collides after OpenAI-compatible normalization.`);
  }
  used.add(unique);
  return unique;
}

function toolNameMapping(tools: readonly AgentToolContract[]): ToolNameMapping {
  const providerToBazis = new Map<string, string>();
  const bazisToProvider = new Map<string, string>();
  const used = new Set<string>();
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index] as AgentToolContract;
    const providerName = providerToolName(tool.name, used);
    providerToBazis.set(providerName, tool.name);
    bazisToProvider.set(tool.name, providerName);
  }
  return Object.freeze({ providerToBazis, bazisToProvider });
}

function schemaForTool(tool: AgentToolContract): JsonObject {
  if (tool.input?.kind === "json-schema") {
    return tool.input.schema;
  }
  return Object.freeze({
    type: "object",
    additionalProperties: true,
  });
}

function openAiTools(tools: readonly AgentToolContract[], mapping: ToolNameMapping): readonly OpenAiToolDefinition[] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: mapping.bazisToProvider.get(tool.name) ?? tool.name,
      description: tool.description,
      parameters: schemaForTool(tool),
    }),
  })));
}

function contentText(parts: readonly AgentContentPart[]): string {
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as AgentContentPart;
    switch (part.kind) {
      case "text":
        lines.push(part.text);
        break;
      case "data":
        lines.push(JSON.stringify({ name: part.name ?? null, value: part.value }));
        break;
      case "tool-result":
        // Provider transcripts contain only the model-facing result contract.
        // Internal runtime metadata, timings and duplicate protocol ids stay
        // inside Bazis and are never sent to an external LLM.
        lines.push(JSON.stringify({
          name: part.result.name,
          status: part.result.status,
          ...(part.result.output !== undefined ? { output: part.result.output } : {}),
          ...(part.result.error !== undefined ? { error: part.result.error } : {}),
        }));
        break;
      case "tool-call":
        // Assistant tool calls are represented by the protocol-level
        // `tool_calls` field, not duplicated into textual content.
        break;
      case "image":
        lines.push(JSON.stringify({ kind: "image", uri: part.uri, mediaType: part.mediaType ?? null, detail: part.detail }));
        break;
      case "file":
        lines.push(JSON.stringify({ kind: "file", uri: part.uri, mediaType: part.mediaType ?? null, name: part.name ?? null }));
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

function toOpenAiRole(role: AgentMessage["role"]): OpenAiChatRole {
  if (role === "developer") {
    return "system";
  }
  if (role === "tool") {
    return "tool";
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
}

function normalizeOpenAiResponse(value: unknown): OpenAiChatResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAiCompatibleProviderError("OpenAI-compatible response must be a JSON object.");
  }
  return value as OpenAiChatResponse;
}

function finishReasonOf(reason: string | undefined, hasToolCalls: boolean): AgentFinishReason {
  if (hasToolCalls || reason === "tool_calls") {
    return "tool-calls";
  }
  if (reason === undefined || reason === "stop") {
    return "stop";
  }
  if (reason === "length") {
    return "length";
  }
  if (reason === "content_filter") {
    return "content-filter";
  }
  return "error";
}

function parseToolArguments(raw: string, callId: string): JsonValue {
  if (raw.trim().length === 0) {
    return Object.freeze({});
  }
  try {
    return normalizeJsonValue(JSON.parse(raw), `toolCall.${callId}.arguments`);
  } catch (error) {
    throw new OpenAiCompatibleProviderError(`OpenAI-compatible tool arguments for "${callId}" are invalid JSON: ${errorMessageOf(error)}`);
  }
}

function normalizeToolCalls(
  calls: readonly OpenAiToolCall[] | undefined,
  mapping: ToolNameMapping,
): readonly AgentToolCall[] {
  if (!calls || calls.length === 0) {
    return Object.freeze([]);
  }
  const out: AgentToolCall[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index] as OpenAiToolCall;
    if (call.type !== "function") {
      throw new OpenAiCompatibleProviderError(`OpenAI-compatible tool call at index ${index} has an unsupported type.`);
    }
    if (!call.function || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") {
      throw new OpenAiCompatibleProviderError(`OpenAI-compatible tool call at index ${index} is malformed.`);
    }
    const providerName = call.function?.name;
    const name = mapping.providerToBazis.get(providerName) ?? providerName;
    out.push(agentToolCall({
      id: call.id,
      name,
      input: parseToolArguments(call.function?.arguments ?? "", call.id),
    }));
  }
  return Object.freeze(out);
}

function buildUsage(usage: OpenAiChatResponse["usage"]): AgentModelResponse["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  return Object.freeze({
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
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

export class OpenAiCompatibleModelProvider implements AgentModelProvider {
  private readonly lifetime = new AbortController();
  private readonly baseUrl: string;
  private readonly chatCompletionsPath: string;
  private readonly healthPath: string;
  private readonly fetcher: OpenAiCompatibleFetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs?: number;

  public constructor(
    private readonly connection: LlmConnectionOptions,
    options: OpenAiCompatibleAdapterOptions = {},
  ) {
    this.baseUrl = stripTrailingSlash(connection.baseUrl);
    this.chatCompletionsPath = ensureLeadingSlash(options.chatCompletionsPath ?? DEFAULT_CHAT_COMPLETIONS_PATH);
    this.healthPath = ensureLeadingSlash(options.healthPath ?? DEFAULT_HEALTH_PATH);
    this.fetcher = options.fetch ?? fetch;
    const configuredTimeout = connection.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 0) {
      throw new OpenAiCompatibleProviderError("timeoutMs must be a non-negative safe integer.");
    }
    this.requestTimeoutMs = configuredTimeout === 0 ? undefined : configuredTimeout;
    if (
      options.maxResponseBytes !== undefined
      && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
    ) {
      throw new OpenAiCompatibleProviderError("maxResponseBytes must be a positive safe integer.");
    }
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.headers = Object.freeze({
      "content-type": "application/json",
      authorization: `Bearer ${connection.apiKey}`,
      ...(options.extraHeaders ?? {}),
    });
  }

  public async complete(request: AgentModelRequest, context: AgentModelProviderContext): Promise<AgentModelResponse> {
    if (request.model !== undefined && request.model !== this.connection.model) {
      throw new OpenAiCompatibleProviderError("OpenAI-compatible request model conflicts with the configured Infra model.");
    }
    const mapping = toolNameMapping(request.tools);
    const body = this.buildBody(request, mapping);
    const onText = (!request.output || request.output.mode === "text") ? context.onTextDelta : undefined;
    if (onText) { body.stream = true; body.stream_options = { include_usage: true }; }
    const raw = await this.request(this.chatCompletionsPath, "POST", body, context.signal, onText, request.tools.length > 0);
    const parsed = normalizeOpenAiResponse(raw);
    const choice = parsed.choices?.[0];
    if (!choice) {
      throw new OpenAiCompatibleProviderError("OpenAI-compatible response does not contain choices[0].");
    }

    const providerToolCalls = choice.message?.tool_calls ?? [];
    const toolCalls = normalizeToolCalls(providerToolCalls, mapping);
    const text = typeof choice.message?.content === "string" ? choice.message.content : "";
    return agentModelResponse({
      invocationId: request.invocationId,
      finishReason: finishReasonOf(choice.finish_reason, toolCalls.length > 0),
      message: text.trim().length > 0 ? agentMessage("assistant", text) : undefined,
      toolCalls,
      usage: buildUsage(parsed.usage),
    });
  }

  public async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request(this.healthPath, "GET", undefined, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** End active requests and reject subsequent calls through this provider. */
  public dispose(): void {
    this.lifetime.abort(new OpenAiCompatibleProviderError("OpenAI-compatible provider is disposed."));
  }

  private buildBody(request: AgentModelRequest, mapping: ToolNameMapping): Record<string, unknown> {
    const tools = openAiTools(request.tools, mapping);
    const body: Record<string, unknown> = {
      model: this.connection.model,
      messages: this.messages(request.messages, mapping),
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      body.max_tokens = request.maxOutputTokens;
    }
    if (request.output?.mode === "json") {
      const schema = request.output.schema;
      if (schema?.kind === "class") {
        throw new OpenAiCompatibleProviderError(`Output schema "${schema.name}" needs generated JSON Schema metadata for this provider.`);
      }
      body.response_format = schema === undefined ? { type: "json_object" } : {
        type: "json_schema",
        json_schema: {
          name: providerToolName(schema.name, new Set()),
          strict: schema.strict,
          schema: schema.schema,
          ...(request.output.description === undefined ? {} : { description: request.output.description }),
        },
      };
    }
    return body;
  }

  private messages(messages: readonly AgentMessage[], mapping: ToolNameMapping): readonly OpenAiChatMessage[] {
    const out: OpenAiChatMessage[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] as AgentMessage;
      if (message.role === "tool") {
        out.push(Object.freeze({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: contentText(message.content),
        }));
        continue;
      }

      if (message.role === "assistant") {
        const toolCalls = message.content
          .filter((part) => part.kind === "tool-call")
          .map((part) => {
            const providerName = mapping.bazisToProvider.get(part.call.name);
            if (providerName === undefined) {
              throw new OpenAiCompatibleProviderError(
                `Assistant transcript references tool "${part.call.name}" which is absent from the request contract.`,
              );
            }
            return Object.freeze({
              id: part.call.id,
              type: "function" as const,
              function: Object.freeze({
                name: providerName,
                arguments: JSON.stringify(part.call.input),
              }),
            });
          });
        const content = contentText(message.content);
        out.push(Object.freeze({
          role: "assistant",
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 ? { tool_calls: Object.freeze(toolCalls) } : {}),
        }));
        continue;
      }

      out.push(Object.freeze({
        role: toOpenAiRole(message.role),
        content: contentText(message.content),
      }));
    }
    return Object.freeze(out);
  }

  private async request(path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal,
    onText?: (text: string) => void, allowTools = false): Promise<unknown> {
    const abort = new AbortController();
    const detach = attachAbortForwarding(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal, abort);
    const timeout = this.requestTimeoutMs === undefined
      ? undefined
      : setTimeout(() => abort.abort(new Error("OpenAI-compatible request timed out.")), this.requestTimeoutMs);
    try {
      abort.signal.throwIfAborted();
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) {
        // Cancel the provider-controlled body without exposing it: error bodies
        // may echo prompts, credentials or tenant data.
        cancelBodyBestEffort(response.body);
        throw new OpenAiCompatibleProviderError(
          `OpenAI-compatible ${method} ${path} failed with HTTP ${response.status}.`,
        );
      }
      if (response.status === 204) {
        return {};
      }
      // Keep timeout/caller abort forwarding installed until the body has been
      // fully consumed; `return promise` would run finally immediately.
      if (onText && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream") {
        return await readOpenAiTextStream(response, abort.signal, this.maxResponseBytes, onText, allowTools);
      }
      return await this.readJsonResponse(response, abort.signal);
    } finally {
      detach?.();
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async readJsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
    const advertised = response.headers.get("content-length");
    if (advertised !== null) {
      const bytes = Number(advertised);
      if (Number.isFinite(bytes) && bytes > this.maxResponseBytes) {
        cancelBodyBestEffort(response.body);
        throw new OpenAiCompatibleProviderError("OpenAI-compatible response exceeds maxResponseBytes.");
      }
    }
    if (response.body === null) {
      throw new OpenAiCompatibleProviderError("OpenAI-compatible response body is empty.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cancelReader = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    if (signal.aborted) cancelReader();
    else signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        const item = await reader.read();
        if (signal.aborted) throw new OpenAiCompatibleProviderError("OpenAI-compatible request was aborted.");
        if (item.done) break;
        total += item.value.byteLength;
        if (total > this.maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw new OpenAiCompatibleProviderError("OpenAI-compatible response exceeds maxResponseBytes.");
        }
        chunks.push(item.value);
      }
    } finally {
      signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new OpenAiCompatibleProviderError("OpenAI-compatible response contains invalid JSON.");
    }
  }
}

export function openAiCompatibleAdapter(options: OpenAiCompatibleAdapterOptions = {}): LlmProviderAdapter {
  const healthCheckEnabled = options.healthCheck ?? true;
  return {
    create(connection) {
      return new OpenAiCompatibleModelProvider(connection, options);
    },
    dispose(provider) {
      if (provider instanceof OpenAiCompatibleModelProvider) provider.dispose();
    },
    healthCheck: healthCheckEnabled
      ? (provider, signal) => provider instanceof OpenAiCompatibleModelProvider && provider.ping(signal)
      : undefined,
  };
}
