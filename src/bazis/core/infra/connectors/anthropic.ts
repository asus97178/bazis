import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  AgentModelContextOverflowError,
  AgentModelTimeoutError,
  AgentModelUnavailableError,
  agentMessage,
  agentModelResponse,
  agentReasoning,
  agentText,
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
} from "../../agent";
import { redactSensitiveText } from "../../../library/redaction";
import { InfraError } from "../InfraConnector";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, type LlmConnectionOptions, type LlmProviderAdapter } from "./llm";
import { providerToolName, toolNameMapping, type ToolNameMapping } from "./toolNames";

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** The start check is short: a provider that does not answer in five seconds is not ready. */
const START_CHECK_TIMEOUT_MS = 5_000;
/** `reasoning.data.provider` of the blocks this adapter wrote and may send back. */
const PROVIDER = "anthropic";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** The part of the SDK client the adapter uses: the Claude API client, a cloud platform's client, or a test double. */
export type AnthropicClient = Pick<Anthropic, "messages" | "models">;

export interface AnthropicAdapterOptions {
  /** `max_tokens` of a request that sets no `maxOutputTokens`. 32 000 by default. */
  readonly maxOutputTokens?: number;
  /**
   * Adaptive thinking: the model decides when and how much to think. On by
   * default; `false` sends no `thinking` setting, for a model that takes none.
   */
  readonly thinking?: boolean;
  /**
   * `"summarized"` returns a readable summary of the reasoning as the text of
   * `reasoning` parts. By default the model's own setting applies, and on
   * current models the text is empty.
   */
  readonly thinkingDisplay?: "summarized" | "omitted";
  /** How thoroughly the model works (`output_config.effort`). The model's own default when not set. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Prompt caching: the instructions, the Tools and the dialog so far are read
   * from the provider's cache on the next step at a fraction of the price.
   * `true` keeps an entry five minutes (the default), `"1h"` an hour, `false`
   * turns caching off.
   */
  readonly cache?: boolean | "1h";
  /** Check the provider in `/health`. `true` by default. */
  readonly healthCheck?: boolean;
  /** A ready SDK client instead of one built from the configuration. */
  readonly client?: AnthropicClient;
}

export class AnthropicProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnthropicProviderError";
  }
}

type Cache = { readonly type: "ephemeral"; readonly ttl?: "1h" };

function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === "string" ? error.message : String(error);
  } catch {
    return "Unknown error.";
  }
}

/** `data:<type>;base64,<bytes>` taken apart; `undefined` for an address. */
function inlineData(uri: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  return match === null ? undefined : { mediaType: match[1]!.toLowerCase(), data: match[2]! };
}

function resultText(part: Extract<AgentContentPart, { readonly kind: "tool-result" }>): string {
  // Only the model-facing result: runtime metadata and timings stay in bazis.
  return JSON.stringify(part.result.status === "success" ? part.result.output ?? null : part.result.error ?? { message: "Tool failed." });
}

/** One user-side content part as the Messages API takes it; `undefined` for a part that says nothing. */
function userBlock(part: AgentContentPart): Anthropic.ContentBlockParam | undefined {
  switch (part.kind) {
    case "text":
      return part.text.length === 0 ? undefined : { type: "text", text: part.text };
    case "data":
      return { type: "text", text: JSON.stringify({ name: part.name ?? null, value: part.value }) };
    case "image": {
      const inline = inlineData(part.uri);
      if (inline === undefined) return { type: "image", source: { type: "url", url: part.uri } };
      if (!IMAGE_TYPES.has(inline.mediaType)) throw new AnthropicProviderError(`Image type "${inline.mediaType}" is not accepted: send JPEG, PNG, GIF or WebP.`);
      return { type: "image", source: { type: "base64", media_type: inline.mediaType as Anthropic.Base64ImageSource["media_type"], data: inline.data } };
    }
    case "file": {
      const inline = inlineData(part.uri);
      const title = part.name === undefined ? {} : { title: part.name };
      if (inline === undefined) return { type: "document", source: { type: "url", url: part.uri }, ...title };
      if (inline.mediaType === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: inline.data }, ...title };
      if (inline.mediaType.startsWith("text/")) return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(inline.data, "base64").toString("utf8") }, ...title };
      throw new AnthropicProviderError(`File type "${inline.mediaType}" is not accepted: send a PDF or a text file.`);
    }
    case "tool-result":
      return { type: "tool_result", tool_use_id: part.result.callId, content: resultText(part), ...(part.result.status === "success" ? {} : { is_error: true }) };
    default:
      return undefined;
  }
}

