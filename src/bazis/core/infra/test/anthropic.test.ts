import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createContainer, Module } from "@/core/di";
import {
  AgentModelContextOverflowError,
  AgentModelTimeoutError,
  AgentModelUnavailableError,
  AgentRuntime,
  Tool,
  agentFile,
  agentImage,
  agentJsonSchema,
  agentMessage,
  agentModelRequest,
  agentOutputContract,
  agentReasoning,
  agentText,
  agentToolCall,
  agentToolCallPart,
  agentToolContract,
  agentToolResult,
  agentToolResultPart,
  type AgentModelProviderContext,
  type JsonObject,
} from "@/core/agent";
import { AnthropicModelProvider, AnthropicProviderError, anthropicAdapter, type AnthropicClient } from "../anthropic";

type Params = Anthropic.MessageStreamParams;
type Reply = Partial<Anthropic.Message> | Error;

function message(reply: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", container: null,
    content: [], stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null } as Anthropic.Usage,
    ...reply,
  } as Anthropic.Message;
}

const text = (value: string): Anthropic.TextBlock => ({ type: "text", text: value, citations: null });

/** An SDK client that answers request N with reply N and streams the text of an answer. */
function fakeClient(replies: readonly Reply[]) {
  const requests: Params[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    messages: {
      stream(params: Params, options?: { signal?: AbortSignal }) {
        requests.push(structuredClone(params));
        signals.push(options?.signal);
        const reply = replies[requests.length - 1];
        const listeners: ((delta: string, snapshot: string) => void)[] = [];
        return {
          on(event: string, listener: (delta: string, snapshot: string) => void) { if (event === "text") listeners.push(listener); return this; },
          async finalMessage() {
            if (reply === undefined) throw new Error("The script has no more replies.");
            if (reply instanceof Error) throw reply;
            const answer = message(reply);
            for (const block of answer.content) if (block.type === "text") for (const listener of listeners) listener(block.text, block.text);
            return answer;
          },
        };
      },
    },
    models: { retrieve: async () => ({ id: "claude-opus-5-5", max_input_tokens: 1_000_000 }) },
  } as unknown as AnthropicClient;
  return { client, requests, signals };
}

const connection = { provider: "anthropic", model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", apiKey: "test-key" };

function context(onTextDelta?: (text: string) => void): AgentModelProviderContext {
  return { invocationId: "inv-1", agentName: "support", metadata: {}, signal: new AbortController().signal, ...(onTextDelta ? { onTextDelta } : {}) };
}

const apiError = (status: number, type: string, text_: string, headers: Record<string, string> = {}): Error =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message: text_ } }, text_, new Headers(headers));

const findOrder = agentToolContract({
  name: "orders.find", description: "Finds an order.",
  input: agentJsonSchema("FindOrder", { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false }),
});

