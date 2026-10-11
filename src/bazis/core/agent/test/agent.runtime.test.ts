import { describe, expect, test } from "bun:test";
import { DI, createContainer, Module, scoped } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { Infra, llmConnect, llmProfile, llmRouter, openAiCompatibleAdapter, type LlmProviderAdapter } from "@/core/infra";
import {
  AGENT_MODEL_PROVIDER,
  AGENT_RUNTIME_OPTIONS,
  AgentRuntime,
  AgentSetupError,
  Tool,
  agentData,
  agentMessage,
  agentJsonSchema,
  agentModelResponse,
  agentOutputContract,
  agentToolCall,
  agentToolCallPart,
  agentToolResult,
  agentToolResultPart,
  type AgentToolAuditEntry,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentContextBuilder,
  type AgentToolExecutionContext,
  type JsonObject,
  type JsonValue,
} from "../index";
import { AgentRegistry } from "../AgentRegistry";
import { AgentExecutionDriver } from "../internal/AgentExecutionDriver";
import { agentDefinition } from "./agentDefinition.fixture";

const CATALOG_AGENT = "catalog-agent";

@Tool({
  name: "catalog.search",
  description: "Searches the product catalog.",
  sideEffect: "read",
})
class SearchCatalogTool {
  execute(input: JsonValue, context: AgentToolExecutionContext): JsonObject {
    const query =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as JsonObject).query
        : null;
    return {
      query: typeof query === "string" ? query : "",
      count: 1,
      agentName: context.agentName ?? null,
    };
  }
}

const CatalogAgent = agentDefinition({ name: CATALOG_AGENT, tools: [SearchCatalogTool] });

class ScriptedModelProvider implements AgentModelProvider {
  public readonly requests: AgentModelRequest[] = [];
  public readonly contexts: AgentModelProviderContext[] = [];

  async complete(request: AgentModelRequest, context: AgentModelProviderContext): Promise<AgentModelResponse> {
    this.requests.push(request);
    this.contexts.push(context);

    if (this.requests.length === 1) {
      return agentModelResponse({
        invocationId: request.invocationId,
        finishReason: "tool-calls",
        toolCalls: [
          agentToolCall({
            id: "tool-call-1",
            name: "catalog.search",
            input: { query: "keyboard" },
          }),
        ],
      });
    }

    return agentModelResponse({
      invocationId: request.invocationId,
      finishReason: "stop",
      message: agentMessage("assistant", "Found 1 product."),
    });
  }
}

const ProfiledAgent = agentDefinition({ name: "profiled-agent", modelProfile: "reasoning" });

const PromptedRuntimeAgent = agentDefinition({
  name: "prompted-runtime-agent",
  instructions: "You are the runtime agent. Keep the user's last request.",
});

const llmConfig = defineConfig("llm", {
  default: {
    provider: "scripted",
    model: "scripted-model",
    baseUrl: "https://llm.internal",
    apiKey: secret("test-key"),
  },
});

function scriptedAdapter(provider: ScriptedModelProvider): LlmProviderAdapter {
  return {
    create() {
      return provider;
    },
    healthCheck() {
      return true;
    },
  };
}

function createRuntime(provider: ScriptedModelProvider): {
  readonly runtime: AgentRuntime;
  readonly container: ReturnType<typeof createContainer>;
} {
  @Infra({ llm: llmConnect(llmConfig, scriptedAdapter(provider)) })
  class AppInfra {}

  @Module({
    imports: [AppInfra],
    tools: [SearchCatalogTool],
    providers: [scoped(SearchCatalogTool)],
  })
  class AppModule {}

  const container = createContainer(AppModule);
  // llmConnect registers AgentRuntime next to the model provider.
  const runtime = container.resolve(AgentRuntime);
  return { runtime, container };
}

