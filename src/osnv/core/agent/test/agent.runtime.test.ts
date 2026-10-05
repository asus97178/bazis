import { describe, expect, test } from "bun:test";
import { createContainer, Module, scoped } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { modelValidatorAdapter } from "@/library/validation";
import { Infra, llmConnect, openAiCompatibleAdapter, type LlmProviderAdapter } from "@/core/infra";
import {
  AGENT_MODEL_PROVIDER,
  Agent,
  AgentRegistry,
  AgentRuntime,
  Prompt,
  Task,
  Tool,
  agentData,
  agentMessage,
  agentModelResponse,
  agentOutput,
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

@Agent({
  name: CATALOG_AGENT,
  tools: [SearchCatalogTool],
  maxSteps: 4,
})
class CatalogAgent {}

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

@Agent({
  name: "profiled-agent",
  modelProfile: "reasoning",
})
class ProfiledAgent {}

@Prompt({
  name: "runtime.prompt",
  role: "Runtime prompt",
  goal: "Keep runtime requests explicit.",
  instructions: ["Keep the user's last request."],
})
class RuntimePrompt {}

@Agent({
  name: "prompted-runtime-agent",
  role: "Runtime agent",
  prompt: RuntimePrompt,
})
class PromptedRuntimeAgent {}

class RequirementsRequest {
  feature!: string;
}

class RequirementsDocument {
  goal!: string;
}

@Agent({
  name: "task-runtime-agent",
})
class TaskRuntimeAgent {
  @Task({
    name: "prepare-requirements",
    description: "Prepare the requirements.",
    input: RequirementsRequest,
    output: RequirementsDocument,
    modelProfile: "reasoning",
    maxSteps: 2,
  })
  prepareRequirements(_request: RequirementsRequest): RequirementsDocument {
    return agentOutput();
  }
}

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
    agents: [CatalogAgent],
    tools: [SearchCatalogTool],
    providers: [scoped(SearchCatalogTool)],
  })
  class AppModule {}

  const container = createContainer(AppModule);
  const registry = AgentRegistry.fromModules([AppModule]);
  const runtime = new AgentRuntime(container, registry, container.resolve(AGENT_MODEL_PROVIDER));
  return { runtime, container };
}