describe("Anthropic LLM adapter", () => {
  test("sends instructions, Tools and the dialog the way the Messages API takes them", async () => {
    const { client, requests } = fakeClient([{ content: [text("Order 42 is paid.")] }]);
    const provider = new AnthropicModelProvider(connection, { client, effort: "medium", thinkingDisplay: "summarized" });
    await provider.complete(agentModelRequest({
      invocationId: "inv-1",
      tools: [findOrder],
      messages: [
        agentMessage("system", "Answer about orders."),
        agentMessage("user", [agentText("Where is order 42? See the photo and the contract."), agentImage("https://files.example/box.png"), agentImage("data:image/png;base64,iVBORw0="), agentFile("data:application/pdf;base64,JVBERi0=", { name: "contract.pdf" })]),
        agentMessage("assistant", [
          agentReasoning("I need the order first.", { data: { provider: "anthropic", type: "thinking", signature: "sig-1" } }),
          // Reasoning of another provider is never sent to this one.
          agentReasoning("Foreign thoughts.", { data: { provider: "other" } }),
          agentText("Let me check."),
          agentToolCallPart(agentToolCall({ id: "toolu_1", name: "orders.find", input: { id: 42 } })),
          agentToolCallPart(agentToolCall({ id: "toolu_2", name: "orders.find", input: { id: 43 } })),
        ]),
        agentMessage("tool", agentToolResultPart(agentToolResult({ callId: "toolu_1", name: "orders.find", output: { id: 42, status: "paid" } })), { toolCallId: "toolu_1" }),
        agentMessage("tool", agentToolResultPart(agentToolResult({ callId: "toolu_2", name: "orders.find", error: { code: "NOT_FOUND", message: "No order 43." } })), { toolCallId: "toolu_2" }),
        agentMessage("user", "And 43?"),
      ],
    }), context());

    const sent = requests[0]!;
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.max_tokens).toBe(32_000);
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.output_config).toEqual({ effort: "medium" });
    // The instructions are a cache read point of their own; the growing dialog is cached automatically.
    expect(sent.system).toEqual([{ type: "text", text: "Answer about orders.", cache_control: { type: "ephemeral" } }]);
    expect(sent.cache_control).toEqual({ type: "ephemeral" });
    expect(sent.tools).toEqual([{ name: "orders_find", description: "Finds an order.", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false } }]);
    expect(sent.messages).toEqual([
      { role: "user", content: [
        { type: "text", text: "Where is order 42? See the photo and the contract." },
        { type: "image", source: { type: "url", url: "https://files.example/box.png" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "contract.pdf" },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I need the order first.", signature: "sig-1" },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "orders_find", input: { id: 42 } },
        { type: "tool_use", id: "toolu_2", name: "orders_find", input: { id: 43 } },
      ] },
      // Every result of the step and the user's next words are one user turn.
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ id: 42, status: "paid" }) },
        { type: "tool_result", tool_use_id: "toolu_2", content: JSON.stringify({ code: "NOT_FOUND", message: "No order 43." }), is_error: true },
        { type: "text", text: "And 43?" },
      ] },
    ]);
  });

  test("reads reasoning, text, Tool calls and usage from the answer", async () => {
    const { client } = fakeClient([{
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig-2" },
        text("Checking."),
        { type: "tool_use", id: "toolu_9", name: "orders_find", input: { id: 42 }, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
      ],
      usage: { input_tokens: 20, output_tokens: 60, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens_details: { thinking_tokens: 40 } } as Anthropic.Usage,
    }]);
    const provider = new AnthropicModelProvider(connection, { client });
    const answer = await provider.complete(agentModelRequest({ invocationId: "inv-1", tools: [findOrder], messages: [agentMessage("user", "Where is order 42?")] }), context());

    expect(answer.finishReason).toBe("tool-calls");
    expect(answer.message?.content).toEqual([
      { kind: "reasoning", text: "", data: { provider: "anthropic", type: "thinking", signature: "sig-2" } },
      { kind: "text", text: "Checking." },
    ]);
    expect(answer.toolCalls).toEqual([{ id: "toolu_9", name: "orders.find", input: { id: 42 }, metadata: {} }]);
    // The whole request: what was read from the cache and written to it counts too.
    expect(answer.usage).toEqual({ inputTokens: 1000, outputTokens: 60, totalTokens: 1060, cacheReadTokens: 900, cacheWriteTokens: 80, reasoningTokens: 40 });
  });

  test("streams the text of a plain answer and asks for a JSON answer by schema", async () => {
    const plain = fakeClient([{ content: [text("Hello.")] }]);
    const shown: string[] = [];
    await new AnthropicModelProvider(connection, { client: plain.client }).complete(
      agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "Hi")] }), context((delta) => shown.push(delta)));
    expect(shown).toEqual(["Hello."]);

    const structured = fakeClient([{ content: [text("{\"goal\":\"x\"}")] }]);
    const silent: string[] = [];
    await new AnthropicModelProvider(connection, { client: structured.client, thinking: false, cache: false }).complete(agentModelRequest({
      invocationId: "inv-1", messages: [agentMessage("user", "Goal?")],
      output: agentOutputContract({ mode: "json", schema: agentJsonSchema("Goal", { type: "object", properties: { goal: { type: "string", minLength: 3 } }, required: ["goal"], additionalProperties: false }) }),
    }), context((delta) => silent.push(delta)));
    const sent = structured.requests[0]!;
    expect(sent.output_config?.format?.type).toBe("json_schema");
    // A rule structured outputs do not take becomes a hint for the model; the runtime checks the answer against it.
    expect(sent.output_config?.format?.schema).toEqual({ type: "object", properties: { goal: { type: "string", description: "{minLength: 3}" } }, required: ["goal"], additionalProperties: false });
    expect(sent.thinking).toBeUndefined();
    expect(sent.cache_control).toBeUndefined();
    // Text of a structured answer is not shown before it is checked.
    expect(silent).toEqual([]);
  });

  test("never runs a Tool call the output limit or a refusal cut off", async () => {
    const cut = fakeClient([{
      stop_reason: "max_tokens",
      content: [
        { type: "tool_use", id: "toolu_1", name: "orders_find", input: { id: 42 }, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
        { type: "tool_use", id: "toolu_2", name: "orders_find", input: {}, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
      ],
    }]);
    const request = agentModelRequest({ invocationId: "inv-1", tools: [findOrder], messages: [agentMessage("user", "Find both")] });
    const answer = await new AnthropicModelProvider(connection, { client: cut.client }).complete(request, context());
    expect(answer.finishReason).toBe("tool-calls");
    expect(answer.toolCalls[0]?.inputError).toBeUndefined();
    expect(answer.toolCalls[1]?.inputError).toContain("output limit");

    const refused = fakeClient([{
      stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "…" } as Anthropic.RefusalStopDetails,
      content: [{ type: "tool_use", id: "toolu_1", name: "orders_find", input: {}, caller: { type: "direct" } } as Anthropic.ToolUseBlock],
    }]);
    const declined = await new AnthropicModelProvider(connection, { client: refused.client }).complete(request, context());
    expect(declined.finishReason).toBe("content-filter");
    expect(declined.toolCalls).toEqual([]);
    expect(declined.metadata).toMatchObject({ refusal: "cyber" });
  });

  test("tells the runtime which failures to repeat, which to compact and which to give up on", async () => {
    const ask = (reply: Error) => new AnthropicModelProvider(connection, { client: fakeClient([reply]).client })
      .complete(agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "Hi")] }), context())
      .then(() => undefined, (error: unknown) => error as Error);

    const limited = await ask(apiError(429, "rate_limit_error", "Slow down.", { "retry-after": "3" }));
    expect(limited).toBeInstanceOf(AgentModelUnavailableError);
    expect((limited as AgentModelUnavailableError).retryAfterMs).toBe(3000);
    expect(await ask(apiError(529, "overloaded_error", "Overloaded."))).toBeInstanceOf(AgentModelUnavailableError);
    expect(await ask(new Anthropic.APIConnectionError({ message: "socket closed" }))).toBeInstanceOf(AgentModelUnavailableError);
    expect(await ask(new Anthropic.APIConnectionTimeoutError())).toBeInstanceOf(AgentModelTimeoutError);
    expect(await ask(apiError(400, "invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum"))).toBeInstanceOf(AgentModelContextOverflowError);
    expect(await ask(apiError(413, "request_too_large", "Request too large."))).toBeInstanceOf(AgentModelContextOverflowError);

    const refused = await ask(apiError(401, "authentication_error", "invalid x-api-key sk-ant-secret"));
    expect(refused).toBeInstanceOf(AnthropicProviderError);
    // The API's own text may quote the request; the status and the type are reported.
    expect(refused?.message).toBe("Anthropic request failed with HTTP 401 (authentication_error).");
  });

  test("sends a request once more without reasoning the API no longer accepts, and remembers it for the run", async () => {
    const { client, requests } = fakeClient([
      apiError(400, "invalid_request_error", "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."),
      { content: [text("Done.")] },
      { content: [text("Done again.")] },
    ]);
    const provider = new AnthropicModelProvider(connection, { client });
    const request = agentModelRequest({ invocationId: "inv-1", messages: [
      agentMessage("user", "Hi"),
      agentMessage("assistant", [agentReasoning("Old thoughts.", { data: { provider: "anthropic", type: "thinking", signature: "stale" } }), agentText("Hello.")]),
      agentMessage("user", "Go on"),
    ] });
    const answer = await provider.complete(request, context());
    expect(answer.message?.content).toEqual([{ kind: "text", text: "Done." }]);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]!.messages)).toContain("thinking");
    expect(requests[1]!.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Hello." }] });

    // The next step of the same run does not send it again.
    await provider.complete(request, context());
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages)).not.toContain("thinking");
  });

  test("learns the model's context window at the start check, unless the application states it", async () => {
    const adapter = anthropicAdapter({ client: fakeClient([]).client });
    const provider = adapter.create(connection) as AnthropicModelProvider;
    expect(provider.contextTokens()).toBeUndefined();
    await adapter.connect?.(provider);
    expect(provider.contextTokens()).toBe(1_000_000);

    const stated = adapter.create({ ...connection, contextTokens: 200_000 }) as AnthropicModelProvider;
    await adapter.connect?.(stated);
    expect(stated.contextTokens()).toBe(200_000);
  });

  test("runs an agent step by step: reasoning goes back with the Tool call it led to", async () => {
    @Tool({ callers: ["agent"], name: "orders.find", description: "Finds an order.", sideEffect: "read" })
    class FindOrderTool {
      execute(): JsonObject {
        return { id: 42, status: "paid" };
      }
    }

    @Module({ tools: [FindOrderTool] })
    class OrdersModule {}

    const { client, requests } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "orders_find", input: { id: 42 }, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
        ],
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 400 } as Anthropic.Usage,
      },
      { content: [text("Order 42 is paid.")], usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } as Anthropic.Usage },
    ]);
    const container = createContainer(OrdersModule);
    const runtime = new AgentRuntime(container, new AnthropicModelProvider(connection, { client }));
    try {
      const result = await runtime.run({ name: "support", instructions: "Answer about orders.", toolNames: ["orders.find"] }, { input: "Where is order 42?" });
      expect(result.status).toBe("completed");
      expect(result.steps).toBe(2);
      expect(result.usage).toEqual({ inputTokens: 1040, outputTokens: 40, totalTokens: 1080, cacheReadTokens: 500, cacheWriteTokens: 400 });
      expect(requests[1]!.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Where is order 42?" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "orders_find", input: { id: 42 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ id: 42, status: "paid" }) }] },
      ]);
      // The same instructions and Tools on every step: the cached prefix stays valid.
      expect(requests[1]!.system).toEqual(requests[0]!.system);
      expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    } finally {
      await container.dispose();
    }
  });
});