/** One assistant content part; reasoning goes back only as this provider wrote it. */
function assistantBlock(part: AgentContentPart, mapping: ToolNameMapping, withReasoning: boolean): Anthropic.ContentBlockParam | undefined {
  switch (part.kind) {
    case "text":
      return part.text.length === 0 ? undefined : { type: "text", text: part.text };
    case "data":
      return { type: "text", text: JSON.stringify({ name: part.name ?? null, value: part.value }) };
    case "reasoning": {
      const data = part.data;
      if (!withReasoning || data === undefined || data.provider !== PROVIDER) return undefined;
      if (data.type === "thinking" && typeof data.signature === "string") return { type: "thinking", thinking: part.text, signature: data.signature };
      if (data.type === "redacted_thinking" && typeof data.data === "string") return { type: "redacted_thinking", data: data.data };
      return undefined;
    }
    case "tool-call": {
      // A call to a Tool outside this request keeps a name no request Tool uses, next to its denial.
      const name = mapping.bazisToProvider.get(part.call.name) ?? providerToolName(part.call.name, new Set(mapping.providerToBazis.keys()));
      const input = part.call.input;
      return { type: "tool_use", id: part.call.id, name, input: typeof input === "object" && input !== null && !Array.isArray(input) ? input : {} };
    }
    default:
      return undefined;
  }
}

function finishReasonOf(reason: Anthropic.Message["stop_reason"], hasToolCalls: boolean): AgentFinishReason {
  if (reason === "refusal") return "content-filter";
  if (hasToolCalls) return "tool-calls";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === null) return "stop";
  if (reason === "max_tokens") return "length";
  return "error";
}

export class AnthropicModelProvider implements AgentModelProvider {
  private readonly client: AnthropicClient;
  private readonly maxOutputTokens: number;
  private readonly cache: Cache | undefined;
  /** The window the Models API reported at the start check. */
  private reportedWindow: number | undefined;
  /** Runs whose stored reasoning the provider refused once: it is not sent again. */
  private readonly withoutReasoning = new Set<string>();