describe("agent runtime", () => {
  test("invokes the model provider from infra, executes tool calls and returns the final message", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      const result = await runtime.invoke(CATALOG_AGENT, {
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
      const result = await runtime.invoke(CATALOG_AGENT, { input: "Find keyboards" });

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
      agents: [CatalogAgent],
      tools: [SearchCatalogTool],
      providers: [scoped(SearchCatalogTool)],
    })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const result = await runtime.invoke(CATALOG_AGENT, { id: "inv-1", input: "Loop", maxSteps: 2 });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_MAX_STEPS_EXCEEDED");
      expect(result.steps).toBe(2);
      expect(provider.calls).toBe(2);
    } finally {
      await container.dispose();
    }
  });

  test("classifies an unknown agent without invoking the provider", async () => {
    const provider = new ScriptedModelProvider();
    const { runtime, container } = createRuntime(provider);
    try {
      const result = await runtime.invoke("missing-agent", { input: "Hello" });
      expect(result.error?.code).toBe("AGENT_NOT_REGISTERED");
      expect(provider.requests).toHaveLength(0);
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
    @Module({ agents: [CatalogAgent], tools: [SearchCatalogTool], providers: [scoped(SearchCatalogTool)] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new FloodingProvider(), {
      maxToolCallsPerStep: 1,
    });
    try {
      const result = await runtime.invoke(CATALOG_AGENT, { input: "Flood" });
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

    @Module({ imports: [AppInfra], agents: [ProfiledAgent] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const defaultProfile = await runtime.invoke("profiled-agent", { id: "inv-1", input: "Use default profile" });
      const overrideProfile = await runtime.invoke("profiled-agent", {
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

    @Module({
      agents: [PromptedRuntimeAgent],
      prompts: [RuntimePrompt],
    })
    class AppModule {}

    const provider = new CapturingProvider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider);
    try {
      const result = await runtime.invoke("prompted-runtime-agent", {
        id: "inv-1",
        input: "Gather the context",
        contextLimits: { maxMessages: 3 },
      });

      expect(result.status).toBe("completed");
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(provider.requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(provider.requests[0]?.messages[0]?.content[0]).toMatchObject({
        kind: "text",
        text: expect.stringContaining("Prompt role: Runtime prompt"),
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

    @Module({ agents: [ProfiledAgent] })
    class AppModule {}

    const provider = new ProviderShouldNotRun();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, {
      contextBuilder: emptyContextBuilder,
    });
    try {
      const result = await runtime.invoke("profiled-agent", { id: "inv-1", input: "Hello" });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_CONTEXT_INVALID");
      expect(provider.calls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("invokes a controller-style task and derives its output contract", async () => {
    class CapturingProvider implements AgentModelProvider {
      public readonly requests: AgentModelRequest[] = [];

      complete(request: AgentModelRequest): AgentModelResponse {
        this.requests.push(request);
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "{\"goal\":\"Checkout supports promo codes.\"}"),
        });
      }
    }

    @Module({ agents: [TaskRuntimeAgent] })
    class AppModule {}

    const provider = new CapturingProvider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, {
      taskSchemaValidator: modelValidatorAdapter,
    });
    try {
      const result = await runtime.invokeTask("task-runtime-agent", "prepare-requirements", {
        feature: "checkout promo code",
      });

      expect(result.status).toBe("completed");
      expect(result.metadata.taskName).toBe("prepare-requirements");
      expect(provider.requests[0]?.modelProfile).toBe("reasoning");
      expect(provider.requests[0]?.output).toMatchObject({
        mode: "json",
        schema: { kind: "class", name: "RequirementsDocument" },
      });
      expect(provider.requests[0]?.metadata.taskName).toBe("prepare-requirements");
      expect(provider.requests[0]?.messages[0]?.role).toBe("user");
      expect(result.output).toEqual({ goal: "Checkout supports promo codes." });
    } finally {
      await container.dispose();
    }
  });

  test("fails a task whose structured output is malformed", async () => {
    class InvalidTaskProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", "not-json"),
        });
      }
    }
    @Module({ agents: [TaskRuntimeAgent] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new InvalidTaskProvider(), {
      taskSchemaValidator: modelValidatorAdapter,
    });
    try {
      const result = await runtime.invokeTask("task-runtime-agent", "prepare-requirements", { feature: "checkout" });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_TASK_OUTPUT_INVALID");
    } finally {
      await container.dispose();
    }
  });

  test("rejects over-posted task fields in validator-only fallback contracts", async () => {
    class OverPostingProvider implements AgentModelProvider {
      public calls = 0;

      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "stop",
          message: agentMessage("assistant", JSON.stringify({
            goal: "Valid goal",
            isAdmin: true,
          })),
        });
      }
    }
    @Module({ agents: [TaskRuntimeAgent] })
    class AppModule {}
    const provider = new OverPostingProvider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, {
      taskSchemaValidator: modelValidatorAdapter,
    });
    try {
      const badInput = await runtime.invokeTask("task-runtime-agent", "prepare-requirements", {
        feature: "checkout",
        isAdmin: true,
      });
      expect(badInput.status).toBe("failed");
      expect(badInput.error?.code).toBe("AGENT_TASK_INPUT_INVALID");
      expect(badInput.error?.message).toContain("isAdmin");
      expect(provider.calls).toBe(0);

      const badOutput = await runtime.invokeTask("task-runtime-agent", "prepare-requirements", {
        feature: "checkout",
      });
      expect(badOutput.status).toBe("failed");
      expect(badOutput.error?.code).toBe("AGENT_TASK_OUTPUT_INVALID");
      expect(badOutput.error?.message).toContain("isAdmin");
      expect(provider.calls).toBe(1);
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
    @Module({ agents: [ProfiledAgent] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new FailingProvider());
    try {
      const result = await runtime.invoke("profiled-agent", { input: "Hello" });
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
    @Module({ agents: [ProfiledAgent] })
    class AppModule {}

    const container = createContainer(AppModule);
    const registry = AgentRegistry.fromModules([AppModule]);
    const defaultRuntime = new AgentRuntime(container, registry, new NeverProvider());
    const disabledRuntime = new AgentRuntime(container, registry, new NeverProvider(), { timeoutMs: 0 });
    const shortRuntime = new AgentRuntime(container, registry, new NeverProvider(), { timeoutMs: 2 });
    try {
      const timeoutOf = (runtime: AgentRuntime) => (runtime as unknown as { driver: { defaultTimeoutMs?: number } }).driver.defaultTimeoutMs;
      expect(timeoutOf(defaultRuntime)).toBe(60_000);
      expect(timeoutOf(disabledRuntime)).toBeUndefined();

      const timedOut = await shortRuntime.invoke("profiled-agent", { input: "timeout" });
      expect(timedOut.error?.code).toBe("AGENT_PROVIDER_TIMEOUT");

      const controller = new AbortController();
      const pending = shortRuntime.invoke("profiled-agent", {
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
      agents: [CatalogAgent],
      tools: [SearchCatalogTool],
      providers: [scoped(SearchCatalogTool)],
    })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), container.resolve(AGENT_MODEL_PROVIDER));
    try {
      const result = await runtime.invoke(CATALOG_AGENT, { id: "inv-1", input: "Find keyboards", maxSteps: 4 });

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

    @Agent({ name: "key-agent", tools: [CaptureKeyTool] })
    class KeyAgent {}

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

    @Module({ agents: [KeyAgent], tools: [CaptureKeyTool], providers: [scoped(CaptureKeyTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new TwoCallProvider());
    try {
      await runtime.invoke("key-agent", { id: "inv-default", input: "default" });
      await runtime.invoke("key-agent", {
        id: "inv-prefix",
        input: "prefix",
        toolExecution: { idempotencyKey: "tenant-job" },
      });
      await runtime.invoke("key-agent", {
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
    @Agent({ name: "history-agent", tools: [HistoryWriteTool] })
    class HistoryAgent {}
    class ReusingProvider implements AgentModelProvider {
      complete(request: AgentModelRequest): AgentModelResponse {
        return agentModelResponse({
          invocationId: request.invocationId,
          finishReason: "tool-calls",
          toolCalls: [agentToolCall({ id: "call-existing", name: "history.write" })],
        });
      }
    }
    @Module({ agents: [HistoryAgent], tools: [HistoryWriteTool], providers: [scoped(HistoryWriteTool)] })
    class AppModule {}

    const existingCall = agentToolCall({ id: "call-existing", name: "history.write" });
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new ReusingProvider(), {
      toolExecutorOptions: { approvalPolicy: () => true, auditSink: () => undefined },
    });
    try {
      const result = await runtime.invoke("history-agent", {
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
    @Agent({ name: "slow-write-agent", tools: [SlowWriteTool] })
    class SlowWriteAgent {}
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
    @Module({ agents: [SlowWriteAgent], tools: [SlowWriteTool], providers: [scoped(SlowWriteTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new ContinuingProvider(), {
      toolExecutorOptions: {
        approvalPolicy: () => true,
        auditSink: (entry) => { entries.push(entry); },
      },
    });
    try {
      const result = await runtime.invoke("slow-write-agent", { id: "inv-slow-write", input: "write" });
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
    @Agent({ name: "audited-write-agent", tools: [AuditedWriteTool] })
    class AuditedWriteAgent {}
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
    @Module({ agents: [AuditedWriteAgent], tools: [AuditedWriteTool], providers: [scoped(AuditedWriteTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), new UnsafeContinuingProvider(), {
      toolExecutorOptions: {
        approvalPolicy: () => true,
        auditSink: (entry) => {
          if (entry.phase === "result") throw new Error("audit storage unavailable");
        },
      },
    });
    try {
      const result = await runtime.invoke("audited-write-agent", { id: "inv-audited-write", input: "write" });
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
    @Agent({
      name: "post-commit-agent",
      tools: [InvalidCommittedOutputTool, ThrowingCommittedDisposeTool, SlowCommittedDisposeTool, CommitThenThrowTool],
    })
    class PostCommitAgent {}
    @Module({
      agents: [PostCommitAgent],
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const cases = [
      ["commit.invalid-output", "TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN"],
      ["commit.throwing-dispose", "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN"],
      ["commit.slow-dispose", "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN"],
      ["commit.then-throw", "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN"],
    ] as const;
    try {
      for (const [toolName, expectedToolCode] of cases) {
        const provider = new SingleToolProvider(toolName);
        const runtime = new AgentRuntime(container, registry, provider, {
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
        const result = await runtime.invoke("post-commit-agent", {
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

  test("ARCP-DEF-001 rejects malformed provider envelopes before any tool effect", async () => {
    let effects = 0;
    @Tool({ name: "raw.effect", description: "Must not run.", sideEffect: "read" })
    class RawEffectTool { execute(): JsonObject { effects += 1; return { ok: true }; } }
    @Agent({ name: "raw-provider-agent", tools: [RawEffectTool] })
    class RawProviderAgent {}
    @Module({ agents: [RawProviderAgent], tools: [RawEffectTool], providers: [scoped(RawEffectTool)] })
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
        const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
          complete: () => response as AgentModelResponse,
        });
        const result = await runtime.invoke("raw-provider-agent", { input: "go" });
        expect(result.error?.code).toBe("AGENT_PROVIDER_RESPONSE_INVALID");
        expect(result.toolResults).toHaveLength(0);
      }
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-003 makes declared Agent contracts authoritative for direct invoke", async () => {
    class AgentInput { feature!: string; }
    class AgentOutput { goal!: string; }
    @Agent({ name: "declared-contract-agent", input: AgentInput, output: AgentOutput })
    class DeclaredContractAgent {}
    @Module({ agents: [DeclaredContractAgent] })
    class AppModule {}
    class Provider implements AgentModelProvider {
      calls = 0;
      readonly requests: AgentModelRequest[] = [];
      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        this.requests.push(request);
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"goal":"ok"}') });
      }
    }
    const provider = new Provider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, { taskSchemaValidator: modelValidatorAdapter });
    try {
      const rejected = await runtime.invoke("declared-contract-agent", { input: { feature: "x", extra: true } });
      expect(rejected.error?.code).toBe("AGENT_INPUT_INVALID");
      expect(provider.calls).toBe(0);
      const completed = await runtime.invoke("declared-contract-agent", {
        input: { feature: "x" },
        output: { mode: "text" },
      });
      expect(completed.status).toBe("completed");
      expect(provider.requests[0]?.output).toMatchObject({ mode: "json", schema: { kind: "class", name: "AgentOutput" } });
      expect(completed.output).toEqual({ goal: "ok" });
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-003 rejects malformed declared Agent output after one provider call", async () => {
    class DeclaredOutput { goal!: string; }
    @Agent({ name: "invalid-output-agent", output: DeclaredOutput })
    class InvalidOutputAgent {}
    @Module({ agents: [InvalidOutputAgent] })
    class AppModule {}
    class Provider implements AgentModelProvider {
      calls = 0;
      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "not-json") });
      }
    }
    const provider = new Provider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, { taskSchemaValidator: modelValidatorAdapter });
    try {
      const result = await runtime.invoke("invalid-output-agent", { input: "x" });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_OUTPUT_INVALID");
      expect(provider.calls).toBe(1);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-004 bounds declared Agent output validation after provider completion", async () => {
    class SlowOutput { goal!: string; }
    @Agent({ name: "slow-output-agent", output: SlowOutput })
    class SlowOutputAgent {}
    @Module({ agents: [SlowOutputAgent] })
    class AppModule {}
    let rejectLate: ((reason?: unknown) => void) | undefined;
    class Provider implements AgentModelProvider {
      calls = 0;
      complete(request: AgentModelRequest): AgentModelResponse {
        this.calls += 1;
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"goal":"x"}') });
      }
    }
    const provider = new Provider();
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, {
      taskSchemaValidator: { validate: () => new Promise((_resolve, reject) => { rejectLate = reject; }) },
    });
    try {
      const result = await runtime.invoke("slow-output-agent", { input: "x", timeoutMs: 1 });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT");
      expect(provider.calls).toBe(1);
      rejectLate?.(new Error("late output validator rejection"));
      await Bun.sleep(1);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-004 bounds task validation and consumes late rejection", async () => {
    let providerCalls = 0;
    let rejectLate: ((reason?: unknown) => void) | undefined;
    class SlowInput { feature!: string; }
    @Agent({ name: "slow-validation-agent" })
    class SlowValidationAgent {
      @Task({ name: "slow", input: SlowInput })
      slow(_input: SlowInput): unknown { return agentOutput(); }
    }
    @Module({ agents: [SlowValidationAgent] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
      complete(): AgentModelResponse { providerCalls += 1; throw new Error("must not run"); },
    }, {
      taskSchemaValidator: { validate: () => new Promise((_resolve, reject) => { rejectLate = reject; }) },
    });
    try {
      const result = await runtime.invokeTask("slow-validation-agent", "slow", { feature: "x" }, { timeoutMs: 1 });
      expect(result.error?.code).toBe("AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT");
      expect(providerCalls).toBe(0);
      rejectLate?.(new Error("late validator rejection"));
      await Bun.sleep(1);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-004 aborts declared Agent validation before provider dispatch and consumes late rejection", async () => {
    class AbortInput { feature!: string; }
    @Agent({ name: "abort-validation-agent", input: AbortInput })
    class AbortValidationAgent {}
    @Module({ agents: [AbortValidationAgent] })
    class AppModule {}
    let rejectLate: ((reason?: unknown) => void) | undefined;
    let providerCalls = 0;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
      complete(): AgentModelResponse { providerCalls += 1; throw new Error("must not run"); },
    }, { taskSchemaValidator: { validate: () => new Promise((_resolve, reject) => { rejectLate = reject; }) } });
    try {
      const controller = new AbortController();
      const pending = runtime.invoke("abort-validation-agent", { input: { feature: "x" }, signal: controller.signal });
      controller.abort();
      const result = await pending;
      expect(result.error?.code).toBe("AGENT_ABORTED");
      expect(providerCalls).toBe(0);
      rejectLate?.(new Error("late aborted validator rejection"));
      await Bun.sleep(1);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-001 rejects an entire mixed provider tool batch before the valid Tool can execute", async () => {
    let effects = 0;
    @Tool({ name: "batch.valid", description: "Must not execute in malformed batch.", sideEffect: "read" })
    class ValidBatchTool { execute(): JsonObject { effects += 1; return { ok: true }; } }
    @Agent({ name: "mixed-batch-agent", tools: [ValidBatchTool] })
    class MixedBatchAgent {}
    @Module({ agents: [MixedBatchAgent], tools: [ValidBatchTool], providers: [scoped(ValidBatchTool)] })
    class AppModule {}
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
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
      const result = await runtime.invoke("mixed-batch-agent", { input: "x" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_RESPONSE_INVALID");
      expect(result.toolResults).toHaveLength(0);
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

  test("AUD03 applies the runtime default to invokeTask input validation and keeps zero opt-out", async () => {
    class Input { value = ""; }
    @Agent({ name: "audit03-agent" })
    class AuditAgent { @Task({ name: "run", input: Input }) run(_input: Input): unknown { return agentOutput(); } }
    @Module({ agents: [AuditAgent] }) class AppModule {}
    let calls = 0;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
      complete(request) { calls += 1; return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "ok") }); },
    }, { timeoutMs: 5, taskSchemaValidator: { validate: async () => { await Bun.sleep(15); return { isValid: true, errors: [] }; } } });
    try {
      const timed = await runtime.invokeTask("audit03-agent", "run", { value: "x" });
      expect(timed.error?.code).toBe("AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT");
      expect(calls).toBe(0);
      const allowed = await runtime.invokeTask("audit03-agent", "run", { value: "x" }, { timeoutMs: 0 });
      expect(allowed.status).toBe("completed");
      expect(calls).toBe(1);
    } finally { await container.dispose(); }
  });

  test("AUD05 contains hostile provider thrown values as redacted runtime failures", async () => {
    const hostile = [Object.create(null), { toString() { throw new Error("secret-hostile"); } }];
    for (const thrown of hostile) {
      const provider = { complete() { throw thrown; } } as AgentModelProvider;
      const { runtime, container } = createRuntime(provider as ScriptedModelProvider);
      try {
        const result = await runtime.invoke(CATALOG_AGENT, { input: "x" });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
        expect(result.error?.message).not.toContain("secret-hostile");
      } finally { await container.dispose(); }
    }
  });

  test("AUD03 applies default and zero timeout semantics to invokeTask output validation", async () => {
    class Input { value = ""; }
    class Output { value = ""; }
    @Agent({ name: "audit03-output-agent" })
    class AuditAgent { @Task({ name: "run", input: Input, output: Output }) run(_input: Input): unknown { return agentOutput(); } }
    @Module({ agents: [AuditAgent] }) class AppModule {}
    const makeRuntime = (timeoutMs: number) => {
      let calls = 0;
      const container = createContainer(AppModule);
      const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
        complete(request) { calls += 1; return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"value":"ok"}') }); },
      }, { timeoutMs: 5, taskSchemaValidator: { validate: async () => { if (calls > 0) await Bun.sleep(15); return { isValid: true, errors: [] }; } } });
      return { runtime, container, calls: () => calls, timeoutMs };
    };
    const bounded = makeRuntime(5);
    try {
      const result = await bounded.runtime.invokeTask("audit03-output-agent", "run", { value: "x" });
      expect(result.error?.code).toBe("AGENT_TASK_SCHEMA_VALIDATION_TIMEOUT");
      expect(bounded.calls()).toBe(1);
    } finally { await bounded.container.dispose(); }
    const optOut = makeRuntime(0);
    try {
      const result = await optOut.runtime.invokeTask("audit03-output-agent", "run", { value: "x" }, { timeoutMs: optOut.timeoutMs });
      expect(result.status).toBe("completed");
      expect(optOut.calls()).toBe(1);
    } finally { await optOut.container.dispose(); }
  });

  test("AUD03 pre-aborted and invalid timeout invokeTask paths do not validate or dispatch", async () => {
    class Input { value = ""; }
    @Agent({ name: "audit03-abort-agent" }) class AuditAgent { @Task({ name: "run", input: Input }) run(_input: Input): unknown { return agentOutput(); } }
    @Module({ agents: [AuditAgent] }) class AppModule {}
    let validations = 0; let providerCalls = 0;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), { complete() { providerCalls += 1; throw new Error("must not dispatch"); } }, { taskSchemaValidator: { validate() { validations += 1; return { isValid: true, errors: [] }; } } });
    try {
      const controller = new AbortController(); controller.abort();
      expect((await runtime.invokeTask("audit03-abort-agent", "run", { value: "x" }, { signal: controller.signal })).error?.code).toBe("AGENT_ABORTED");
      expect((await runtime.invokeTask("audit03-abort-agent", "run", { value: "x" }, { timeoutMs: -1 })).error?.code).toBe("AGENT_RUNTIME_OPTIONS_INVALID");
      expect(validations).toBe(0); expect(providerCalls).toBe(0);
    } finally { await container.dispose(); }
  });

  test("AUD04 rejects a mixed raw OpenAI-compatible vendor batch before Tool execution", async () => {
    let effects = 0;
    @Tool({ name: "adapter.valid", description: "valid", sideEffect: "read" }) class ValidTool { execute() { effects += 1; return { ok: true }; } }
    @Agent({ name: "adapter-batch-agent", tools: [ValidTool] }) class BatchAgent {}
    @Module({ agents: [BatchAgent], tools: [ValidTool], providers: [scoped(ValidTool)] }) class AppModule {}
    const provider = openAiCompatibleAdapter({ fetch: async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "valid", type: "function", function: { name: "adapter_valid", arguments: "{}" } }, { id: "bad", type: "unknown" }] } }] }) }).create({ provider: "openai-compatible", model: "test", baseUrl: "https://invalid", apiKey: "secret" }) as AgentModelProvider;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider);
    try {
      const result = await runtime.invoke("adapter-batch-agent", { input: "x" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
      expect(effects).toBe(0);
    } finally { await container.dispose(); }
  });

  test("prepares agent and task inputs before any provider effect in validator order", async () => {
    class AgentInput { value = ""; }
    class TaskInput { value = ""; }
    @Agent({ name: "prepared-agent", input: AgentInput })
    class PreparedAgent {
      @Task({ name: "run", input: TaskInput })
      run(_input: TaskInput): unknown { return agentOutput(); }
    }
    @Module({ agents: [PreparedAgent] }) class AppModule {}
    const validations: string[] = [];
    let providerCalls = 0;
    const container = createContainer(AppModule);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), {
      complete(request) {
        providerCalls += 1;
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") });
      },
    }, {
      taskSchemaValidator: {
        validate(instance) {
          validations.push(instance.constructor.name);
          return { isValid: true, errors: [] };
        },
      },
    });
    try {
      expect((await runtime.invoke("prepared-agent", { input: "not-an-object" })).error?.code).toBe("AGENT_INPUT_INVALID");
      expect(providerCalls).toBe(0);
      expect((await runtime.invokeTask("prepared-agent", "run", { value: "ok" })).status).toBe("completed");
      expect(providerCalls).toBe(1);
      expect(validations).toEqual(["TaskInput", "AgentInput"]);
    } finally { await container.dispose(); }
  });

  test("finalizes Agent output before Task output and skips Task output after agent failure", async () => {
    class AgentOutput { answer = ""; }
    class TaskOutput { answer = ""; }
    @Agent({ name: "finalization-agent", output: AgentOutput })
    class FinalizationAgent {
      @Task({ name: "run", output: TaskOutput })
      run(): unknown { return agentOutput(); }
    }
    @Module({ agents: [FinalizationAgent] }) class AppModule {}
    const validationOrder: string[] = [];
    const container = createContainer(AppModule);
    const registry = AgentRegistry.fromModules([AppModule]);
    const options = {
      taskSchemaValidator: {
        validate(instance: object) {
          validationOrder.push(instance.constructor.name);
          return { isValid: true, errors: [] };
        },
      },
    };
    try {
      const successful = new AgentRuntime(container, registry, {
        complete(request) {
          return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData({ answer: "ok" })) });
        },
      }, options);
      expect((await successful.invokeTask("finalization-agent", "run", {})).status).toBe("completed");
      expect(validationOrder).toEqual(["AgentOutput", "TaskOutput"]);

      validationOrder.length = 0;
      const failing = new AgentRuntime(container, registry, {
        complete() { throw new Error("provider failed"); },
      }, options);
      expect((await failing.invokeTask("finalization-agent", "run", {})).error?.code).toBe("AGENT_PROVIDER_FAILED");
      expect(validationOrder).toEqual([]);
    } finally { await container.dispose(); }
  });

  test("ARCP-DEF-007 rejects deprecated concrete model options before provider dispatch", async () => {
    class CountingProvider implements AgentModelProvider {
      calls = 0;
      complete(): AgentModelResponse { this.calls += 1; throw new Error("must not run"); }
    }
    @Module({ agents: [ProfiledAgent] })
    class AppModule {}
    const provider = new CountingProvider();
    const container = createContainer(AppModule);
    try {
      const constructorResult = await new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider, { model: "deprecated" })
        .invoke("profiled-agent", { input: "x" });
      const invokeResult = await new AgentRuntime(container, AgentRegistry.fromModules([AppModule]), provider)
        .invoke("profiled-agent", { input: "x", model: "deprecated" });
      expect(constructorResult.error?.code).toBe("AGENT_RUNTIME_OPTIONS_INVALID");
      expect(invokeResult.error?.code).toBe("AGENT_RUNTIME_OPTIONS_INVALID");
      expect(provider.calls).toBe(0);
    } finally { await container.dispose(); }
  });
});
