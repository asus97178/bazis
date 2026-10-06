import { describe, expect, test } from "bun:test";
import {
  agentMessage,
  agentModelRequest,
  agentOutputContract,
  agentJsonSchema,
  agentClassSchema,
  agentToolCall,
  agentToolCallPart,
  agentToolContract,
  agentToolResult,
  agentToolResultPart,
  type AgentModelProviderContext,
} from "@/core/agent";
import { openAiCompatibleAdapter, type OpenAiCompatibleFetch, type OpenAiCompatibleModelProvider } from "../index";

interface CapturedRequest {
  readonly url: string;
  readonly init?: RequestInit;
  readonly body: Record<string, unknown>;
}

function context(): AgentModelProviderContext {
  return Object.freeze({
    invocationId: "inv-1",
    agentName: "catalog-agent",
    metadata: Object.freeze({ tenant: "acme" }),
    signal: new AbortController().signal,
  });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI-compatible LLM adapter", () => {
  test("preserves structured output schema, name, description and strictness on the wire", async () => {
    const captured: Record<string, unknown>[] = [];
    const provider = openAiCompatibleAdapter({ fetch: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return response({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"answer":"ok"}' } }] });
    } }).create({ provider: "openai-compatible", model: "mock", baseUrl: "https://unused.invalid", apiKey: "synthetic" }) as OpenAiCompatibleModelProvider;
    const schema = { type: "object", properties: { answer: { type: "string", pattern: "^[a-z]+$" } }, required: ["answer"], additionalProperties: false };
    try {
      for (const strict of [true, false]) {
        await provider.complete(agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "JSON")], output: agentOutputContract({ mode: "json", description: "Answer contract", schema: agentJsonSchema("answer.v1", schema, { strict }) }) }), context());
        expect(captured.at(-1)?.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer_v1", schema, strict, description: "Answer contract" } });
      }
      await provider.complete(agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "JSON")], output: agentOutputContract({ mode: "json" }) }), context());
      expect(captured.at(-1)?.response_format).toEqual({ type: "json_object" });
      await expect(provider.complete(agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "JSON")], output: agentOutputContract({ mode: "json", schema: agentClassSchema("UnresolvedDto") }) }), context())).rejects.toThrow("generated JSON Schema");
      expect(captured).toHaveLength(3);
    } finally { provider.dispose(); }
  });

  test("maps Bazis model requests to chat completions requests", async () => {
    const captured: CapturedRequest[] = [];
    const fetcher: OpenAiCompatibleFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      captured.push({ url: String(input), init, body });
      return response({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Found 1 product." } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    };
    const provider = openAiCompatibleAdapter({ fetch: fetcher }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1/",
      apiKey: "secret-key",
      timeoutMs: 2500,
    }) as OpenAiCompatibleModelProvider;

    const result = await provider.complete(
      agentModelRequest({
        invocationId: "inv-1",
        messages: [agentMessage("user", "Find keyboards")],
        tools: [
          agentToolContract({
            name: "catalog.search",
            description: "Searches the catalog.",
            sideEffect: "read",
          }),
        ],
        temperature: 0.2,
        maxOutputTokens: 128,
      }),
      context(),
    );

    expect(result.finishReason).toBe("stop");
    expect(result.message?.content[0]).toEqual({ kind: "text", text: "Found 1 product." });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect((captured[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(captured[0]?.body).toMatchObject({
      model: "gpt-test",
      temperature: 0.2,
      max_tokens: 128,
      tool_choice: "auto",
    });
    expect((captured[0]?.body.messages as readonly Record<string, unknown>[])[0]).toEqual({
      role: "user",
      content: "Find keyboards",
    });
    expect(((captured[0]?.body.tools as readonly Record<string, unknown>[])[0]?.function as Record<string, unknown>).name).toBe(
      "catalog_search",
    );
  });

  test("rejects a mismatched request model before fetch and keeps the Infra model for absent or equal requests", async () => {
    const captured: CapturedRequest[] = [];
    const provider = openAiCompatibleAdapter({
      fetch: async (input, init) => {
        captured.push({ url: String(input), init, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return response({ choices: [{ finish_reason: "stop", message: { content: "Done." } }] });
      },
    }).create({
      provider: "openai-compatible",
      model: "infra-model",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;

    await expect(provider.complete(
      agentModelRequest({ invocationId: "inv-mismatch", messages: [agentMessage("user", "Hello")], model: "other-model" }),
      context(),
    )).rejects.toThrow(/conflicts with the configured Infra model/);
    expect(captured).toHaveLength(0);

    await provider.complete(agentModelRequest({ invocationId: "inv-absent", messages: [agentMessage("user", "Hello")] }), context());
    await provider.complete(agentModelRequest({ invocationId: "inv-equal", messages: [agentMessage("user", "Hello")], model: "infra-model" }), context());
    expect(captured.map((request) => request.body.model)).toEqual(["infra-model", "infra-model"]);
  });

  test("maps provider tool calls back to Bazis tool names", async () => {
    const fetcher: OpenAiCompatibleFetch = async () =>
      response({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "catalog_search", arguments: "{\"query\":\"keyboard\"}" },
                },
              ],
            },
          },
        ],
      });
    const provider = openAiCompatibleAdapter({ fetch: fetcher }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;

    const result = await provider.complete(
      agentModelRequest({
        invocationId: "inv-1",
        messages: [agentMessage("user", "Find keyboards")],
        tools: [agentToolContract({ name: "catalog.search", description: "Searches the catalog.", sideEffect: "read" })],
      }),
      context(),
    );

    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls[0]).toMatchObject({
      id: "call-1",
      name: "catalog.search",
      input: { query: "keyboard" },
    });
  });

  test("preserves provider tool-call context before sending tool result messages", async () => {
    const captured: CapturedRequest[] = [];
    let callCount = 0;
    const fetcher: OpenAiCompatibleFetch = async (input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      captured.push({ url: String(input), init, body });
      if (callCount === 1) {
        return response({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "catalog_search", arguments: "{\"query\":\"keyboard\"}" },
                  },
                ],
              },
            },
          ],
        });
      }
      return response({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
      });
    };
    const provider = openAiCompatibleAdapter({ fetch: fetcher }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;
    const tool = agentToolContract({ name: "catalog.search", description: "Searches the catalog.", sideEffect: "read" });

    await provider.complete(
      agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "Find keyboards")], tools: [tool] }),
      context(),
    );
    await provider.complete(
      agentModelRequest({
        invocationId: "inv-1",
        messages: [
          agentMessage("user", "Find keyboards"),
          agentMessage("assistant", agentToolCallPart(agentToolCall({
            id: "call-1",
            name: "catalog.search",
            input: { query: "keyboard" },
          }))),
          agentMessage(
            "tool",
            agentToolResultPart(agentToolResult({
              callId: "call-1",
              name: "catalog.search",
              output: { count: 1 },
              durationMs: 12,
              metadata: { tenant: "internal", authorization: "Bearer internal-secret" },
            })),
            { toolCallId: "call-1" },
          ),
        ],
        tools: [tool],
      }),
      context(),
    );

    const secondMessages = captured[1]?.body.messages as readonly Record<string, unknown>[];
    expect(secondMessages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "catalog_search" } }],
    });
    expect(secondMessages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(JSON.parse(String(secondMessages[2]?.content))).toEqual({
      name: "catalog.search",
      status: "success",
      output: { count: 1 },
    });
    expect(String(secondMessages[2]?.content)).not.toContain("internal-secret");
  });

  test("throws structured provider errors for non-2xx responses and invalid tool arguments", async () => {
    const failingProvider = openAiCompatibleAdapter({
      fetch: async () => response({ error: { message: "rate limited" } }, 429),
    }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;

    await expect(
      failingProvider.complete(
        agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "Hello")] }),
        context(),
      ),
    ).rejects.toThrow(/429/);

    const invalidToolProvider = openAiCompatibleAdapter({
      fetch: async () =>
        response({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "catalog_search", arguments: "{bad json" },
                  },
                ],
              },
            },
          ],
        }),
    }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;

    await expect(
      invalidToolProvider.complete(
        agentModelRequest({
          invocationId: "inv-1",
          messages: [agentMessage("user", "Hello")],
          tools: [agentToolContract({ name: "catalog.search", description: "Searches the catalog." })],
        }),
        context(),
      ),
    ).rejects.toThrow(/tool arguments/);
  });

  test("bounds successful provider response bodies", async () => {
    const provider = openAiCompatibleAdapter({
      maxResponseBytes: 16,
      fetch: async () => response({ choices: [{ finish_reason: "stop", message: { content: "too large" } }] }),
    }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    }) as OpenAiCompatibleModelProvider;

    await expect(provider.complete(
      agentModelRequest({ invocationId: "inv-1", messages: [agentMessage("user", "Hello")] }),
      context(),
    )).rejects.toThrow(/maxResponseBytes/);

    expect(() => openAiCompatibleAdapter({ maxResponseBytes: 0 }).create({
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
    })).toThrow(/maxResponseBytes/);
  });

  test("cancels a custom response stream when timeout expires after headers", async () => {
    let cancelled = false;
    const provider = openAiCompatibleAdapter({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
      start() { /* deliberately never enqueue */ },
    })) }).create({ provider: "openai-compatible", model: "gpt-test", baseUrl: "https://llm.example", apiKey: "secret", timeoutMs: 5 }) as OpenAiCompatibleModelProvider;
    await expect(provider.complete(agentModelRequest({ invocationId: "inv", messages: [agentMessage("user", "x")] }), context())).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  type NeverCancelPath = "http-error" | "oversized-content-length" | "overflow";

  function nativeNeverCancellingResponse(path: NeverCancelPath, entered: () => void): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (path === "overflow") controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        entered();
        return new Promise<void>(() => undefined);
      },
    });
    if (path === "http-error") return new Response(body, { status: 500 });
    if (path === "oversized-content-length") return new Response(body, { headers: { "content-length": "1024" } });
    return new Response(body);
  }

  function neverCancellingProvider(path: NeverCancelPath, timeoutMs: number, entered: () => void): OpenAiCompatibleModelProvider {
    return openAiCompatibleAdapter({
      fetch: async () => nativeNeverCancellingResponse(path, entered),
      ...(path === "http-error" ? {} : { maxResponseBytes: 1 }),
    }).create({ provider: "openai-compatible", model: "cancel-never", baseUrl: "https://llm.example", apiKey: "secret", timeoutMs }) as OpenAiCompatibleModelProvider;
  }

  async function settlesAfterCancellation(pending: Promise<unknown>): Promise<boolean> {
    return Promise.race([
      pending.then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 80)),
    ]);
  }

  for (const path of ["http-error", "oversized-content-length", "overflow"] as const) {
    test(`does not await native ${path} stream cancellation after configured timeout`, async () => {
      let mark!: () => void;
      const entered = new Promise<void>((resolve) => { mark = resolve; });
      const provider = neverCancellingProvider(path, 5, mark);
      const request = agentModelRequest({ invocationId: `timeout-${path}`, messages: [agentMessage("user", "x")] });
      const pending = provider.complete(request, context());
      await entered;
      expect(await settlesAfterCancellation(pending)).toBe(true);
    });

    test(`does not await native ${path} stream cancellation after caller abort`, async () => {
      let mark!: () => void;
      const entered = new Promise<void>((resolve) => { mark = resolve; });
      const controller = new AbortController();
      const provider = neverCancellingProvider(path, 0, mark);
      const request = agentModelRequest({ invocationId: `abort-${path}`, messages: [agentMessage("user", "x")] });
      const pending = provider.complete(request, { ...context(), signal: controller.signal });
      await entered;
      controller.abort();
      expect(await settlesAfterCancellation(pending)).toBe(true);
    });
  }

  test("cancels a native response stream after headers when the caller aborts", async () => {
    let headersReturned!: () => void;
    const headers = new Promise<void>((resolve) => { headersReturned = resolve; });
    let mark!: () => void;
    const cancelled = new Promise<void>((resolve) => { mark = resolve; });
    const controller = new AbortController();
    const provider = openAiCompatibleAdapter({ fetch: async () => {
      headersReturned();
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { mark(); return new Promise<void>(() => undefined); },
      }));
    } }).create({ provider: "openai-compatible", model: "after-headers", baseUrl: "https://llm.example", apiKey: "secret", timeoutMs: 0 }) as OpenAiCompatibleModelProvider;
    const request = agentModelRequest({ invocationId: "after-headers", messages: [agentMessage("user", "x")] });
    const pending = provider.complete(request, { ...context(), signal: controller.signal });
    await headers;
    controller.abort();
    await cancelled;
    expect(await settlesAfterCancellation(pending)).toBe(true);
  });
});