  public constructor(
    private readonly connection: LlmConnectionOptions,
    private readonly options: AnthropicAdapterOptions = {},
  ) {
    if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) {
      throw new AnthropicProviderError("maxOutputTokens must be a positive safe integer.");
    }
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.cache = options.cache === false ? undefined : options.cache === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    const configured = connection.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    this.client = options.client ?? new Anthropic({
      apiKey: connection.apiKey,
      ...(connection.baseUrl.trim().length === 0 ? {} : { baseURL: connection.baseUrl }),
      // `0` means no deadline of the connector; the runtime's own deadlines still apply.
      timeout: configured === 0 ? 60 * 60 * 1000 : configured,
      // The agent runtime repeats a request itself (`modelRetry`); two layers would multiply the attempts.
      maxRetries: 0,
    });
  }

  public async complete(request: AgentModelRequest, context: AgentModelProviderContext): Promise<AgentModelResponse> {
    if (request.model !== undefined && request.model !== this.connection.model) {
      throw new AnthropicProviderError("The request model conflicts with the configured Infra model.");
    }
    const mapping = toolNameMapping(request.tools);
    const onText = !request.output || request.output.mode === "text" ? context.onTextDelta : undefined;
    let message: Anthropic.Message;
    try {
      message = await this.send(this.params(request, mapping, !this.withoutReasoning.has(request.invocationId)), context.signal, onText);
    } catch (error) {
      if (!this.refusesStoredReasoning(error) || this.withoutReasoning.has(request.invocationId)) throw this.failure(error);
      // The dialog changed since the model reasoned about it (instructions, Tools or
      // history were edited). The request is decided before any output, so it is
      // sent once more without the reasoning; the words and Tool calls stay.
      this.rememberWithoutReasoning(request.invocationId);
      try {
        message = await this.send(this.params(request, mapping, false), context.signal, onText);
      } catch (second) {
        throw this.failure(second);
      }
    }
    return this.response(request, message, mapping);
  }

  /** The model's context window: stated by the application, or reported by the provider at the start check. */
  public contextTokens(): number | undefined {
    return this.connection.contextTokens ?? this.reportedWindow;
  }

  /** Base URL of the provider, for diagnostics. */
  public get address(): string {
    return this.connection.baseUrl;
  }

  /** Asks the provider about the configured model: a wrong key, address or model id rejects. */
  public async probe(signal?: AbortSignal): Promise<void> {
    try {
      const model = await this.client.models.retrieve(this.connection.model, undefined, { signal });
      if (typeof model.max_input_tokens === "number" && model.max_input_tokens > 0) this.reportedWindow = model.max_input_tokens;
    } catch (error) {
      throw this.failure(error);
    }
  }

  public async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.probe(signal);
      return true;
    } catch {
      return false;
    }
  }

  private async send(params: Anthropic.MessageStreamParams, signal: AbortSignal, onText: ((text: string) => void) | undefined): Promise<Anthropic.Message> {
    // Always a stream: a long answer does not run into an HTTP timeout, and the
    // SDK assembles the complete message. Tool input is left buffered (no
    // eager input streaming): nothing here shows it as it is written, and the
    // API then delivers only complete, valid JSON.
    const stream = this.client.messages.stream(params, { signal });
    if (onText !== undefined) stream.on("text", (delta) => onText(delta));
    return stream.finalMessage();
  }

  private params(request: AgentModelRequest, mapping: ToolNameMapping, withReasoning: boolean): Anthropic.MessageStreamParams {
    const { system, messages } = this.dialog(request.messages, mapping, withReasoning);
    const format = request.output?.mode === "json" ? this.outputFormat(request) : undefined;
    const outputConfig = {
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(format === undefined ? {} : { format }),
    };
    return {
      model: this.connection.model,
      max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
      messages,
      ...(system.length === 0 ? {} : { system }),
      ...(request.tools.length === 0 ? {} : { tools: request.tools.map((tool) => this.tool(tool, mapping)) }),
      ...(this.options.thinking === false ? {} : { thinking: { type: "adaptive" as const, ...(this.options.thinkingDisplay === undefined ? {} : { display: this.options.thinkingDisplay }) } }),
      ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
      // The dialog so far is cached as it grows; the instructions keep their own read point above.
      ...(this.cache === undefined ? {} : { cache_control: this.cache }),
    };
  }

  private outputFormat(request: AgentModelRequest): Anthropic.JSONOutputFormat | undefined {
    const schema = request.output?.schema;
    if (schema === undefined) return undefined;
    if (schema.kind === "class") {
      throw new AnthropicProviderError(`Output schema "${schema.name}" needs generated JSON Schema metadata for this provider.`);
    }
    // The SDK drops the rules structured outputs do not take; the runtime still checks the answer against the whole schema.
    const format = jsonSchemaOutputFormat(schema.schema as never);
    return { type: "json_schema", schema: format.schema };
  }

  private tool(tool: AgentToolContract, mapping: ToolNameMapping): Anthropic.Tool {
    const schema: JsonObject = tool.input?.kind === "json-schema" ? tool.input.schema : { type: "object", additionalProperties: true };
    return {
      name: mapping.bazisToProvider.get(tool.name) ?? tool.name,
      description: tool.description,
      input_schema: { ...schema, type: "object" },
    };
  }

  /** The dialog as the Messages API takes it: instructions on top, then turns of the user and the assistant. */
  private dialog(source: readonly AgentMessage[], mapping: ToolNameMapping, withReasoning: boolean): { readonly system: Anthropic.TextBlockParam[]; readonly messages: Anthropic.MessageParam[] } {
    const system: Anthropic.TextBlockParam[] = [];
    const messages: Anthropic.MessageParam[] = [];
    let leading = true;
    const append = (role: "user" | "assistant", blocks: readonly Anthropic.ContentBlockParam[]): void => {
      if (blocks.length === 0) return;
      const last = messages[messages.length - 1];
      // Results of one step's Tools, and whatever the user says after them, are one user turn.
      if (last !== undefined && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
      else messages.push({ role, content: [...blocks] });
    };
    for (const message of source) {
      if ((message.role === "system" || message.role === "developer") && leading) {
        for (const part of message.content) if (part.kind === "text" && part.text.length > 0) system.push({ type: "text", text: part.text });
        continue;
      }
      leading = false;
      if (message.role === "assistant") {
        append("assistant", message.content.map((part) => assistantBlock(part, mapping, withReasoning)).filter((block) => block !== undefined));
      } else {
        // A user, a Tool result, or instructions that arrive in the middle of a dialog.
        append("user", message.content.map(userBlock).filter((block) => block !== undefined));
      }
    }
    if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: [{ type: "text", text: "(The conversation continues.)" }] });
    const lastSystem = system[system.length - 1];
    if (lastSystem !== undefined && this.cache !== undefined) lastSystem.cache_control = this.cache;
    return { system, messages };
  }

  private response(request: AgentModelRequest, message: Anthropic.Message, mapping: ToolNameMapping): AgentModelResponse {
    if (message.stop_reason === "model_context_window_exceeded") {
      throw new AgentModelContextOverflowError("The answer did not fit the model's context window.");
    }
    const content: AgentContentPart[] = [];
    const toolCalls: AgentToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) content.push(agentText(block.text));
      } else if (block.type === "thinking") {
        content.push(agentReasoning(block.thinking, { data: { provider: PROVIDER, type: "thinking", signature: block.signature } }));
      } else if (block.type === "redacted_thinking") {
        content.push(agentReasoning("", { data: { provider: PROVIDER, type: "redacted_thinking", data: block.data } }));
      } else if (block.type === "tool_use") {
        toolCalls.push(agentToolCall({ id: block.id, name: mapping.providerToBazis.get(block.name) ?? block.name, input: block.input }));
      }
    }
    // A refusal can cut a Tool call off: none of that turn's Tools is run.
    const calls = message.stop_reason === "refusal" ? [] : toolCalls;
    if (message.stop_reason === "max_tokens" && calls.length > 0) {
      // The output limit ended the turn inside its last call: the arguments may be incomplete.
      const last = calls[calls.length - 1]!;
      calls[calls.length - 1] = agentToolCall({ id: last.id, name: last.name, inputError: "The output limit cut the arguments off; write the call again, shorter if needed." });
    }
    if (content.length === 0 && calls.length === 0) {
      if (message.stop_reason === "refusal") content.push(agentText("The model declined to answer."));
      else throw new AnthropicProviderError(`The model returned no content (stop_reason "${message.stop_reason ?? "none"}").`);
    }
    const usage = message.usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    // `input_tokens` counts only what was not cached; the request is all three.
    const inputTokens = usage.input_tokens + cacheRead + cacheWrite;
    return agentModelResponse({
      invocationId: request.invocationId,
      finishReason: finishReasonOf(message.stop_reason, calls.length > 0),
      message: content.length === 0 ? undefined : agentMessage("assistant", content),
      toolCalls: calls,
      usage: {
        inputTokens,
        outputTokens: usage.output_tokens,
        totalTokens: inputTokens + usage.output_tokens,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        ...(typeof usage.output_tokens_details?.thinking_tokens === "number" ? { reasoningTokens: usage.output_tokens_details.thinking_tokens } : {}),
      },
      metadata: {
        model: message.model,
        ...(message.stop_reason === "refusal" && message.stop_details?.category != null ? { refusal: message.stop_details.category } : {}),
      },
    });
  }

  /**
   * Whether the API refused reasoning replayed from a dialog that has changed
   * since. The API has no error type for it: the text of the 400 is the only sign.
   */
  private refusesStoredReasoning(error: unknown): boolean {
    return error instanceof Anthropic.BadRequestError && /signature.*thinking|thinking.*signature/is.test(error.message);
  }

  private rememberWithoutReasoning(invocationId: string): void {
    if (this.withoutReasoning.size >= 1_000) this.withoutReasoning.delete(this.withoutReasoning.values().next().value as string);
    this.withoutReasoning.add(invocationId);
  }

  /**
   * The SDK's error as the agent runtime understands it. The API's own message
   * is not repeated: it may quote the request. The status, the error type and
   * the request id are enough to find the request in the provider's console.
   */
  private failure(error: unknown): unknown {
    // A cancelled request keeps its own reason.
    if (error instanceof Anthropic.APIUserAbortError) return error;
    if (error instanceof Anthropic.APIConnectionTimeoutError) return new AgentModelTimeoutError("Anthropic request timed out.");
    if (error instanceof Anthropic.APIConnectionError) return new AgentModelUnavailableError("Anthropic could not be reached.");
    if (!(error instanceof Anthropic.APIError)) return error;
    const described = `Anthropic request failed with HTTP ${error.status ?? "?"}${error.type == null ? "" : ` (${error.type})`}${error.requestID == null ? "" : `, request ${error.requestID}`}.`;
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.RequestTimeoutError || error instanceof Anthropic.ConflictError) {
      const after = Number(error.headers?.get("retry-after"));
      return new AgentModelUnavailableError(described, Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {});
    }
    // "Too long" has no error type of its own either.
    if (error instanceof Anthropic.ContentTooLargeError || (error instanceof Anthropic.BadRequestError && /prompt is too long|context window|too many tokens/i.test(error.message))) {
      return new AgentModelContextOverflowError(`${described} The request does not fit the model's context window.`);
    }
    return new AnthropicProviderError(described);
  }
}