describe("agent runtime", () => {
  test("invokes the model provider from infra, executes tool calls and returns the final message", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      const result = await runtime.run(CatalogAgent, {
        id: "inv-1",
        input: "Find keyboards",
        metadata: { tenant: "acme" },
      });

      expect(result.status).toBe("completed");
      expect(result.finalMessage?.content[0]).toEqual({ kind: "text", text: "Found 1 product." });
      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0]?.output).toMatchObject({ query: "keyboard", count: 1, agentName: CATALOG_AGENT });
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["catalog.search"]);
      expect(provider.requests[0]?.messages[0]?.role).toBe("user");
      expect(provider.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
      expect(provider.contexts[0]?.agentName).toBe(CATALOG_AGENT);
      expect(provider.contexts[0]?.metadata).toEqual({ tenant: "acme" });
    } finally {
      await container.dispose();
    }
  });

  test("generates invocation ids from Web Crypto when no id is provided", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      const result = await runtime.run(CatalogAgent, { input: "Find keyboards" });

      expect(result.invocationId).toMatch(
        /^inv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(provider.requests[0]?.invocationId).toBe(result.invocationId);
    } finally {
      await container.dispose();
    }
  });

  test("stops deterministically when the provider keeps requesting tools past maxSteps", async () => {
    class LoopingProvider implements AgentModelProvider {
      public calls = 0;

      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "tool-calls",
          toolCalls: [agentToolCall({ id: `tool-call-${this.calls}`, name: "catalog.search", input: { query: "loop" } })],
        });
      }
    }

    const provider = new LoopingProvider();
    const adapter: LlmProviderAdapter = { create: () => provider };

    @Infra({ llm: llmConnect(llmConfig, adapter) })
    class AppInfra {}

    @Module({
      imports: [AppInfra],
      tools: [SearchCatalogTool],
      providers: [scoped(SearchCatalogTool)],
    })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const result = await runtime.run(CatalogAgent, { id: "inv-1", input: "Loop", maxSteps: 2 });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_MAX_STEPS_EXCEEDED");
      expect(result.steps).toBe(2);
      expect(provider.calls).toBe(2);
    } finally {
      await container.dispose();
    }
  });

  test("llmConnect and llmRouter register AgentRuntime by type with AGENT_RUNTIME_OPTIONS from any module", async () => {
    class LoopingProvider implements AgentModelProvider {
      calls = 0;
      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: `loop-${this.calls}`, name: "catalog.search", input: { query: "loop" } })] });
      }
    }
    for (const connector of ["llmConnect", "llmRouter"] as const) {
      const provider = new LoopingProvider();
      const adapter: LlmProviderAdapter = { create: () => provider };
      @Infra({ llm: connector === "llmConnect" ? llmConnect(llmConfig, adapter) : llmRouter({ main: llmProfile(llmConfig, adapter) }) })
      class AppInfra {}
      @Module({ providers: [DI.singleton(DI.valueProvider(AGENT_RUNTIME_OPTIONS, { maxSteps: 2 }))] })
      class AgentSettingsModule {}
      @Module({ imports: [AppInfra, AgentSettingsModule], tools: [SearchCatalogTool], providers: [scoped(SearchCatalogTool)] })
      class AppModule {}

      const container = createContainer(AppModule);
      try {
        const runtime = container.resolve(AgentRuntime);
        expect(container.resolve(AgentRuntime)).toBe(runtime);
        const result = await runtime.run(CatalogAgent, { input: "Loop" });
        expect(result.error?.code, connector).toBe("AGENT_MAX_STEPS_EXCEEDED");
        expect(provider.calls, connector).toBe(2);
      } finally {
        await container.dispose();
      }
    }
  });

  test("rejects a definition naming an unregistered tool before the provider is called", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      expect(runtime.listTools().map((tool) => tool.metadata.name)).toEqual(["catalog.search"]);
      const run = runtime.run({ name: "support", instructions: "Help.", toolNames: ["catalog.search", "orders.delete"] }, { input: "Hello" });
      await expect(run).rejects.toThrow(AgentSetupError);
      await expect(run).rejects.toThrow('Agent "support": tool "orders.delete" is not registered in the application (registered: catalog.search).');
      await expect(runtime.run({ name: "bad name!", instructions: "" }, { input: "Hello" })).rejects.toThrow(AgentSetupError);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  test("check validates a definition like run, without calling the model", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      expect(() => runtime.check({ name: "support", instructions: "Help.", toolNames: ["catalog.search"] })).not.toThrow();
      expect(() => runtime.check({ name: "support", instructions: "Help.", toolNames: ["orders.delete"] })).toThrow(
        'Agent "support": tool "orders.delete" is not registered in the application (registered: catalog.search).',
      );
      expect(() => runtime.check({ name: "support", instructions: "Help.", toolNames: ["catalog.search", "catalog.search"] })).toThrow(AgentSetupError);
      expect(() => runtime.check({ name: "bad name!", instructions: "" })).toThrow(AgentSetupError);
      expect(() => runtime.check({ name: "support", instructions: null } as never)).toThrow(AgentSetupError);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  test("a later change of a definition object does not affect a run already started", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      const definition = { name: "mutable", instructions: "Original instructions.", toolNames: ["catalog.search"] };
      const pending = runtime.run(definition, { input: "Find keyboards" });
      definition.instructions = "Changed instructions.";
      definition.toolNames.length = 0;
      const result = await pending;
      expect(result.status).toBe("completed");
      expect(provider.requests[0]?.messages[0]?.content[0]).toEqual({ kind: "text", text: "Original instructions." });
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual(["catalog.search"]);
    } finally {
      await container.dispose();
    }
  });

  test("returns a validated structured output when run requests a JSON contract", async () => {
    const replies = ["{\"goal\":\"Checkout supports promo codes.\"}", "{\"goal\":42}", "not-json"];
    const requests: AgentModelRequest[] = [];
    const provider: AgentModelProvider = {
      complete(request) {
        requests.push(request);
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", replies[requests.length - 1]!) });
      },
    };
    const container = createContainer({});
    const runtime = new AgentRuntime(container, provider);
    const output = agentOutputContract({
      mode: "json",
      schema: agentJsonSchema("Requirements", { type: "object", properties: { goal: { type: "string" } }, required: ["goal"], additionalProperties: false }),
    });
    const analyst = { name: "analyst", instructions: "Write the goal of the feature." };
    try {
      const valid = await runtime.run(analyst, { input: { feature: "checkout promo code" }, output });
      expect(valid.status).toBe("completed");
      expect(valid.output).toEqual({ goal: "Checkout supports promo codes." });
      expect(requests[0]?.output).toMatchObject({ mode: "json", schema: { kind: "json-schema", name: "Requirements" } });

      const wrongType = await runtime.run(analyst, { input: { feature: "checkout" }, output });
      expect(wrongType.status).toBe("failed");
      expect(wrongType.error?.code).toBe("AGENT_OUTPUT_INVALID");

      const malformed = await runtime.run(analyst, { input: { feature: "checkout" }, output });
      expect(malformed.error).toMatchObject({ code: "AGENT_OUTPUT_INVALID", message: "JSON output is malformed." });
    } finally {
      await container.dispose();
    }
  });

  test("rejects excessive parallel tool calls before resolving any tool", async () => {
    class FloodingProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "tool-calls",
          toolCalls: [
            agentToolCall({ id: "call-1", name: "catalog.search" }),
            agentToolCall({ id: "call-2", name: "catalog.search" }),
          ],
        });
      }
    }
    @Module({ tools: [SearchCatalogTool], providers: [scoped(SearchCatalogTool)] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new FloodingProvider(), {
      maxToolCallsPerStep: 1,
    });
    try {
      const result = await runtime.run(CatalogAgent, { input: "Flood" });
      expect(result.error?.code).toBe("AGENT_TOOL_CALL_LIMIT_EXCEEDED");
      expect(result.toolResults).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  test("uses the agent model profile and lets invoke override it", async () => {
    class CapturingProvider implements AgentModelProvider {
      public readonly requests: AgentModelRequest[] = [];
      public readonly contexts: AgentModelProviderContext[] = [];

      complete(request: AgentModelRequest, context: AgentModelProviderContext): AgentModelResponse {
        this.requests.push(request);
        this.contexts.push(context);
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", `profile:${request.modelProfile ?? "none"}`),
        });
      }
    }

    const provider = new CapturingProvider();
    const adapter: LlmProviderAdapter = { create: () => provider };

    @Infra({ llm: llmConnect(llmConfig, adapter) })
    class AppInfra {}

    @Module({ imports: [AppInfra] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const defaultProfile = await runtime.run(ProfiledAgent, { id: "inv-1", input: "Use default profile" });
      const overrideProfile = await runtime.run(ProfiledAgent, {
        id: "inv-2",
        input: "Use override profile",
        modelProfile: "fast",
      });

      expect(defaultProfile.finalMessage?.content[0]).toEqual({ kind: "text", text: "profile:reasoning" });
      expect(overrideProfile.finalMessage?.content[0]).toEqual({ kind: "text", text: "profile:fast" });
      expect(provider.requests.map((request) => request.modelProfile)).toEqual(["reasoning", "fast"]);
      expect(provider.contexts.map((context) => context.modelProfile)).toEqual(["reasoning", "fast"]);
    } finally {
      await container.dispose();
    }
  });

  test("builds prompt context for the provider without storing it in the conversation history", async () => {
    class CapturingProvider implements AgentModelProvider {
      public readonly requests: AgentModelRequest[] = [];

      complete(request: AgentModelRequest): AgentModelResponse {
        this.requests.push(request);
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "Done"),
        });
      }
    }

    @Module({})
    class AppModule {}

    const provider = new CapturingProvider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, provider);
    try {
      const result = await runtime.run(PromptedRuntimeAgent, {
        id: "inv-1",
        input: "Gather the context",
        contextLimits: { maxMessages: 3 },
      });

      expect(result.status).toBe("completed");
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(provider.requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(provider.requests[0]?.messages[0]?.content[0]).toMatchObject({
        kind: "text",
        text: "You are the runtime agent. Keep the user's last request.",
      });
      const contextMetadata = provider.requests[0]?.metadata.agentContext as JsonObject | undefined;
      expect(contextMetadata?.messageCount).toBe(2);
      expect(contextMetadata?.trace).toEqual([
        expect.objectContaining({ section: "prompt", included: true }),
        expect.objectContaining({ section: "conversation[0]", included: true }),
      ]);
    } finally {
      await container.dispose();
    }
  });

  test("fails closed when a custom context builder returns an invalid model request", async () => {
    class ProviderShouldNotRun implements AgentModelProvider {
      public calls = 0;

      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "unexpected"),
        });
      }
    }

    const emptyContextBuilder: AgentContextBuilder = {
      build() {
        return {
          messages: Object.freeze([]),
          trace: Object.freeze([]),
          metadata: Object.freeze({}),
        };
      },
    };

    @Module({})
    class AppModule {}

    const provider = new ProviderShouldNotRun();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, provider, {
      contextBuilder: emptyContextBuilder,
    });
    try {
      const result = await runtime.run(ProfiledAgent, { id: "inv-1", input: "Hello" });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_CONTEXT_INVALID");
      expect(provider.calls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("redacts credentials from provider errors", async () => {
    class FailingProvider implements AgentModelProvider {
      complete(): AgentModelResponse {
        throw new Error("authorization: Bearer abcdefghijkl");
      }
    }
    @Module({})
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new FailingProvider());
    try {
      const result = await runtime.run(ProfiledAgent, { input: "Hello" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
      expect(result.error?.message).not.toContain("abcdefghijkl");
      expect(result.error?.message).toContain("***");
    } finally {
      await container.dispose();
    }
  });

  test("uses a 60 second provider default and accepts zero as an explicit timeout opt-out", async () => {
    class NeverProvider implements AgentModelProvider {
      complete(): Promise<AgentModelResponse> {
        return new Promise(() => undefined);
      }
    }
    @Module({})
    class AppModule {}

    const container = createContainer(AppModule);
    const catalog = AgentRegistry.fromContainer(container);
    const shortRuntime = new AgentRuntime(container, new NeverProvider(), { timeoutMs: 2 });
    try {
      expect(new AgentExecutionDriver(container, catalog, new NeverProvider()).defaultTimeoutMs).toBe(60_000);
      expect(new AgentExecutionDriver(container, catalog, new NeverProvider(), { timeoutMs: 0 }).defaultTimeoutMs).toBeUndefined();

      const timedOut = await shortRuntime.run(ProfiledAgent, { input: "timeout" });
      expect(timedOut.error?.code).toBe("AGENT_PROVIDER_TIMEOUT");

      const controller = new AbortController();
      const pending = shortRuntime.run(ProfiledAgent, {
        input: "timeout disabled",
        timeoutMs: 0,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 5);
      const aborted = await pending;
      expect(aborted.error?.code).toBe("AGENT_ABORTED");
    } finally {
      await container.dispose();
    }
  });

  test("runs end-to-end with the OpenAI-compatible adapter from infra", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    let calls = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tool-call-1",
                    type: "function",
                    function: { name: "catalog_search", arguments: "{\"query\":\"keyboard\"}" },
                  },
                ],
              },
            },
          ],
        }));
      }
      if (calls === 2) {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-call-2",
                type: "function",
                function: { name: "catalog_search", arguments: "{\"query\":\"mouse\"}" },
              }],
            },
          }],
        }));
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Found 2 products." } }],
      }));
    };

    @Infra({ llm: llmConnect(llmConfig, openAiCompatibleAdapter({ fetch: fetcher, healthCheck: false })) })
    class AppInfra {}

    @Module({
      imports: [AppInfra],
      tools: [SearchCatalogTool],
      providers: [scoped(SearchCatalogTool)],
    })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const result = await runtime.run(CatalogAgent, { id: "inv-1", input: "Find keyboards", maxSteps: 4 });

      expect(result.status).toBe("completed");
      expect(result.finalMessage?.content[0]).toEqual({ kind: "text", text: "Found 2 products." });
      expect(result.toolResults[0]?.output).toMatchObject({ query: "keyboard", count: 1 });
      expect(result.toolResults[1]?.output).toMatchObject({ query: "mouse", count: 1 });
      expect(calls).toBe(3);
      expect(((capturedBodies[0]?.tools as readonly Record<string, unknown>[])[0]?.function as Record<string, unknown>).name).toBe(
        "catalog_search",
      );
      const secondMessages = capturedBodies[1]?.messages as readonly Record<string, unknown>[];
      expect(secondMessages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "tool-call-1" }] });
      expect(secondMessages[2]).toMatchObject({ role: "tool", tool_call_id: "tool-call-1" });
      const thirdMessages = capturedBodies[2]?.messages as readonly Record<string, unknown>[];
      expect(thirdMessages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "tool-call-1" }] });
      expect(thirdMessages[2]).toMatchObject({ role: "tool", tool_call_id: "tool-call-1" });
      expect(thirdMessages[3]).toMatchObject({ role: "assistant", tool_calls: [{ id: "tool-call-2" }] });
      expect(thirdMessages[4]).toMatchObject({ role: "tool", tool_call_id: "tool-call-2" });
    } finally {
      await container.dispose();
    }
  });

  test("derives distinct default, prefixed and custom idempotency keys for every model call", async () => {
    const observed: { invocationId: string; callId: string; key: string | null }[] = [];

    @Tool({ name: "keys.capture", description: "Captures the runtime idempotency key.", sideEffect: "read" })
    class CaptureKeyTool {
      execute(_input: JsonValue, context: AgentToolExecutionContext): JsonObject {
        observed.push({
          invocationId: context.invocationId ?? "",
          callId: context.call.id,
          key: context.idempotencyKey ?? null,
        });
        return { ok: true };
      }
    }

    const KeyAgent = agentDefinition({ name: "key-agent", tools: [CaptureKeyTool] });

    class TwoCallProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        if (!request.messages.some((message) => message.role === "tool")) {
          return agentModelResponse({
            invocationId: request.invocationId,
            finishReason: "tool-calls",
            toolCalls: [
              agentToolCall({ id: "call-a", name: "keys.capture" }),
              agentToolCall({ id: "call-b", name: "keys.capture" }),
            ],
          });
        }
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "done"),
        });
      }
    }

    @Module({ tools: [CaptureKeyTool], providers: [scoped(CaptureKeyTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new TwoCallProvider());
    try {
      await runtime.run(KeyAgent, { id: "inv-default", input: "default" });
      await runtime.run(KeyAgent, {
        id: "inv-prefix",
        input: "prefix",
        toolExecution: { idempotencyKey: "tenant-job" },
      });
      await runtime.run(KeyAgent, {
        id: "inv-custom",
        input: "custom",
        toolExecution: {
          idempotencyKeyForCall: ({ invocationId, call }) => `domain:${invocationId}:${call.id}`,
        },
      });

      const defaults = observed.filter((item) => item.invocationId === "inv-default");
      expect(defaults.map((item) => item.key)).toEqual([
        "agent:11:inv-default:6:call-a",
        "agent:11:inv-default:6:call-b",
      ]);
      expect(new Set(defaults.map((item) => item.key)).size).toBe(2);
      expect(observed.filter((item) => item.invocationId === "inv-prefix").map((item) => item.key)).toEqual([
        "agent:10:tenant-job:6:call-a",
        "agent:10:tenant-job:6:call-b",
      ]);
      expect(observed.filter((item) => item.invocationId === "inv-custom").map((item) => item.key)).toEqual([
        "domain:inv-custom:call-a",
        "domain:inv-custom:call-b",
      ]);
    } finally {
      await container.dispose();
    }
  });

  test("rejects a model call id already present in invocation history before repeating its side effect", async () => {
    let executions = 0;

    @Tool({ name: "history.write", description: "Writes once.", sideEffect: "write", approval: "required" })
    class HistoryWriteTool {
      execute(): JsonObject {
        executions += 1;
        return { ok: true };
      }
    }
    const HistoryAgent = agentDefinition({ name: "history-agent", tools: [HistoryWriteTool] });
    class ReusingProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "tool-calls",
          toolCalls: [agentToolCall({ id: "call-existing", name: "history.write" })],
        });
      }
    }
    @Module({ tools: [HistoryWriteTool], providers: [scoped(HistoryWriteTool)] })
    class AppModule {}

    const existingCall = agentToolCall({ id: "call-existing", name: "history.write" });
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new ReusingProvider(), {
      toolExecutorOptions: { approvalPolicy: () => true, auditSink: () => undefined },
    });
    try {
      const result = await runtime.run(HistoryAgent, {
        id: "inv-history",
        messages: [
          agentMessage("user", "resume"),
          agentMessage("assistant", agentToolCallPart(existingCall)),
          agentMessage(
            "tool",
            agentToolResultPart(agentToolResult({ callId: existingCall.id, name: existingCall.name, output: { ok: true } })),
            { toolCallId: existingCall.id },
          ),
        ],
      });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_PROVIDER_RESPONSE_INVALID");
      expect(result.toolResults).toHaveLength(0);
      expect(executions).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("stops model continuation after a timed-out write with unknown outcome and audits its settlement", async () => {
    const entries: AgentToolAuditEntry[] = [];
    let providerCalls = 0;

    @Tool({ name: "slow.write", description: "Completes after the caller timeout.", sideEffect: "write", timeoutMs: 1 })
    class SlowWriteTool {
      async execute(): Promise<JsonObject> {
        await Bun.sleep(20);
        return { committed: true };
      }
    }
    const SlowWriteAgent = agentDefinition({ name: "slow-write-agent", tools: [SlowWriteTool] });
    class ContinuingProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        providerCalls += 1;
        if (providerCalls === 1) {
          return agentModelResponse({
            invocationId: request.invocationId,
            finishReason: "tool-calls",
            toolCalls: [agentToolCall({ id: "slow-call", name: "slow.write" })],
          });
        }
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "unsafe continuation"),
        });
      }
    }
    @Module({ tools: [SlowWriteTool], providers: [scoped(SlowWriteTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new ContinuingProvider(), {
      toolExecutorOptions: {
        approvalPolicy: () => true,
        auditSink: (entry) => { entries.push(entry); },
      },
    });
    try {
      const result = await runtime.run(SlowWriteAgent, { id: "inv-slow-write", input: "write" });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_TOOL_OUTCOME_UNKNOWN");
      expect(result.toolResults[0]?.error?.code).toBe("TOOL_TIMEOUT_OUTCOME_UNKNOWN");
      expect(providerCalls).toBe(1);
      await Bun.sleep(25);
      expect(entries.map((entry) => entry.phase)).toEqual(["attempt", "result", "settlement"]);
      expect(entries[2]?.result).toMatchObject({ status: "success", output: { committed: true } });
    } finally {
      await container.dispose();
    }
  });

  test("stops model continuation when result audit fails after a successful write", async () => {
    let writes = 0;
    let providerCalls = 0;

    @Tool({ name: "audited.write", description: "A write requiring durable result audit.", sideEffect: "write" })
    class AuditedWriteTool {
      execute(): JsonObject {
        writes += 1;
        return { committed: true };
      }
    }
    const AuditedWriteAgent = agentDefinition({ name: "audited-write-agent", tools: [AuditedWriteTool] });
    class UnsafeContinuingProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        providerCalls += 1;
        if (providerCalls === 1) {
          return agentModelResponse({
            invocationId: request.invocationId,
            finishReason: "tool-calls",
            toolCalls: [agentToolCall({ id: "audited-call", name: "audited.write" })],
          });
        }
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "would continue"),
        });
      }
    }
    @Module({ tools: [AuditedWriteTool], providers: [scoped(AuditedWriteTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, new UnsafeContinuingProvider(), {
      toolExecutorOptions: {
        approvalPolicy: () => true,
        auditSink: (entry) => {
          if (entry.phase === "result") throw new Error("audit storage unavailable");
        },
      },
    });
    try {
      const result = await runtime.run(AuditedWriteAgent, { id: "inv-audited-write", input: "write" });
      expect(writes).toBe(1);
      expect(providerCalls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_TOOL_OUTCOME_UNKNOWN");
      expect(result.error?.details).toMatchObject({ toolErrorCode: "TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN" });
      expect(result.toolResults[0]?.error?.code).toBe("TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN");
    } finally {
      await container.dispose();
    }
  });

  test("stops after post-commit execute, output and disposer failures without a second provider call", async () => {
    let commitThenThrows = 0;
    class InvalidCommittedOutput {
      count = 0;
    }
    class ThrowingCommittedState {
      dispose(): void {
        throw new Error("dispose failed");
      }
    }
    class SlowCommittedState {
      async dispose(): Promise<void> {
        await Bun.sleep(20);
      }
    }

    @Tool({ name: "commit.invalid-output", description: "Commits then returns invalid output.", output: InvalidCommittedOutput, sideEffect: "write" })
    class InvalidCommittedOutputTool {
      execute(): JsonObject {
        return { count: "invalid" };
      }
    }
    @Tool({ name: "commit.throwing-dispose", description: "Commits before throwing dispose.", sideEffect: "write" })
    class ThrowingCommittedDisposeTool {
      constructor(private readonly _state: ThrowingCommittedState) {}
      execute(): JsonObject { return { committed: true }; }
    }
    @Tool({ name: "commit.slow-dispose", description: "Commits before slow dispose.", sideEffect: "write" })
    class SlowCommittedDisposeTool {
      constructor(private readonly _state: SlowCommittedState) {}
      execute(): JsonObject { return { committed: true }; }
    }
    @Tool({ name: "commit.then-throw", description: "Commits and then throws.", sideEffect: "write" })
    class CommitThenThrowTool {
      execute(): never {
        commitThenThrows += 1;
        throw new Error("failed after commit");
      }
    }
    const PostCommitAgent = agentDefinition({ name: "post-commit-agent", tools: [InvalidCommittedOutputTool, ThrowingCommittedDisposeTool, SlowCommittedDisposeTool, CommitThenThrowTool] });
    @Module({
      tools: [InvalidCommittedOutputTool, ThrowingCommittedDisposeTool, SlowCommittedDisposeTool, CommitThenThrowTool],
      providers: [
        scoped(InvalidCommittedOutputTool),
        scoped(ThrowingCommittedState),
        scoped(ThrowingCommittedDisposeTool, ThrowingCommittedDisposeTool, [ThrowingCommittedState]),
        scoped(SlowCommittedState),
        scoped(SlowCommittedDisposeTool, SlowCommittedDisposeTool, [SlowCommittedState]),
        scoped(CommitThenThrowTool),
      ],
    })
    class AppModule {}

    class SingleToolProvider implements AgentModelProvider {
      public calls = 0;
      constructor(private readonly toolName: string) {}
      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        if (this.calls === 1) {
          return agentModelResponse({
            invocationId: request.invocationId,
            finishReason: "tool-calls",
            toolCalls: [agentToolCall({ id: `${this.toolName}-call`, name: this.toolName })],
          });
        }
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "unsafe second call"),
        });
      }
    }

    const container = createContainer(AppModule);
    const cases = [
      ["commit.invalid-output", "TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN"],
      ["commit.throwing-dispose", "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN"],
      ["commit.slow-dispose", "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN"],
      ["commit.then-throw", "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN"],
    ] as const;
    try {
      for (const [toolName, expectedToolCode] of cases) {
        const provider = new SingleToolProvider(toolName);
        const runtime = new AgentRuntime(container, provider, {
          toolExecutorOptions: {
            approvalPolicy: () => true,
            auditSink: () => undefined,
            scopeDisposeTimeoutMs: 1,
            schemaValidator: {
              validate(instance) {
                const count = (instance as { count?: unknown }).count;
                return typeof count === "number"
                  ? { isValid: true, errors: [] }
                  : { isValid: false, errors: [{ property: "count", message: "count must be a number" }] };
              },
            },
          },
        });
        const result = await runtime.run(PostCommitAgent, {
          id: `inv-${toolName}`,
          input: "commit",
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("AGENT_TOOL_OUTCOME_UNKNOWN");
        expect(result.toolResults[0]?.error?.code).toBe(expectedToolCode);
        expect(provider.calls).toBe(1);
      }
      expect(commitThenThrows).toBe(1);
      await Bun.sleep(25);
    } finally {
      await container.dispose();
    }
  });

  test("rejects malformed provider envelopes before any tool effect", async () => {
    let effects = 0;
    @Tool({ name: "raw.effect", description: "Must not run.", sideEffect: "read" })
    class RawEffectTool { execute(): JsonObject { effects += 1; return { ok: true }; } }
    const RawProviderAgent = agentDefinition({ name: "raw-provider-agent", tools: [RawEffectTool] });
    @Module({ tools: [RawEffectTool], providers: [scoped(RawEffectTool)] })
    class AppModule {}
    const container = createContainer(AppModule);
    try {
      const malformed = [
        {},
        { invocationId: "ignored", finishReason: "tool-calls", toolCalls: null },
        { invocationId: "ignored", finishReason: "tool-calls", toolCalls: {} },
        { invocationId: "ignored", finishReason: "tool-calls", toolCalls: [{ id: "call", name: "raw.effect", input: { nested: () => undefined } }] },
      ];
      for (const response of malformed) {
        const runtime = new AgentRuntime(container, {
          complete: () => response as AgentModelResponse,
        });
        const result = await runtime.run(RawProviderAgent, { input: "go" });
        expect(result.error?.code).toBe("AGENT_PROVIDER_RESPONSE_INVALID");
        expect(result.toolResults).toHaveLength(0);
      }
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

  test("rejects an entire mixed provider tool batch before the valid Tool can execute", async () => {
    let effects = 0;
    @Tool({ name: "batch.valid", description: "Must not execute in malformed batch.", sideEffect: "read" })
    class ValidBatchTool { execute(): JsonObject { effects += 1; return { ok: true }; } }
    const MixedBatchAgent = agentDefinition({ name: "mixed-batch-agent", tools: [ValidBatchTool] });
    @Module({ tools: [ValidBatchTool], providers: [scoped(ValidBatchTool)] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, {
      complete: () => ({
        invocationId: "ignored",
        finishReason: "tool-calls",
        toolCalls: [
          { id: "valid", name: "batch.valid", input: {} },
          { id: "invalid", name: "batch.valid", input: { nested: () => undefined } },
        ],
      }) as unknown as AgentModelResponse,
    });
    try {
      const result = await runtime.run(MixedBatchAgent, { input: "x" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_RESPONSE_INVALID");
      expect(result.toolResults).toHaveLength(0);
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

  test("contains hostile provider thrown values as redacted runtime failures", async () => {
    const hostile = [Object.create(null), { toString() { throw new Error("secret-hostile"); } }];
    for (const thrown of hostile) {
      const provider = { complete() { throw thrown; } } as AgentModelProvider;
      const { runtime, container } = createRuntime(provider as ScriptedModelProvider);
      try {
        const result = await runtime.run(CatalogAgent, { input: "x" });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
        expect(result.error?.message).not.toContain("secret-hostile");
      } finally { await container.dispose(); }
    }
  });

  test("rejects a mixed raw OpenAI-compatible vendor batch before Tool execution", async () => {
    let effects = 0;
    @Tool({ name: "adapter.valid", description: "valid", sideEffect: "read" }) class ValidTool { execute() { effects += 1; return { ok: true }; } }
    const BatchAgent = agentDefinition({ name: "adapter-batch-agent", tools: [ValidTool] });
    @Module({ tools: [ValidTool], providers: [scoped(ValidTool)] }) class AppModule {}
    const provider = openAiCompatibleAdapter({ fetch: async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "valid", type: "function", function: { name: "adapter_valid", arguments: "{}" } }, { id: "bad", type: "unknown" }] } }] }) }).create({ provider: "openai-compatible", model: "test", baseUrl: "https://invalid", apiKey: "secret" }) as AgentModelProvider;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, provider);
    try {
      const result = await runtime.run(BatchAgent, { input: "x" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

});