/**
 * Claude through the official SDK (`@anthropic-ai/sdk`, installed by the
 * application): Tools, structured answers, images and PDF files, streaming,
 * prompt caching and adaptive thinking.
 *
 * ```ts
 * @Infra({ llm: llmConnect(llmConfig, anthropicAdapter({ effort: "medium" })) })
 * export class AppInfra {}
 * ```
 */
export function anthropicAdapter(options: AnthropicAdapterOptions = {}): LlmProviderAdapter {
  const healthCheckEnabled = options.healthCheck ?? true;
  return {
    create(connection) {
      return new AnthropicModelProvider(connection, options);
    },
    async connect(provider, signal) {
      if (!(provider instanceof AnthropicModelProvider)) return;
      const deadline = AbortSignal.timeout(START_CHECK_TIMEOUT_MS);
      try {
        await provider.probe(signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
      } catch (error) {
        if (signal?.aborted) throw error;
        const reason = deadline.aborted ? `no answer within ${START_CHECK_TIMEOUT_MS} ms` : errorMessageOf(error);
        throw new InfraError(`Infra connector "llm": ${provider.address || "Anthropic"} is not available — ${redactSensitiveText(reason)}`);
      }
    },
    healthCheck: healthCheckEnabled
      ? (provider, signal) => provider instanceof AnthropicModelProvider && provider.ping(signal)
      : undefined,
  };
}
