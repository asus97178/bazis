import { describe, expect, test } from "bun:test";
import { createContainer, Module, type BazisModuleRef } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { Infra, llmConnect } from "@/core/infra";
import {
  AgentModelUnavailableError,
  AgentRuntime,
  AgentSetupError,
  Tool,
  agentMessage,
  agentModelResponse,
  agentTool,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentRunEvent,
  type JsonObject,
} from "../index";
import type { Logger } from "@/core/kernel/logging/Logger";

type Reply = (request: AgentModelRequest, context: AgentModelProviderContext) => AgentModelResponse | Promise<AgentModelResponse>;

class ScriptedModel implements AgentModelProvider {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly replies: readonly Reply[]) {}

  complete(request: AgentModelRequest, context: AgentModelProviderContext): AgentModelResponse | Promise<AgentModelResponse> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (reply === undefined) throw new Error(`The model was called ${this.requests.length} times; the script has ${this.replies.length} replies.`);
    return reply(request, context);
  }
}

const say = (value: string): Reply => (request, context) => {
  context.onTextDelta?.(value);
  return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", value), usage: { inputTokens: 10, outputTokens: 5 } });
};

const call = (...items: readonly { readonly id: string; readonly name: string; readonly input?: JsonObject }[]): Reply =>
  (request) => agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: items.map((item) => agentToolCall(item)) });

function quiet(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, debug() {}, info() {}, warn(message) { warnings.push(message); }, error() {} };
}

@Tool({ callers: ["agent"], name: "orders.find", description: "Finds an order.", sideEffect: "read" })
class FindOrderTool {
  execute(input: JsonObject): JsonObject {
    return { id: input.id ?? null, status: "paid" };
  }
}

const support = { name: "support", instructions: "Answer about orders.", toolNames: ["orders.find"] };

describe("agent run events", () => {
  @Module({ tools: [FindOrderTool] })
  class OrdersModule {}

  test("tells an observer what happens, in order, and ends with the result", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.find", input: { id: 42 } }), say("Order 42 is paid.")]);
    const container = createContainer(OrdersModule);
    const runtime = new AgentRuntime(container, model);
    try {
      const events: AgentRunEvent[] = [];
      const result = await runtime.run(support, { id: "inv-1", input: "Where is order 42?", onEvent: (event) => events.push(event) });

      expect(events.map((event) => event.kind)).toEqual([
        "step-started", "model-answered", "tool-started", "tool-finished",
        "step-started", "text-delta", "model-answered", "finished",
      ]);
      expect(events.every((event) => event.invocationId === "inv-1")).toBe(true);
      expect(events[1]).toMatchObject({ kind: "model-answered", step: 1, finishReason: "tool-calls", toolCalls: [{ id: "c1", name: "orders.find" }] });
      expect(events[2]).toMatchObject({ kind: "tool-started", step: 1, call: { id: "c1", input: { id: 42 } } });
      expect(events[3]).toMatchObject({ kind: "tool-finished", step: 1, result: { callId: "c1", status: "success", output: { id: 42, status: "paid" } } });
      expect(events[5]).toEqual({ kind: "text-delta", invocationId: "inv-1", step: 2, text: "Order 42 is paid." });
      expect(events[6]).toMatchObject({ kind: "model-answered", step: 2, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } });
      const last = events.at(-1)!;
      expect(last.kind === "finished" ? last.result : undefined).toBe(result);
    } finally { await container.dispose(); }
  });

  test("reports a repeated model request and a compaction", async () => {
    const filler = "The order was packed, shipped and delivered to the customer without any problem at all. ".repeat(2);
    const history = Array.from({ length: 20 }, (_unused, index) => [agentMessage("user", `Question ${index}: ${filler}`), agentMessage("assistant", `Answer ${index}: ${filler}`)]).flat();
    const model: AgentModelProvider = {
      calls: 0,
      complete(request: AgentModelRequest) {
        if (request.metadata.purpose === "compaction") return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "SUMMARY") });
        this.calls += 1;
        if (this.calls === 1) throw new AgentModelUnavailableError("HTTP 503.");
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done.") });
      },
    } as AgentModelProvider & { calls: number };
    const container = createContainer({});
    const runtime = new AgentRuntime(container, model, { logger: quiet(), modelRetry: { delayMs: 1 }, compaction: { maxTokens: 600, keepTokens: 150 } });
    try {
      const events: AgentRunEvent[] = [];
      await runtime.run({ name: "support", instructions: "" }, { messages: [...history, agentMessage("user", "And now?")], onEvent: (event) => events.push(event) });
      expect(events.map((event) => event.kind)).toEqual(["compacted", "step-started", "model-retry", "model-answered", "finished"]);
      expect(events[0]).toMatchObject({ kind: "compacted", reason: "size" });
      expect(events[2]).toMatchObject({ kind: "model-retry", step: 1, attempt: 1, maxAttempts: 3, delayMs: 1 });
    } finally { await container.dispose(); }
  });

  test("an observer that throws is logged and does not stop the run", async () => {
    const logger = quiet();
    const container = createContainer({});
    const runtime = new AgentRuntime(container, new ScriptedModel([say("Done.")]), { logger });
    try {
      const result = await runtime.run({ name: "support", instructions: "" }, { input: "Go", onEvent: () => { throw new Error("observer bug"); } });
      expect(result.status).toBe("completed");
      expect(logger.warnings).toContain("Agent event observer failed");
    } finally { await container.dispose(); }
  });

  test("stream gives the same events as they happen and ends with finished", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.find", input: { id: 42 } }), say("Order 42 is paid.")]);
    const container = createContainer(OrdersModule);
    const runtime = new AgentRuntime(container, model);
    try {
      const kinds: string[] = [];
      let written = "";
      for await (const event of runtime.stream(support, { input: "Where is order 42?" })) {
        kinds.push(event.kind);
        if (event.kind === "text-delta") written += event.text;
        if (event.kind === "finished") expect(event.result.status).toBe("completed");
      }
      expect(kinds).toEqual(["step-started", "model-answered", "tool-started", "tool-finished", "step-started", "text-delta", "model-answered", "finished"]);
      expect(written).toBe("Order 42 is paid.");
    } finally { await container.dispose(); }
  });

  test("leaving the stream early cancels the run; a definition that cannot run rejects", async () => {
    let cancelled = false;
    const hanging: AgentModelProvider = {
      complete: (_request, context) => new Promise<AgentModelResponse>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
      }),
    };
    const container = createContainer({});
    const runtime = new AgentRuntime(container, hanging, { logger: quiet() });
    try {
      for await (const event of runtime.stream({ name: "support", instructions: "" }, { input: "Go" })) {
        expect(event.kind).toBe("step-started");
        break;
      }
      expect(cancelled).toBe(true);

      const broken = runtime.stream({ name: "support", instructions: "", toolNames: ["no.such.tool"] }, { input: "Go" });
      await expect((async () => { for await (const _event of broken) { /* nothing */ } })()).rejects.toThrow(AgentSetupError);
    } finally { await container.dispose(); }
  });
});

const llmConfig = defineConfig("llm", { default: { provider: "test", model: "test-model", baseUrl: "https://llm.internal", apiKey: secret("test-key") } });

/** The application as it is built for real: the LLM connector registers AgentRuntime, which an agent Tool resolves. */
function appWith(model: AgentModelProvider, root: BazisModuleRef) {
  @Infra({ llm: llmConnect(llmConfig, { create: () => model }) })
  class AppInfra {}

  @Module({ imports: [AppInfra, root] })
  class AppModule {}

  const container = createContainer(AppModule);
  return { container, runtime: container.resolve(AgentRuntime) };
}

describe("an agent as a Tool of another agent", () => {
  const researcher = { name: "researcher", instructions: "Find facts about orders.", toolNames: ["orders.find"] };
  const research = agentTool({ name: "research.orders", description: "Looks up facts about orders. Give it the full question.", agent: researcher });

  @Module({ tools: [FindOrderTool, research] })
  class SupportModule {}

  const lead = { name: "lead", instructions: "Answer the customer. Hand research to the researcher.", toolNames: ["research.orders"] };

  /** One model for both agents: it answers by what the system message says. */
  function teamModel(): AgentModelProvider & { readonly seen: { agent: string; depth: unknown; parent: unknown; messages: number }[] } {
    const seen: { agent: string; depth: unknown; parent: unknown; messages: number }[] = [];
    const steps = new Map<string, number>();
    return {
      seen,
      complete(request, context) {
        seen.push({ agent: context.agentName, depth: context.metadata.agentDepth, parent: context.metadata.parentInvocationId, messages: request.messages.length });
        const step = (steps.get(context.invocationId) ?? 0) + 1;
        steps.set(context.invocationId, step);
        if (context.agentName === "lead") {
          return step === 1
            ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "lead-1", name: "research.orders", input: { task: "Is order 42 paid?" } })] })
            : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Yes, order 42 is paid.") });
        }
        return step === 1
          ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: `r-${context.invocationId}`, name: "orders.find", input: { id: 42 } })] })
          : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Order 42 has the status paid.") });
      },
    };
  }

  test("hands the task to the nested agent and gives the caller only its answer", async () => {
    const model = teamModel();
    const { container, runtime } = appWith(model, SupportModule);
    try {
      const result = await runtime.run(lead, { id: "lead-run", input: "Is my order 42 paid?" });
      expect(result.status).toBe("completed");
      // The caller's dialog holds the question, one Tool call, its answer and the reply: nothing of the researcher's work.
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(result.toolResults[0]).toMatchObject({ name: "research.orders", status: "success", output: { answer: "Order 42 has the status paid." } });
      // The researcher starts from the task alone and knows who called it.
      const first = model.seen.find((entry) => entry.agent === "researcher")!;
      expect(first).toMatchObject({ depth: 1, parent: "lead-run", messages: 2 });
      expect(model.seen.map((entry) => entry.agent)).toEqual(["lead", "researcher", "researcher", "lead"]);
    } finally { await container.dispose(); }
  });

  test("tells the caller's model when the nested agent failed or the task is empty", async () => {
    const failing: AgentModelProvider = {
      calls: 0,
      complete(request: AgentModelRequest, context: AgentModelProviderContext) {
        if (context.agentName === "researcher") throw new Error("HTTP 400.");
        this.calls += 1;
        return this.calls === 1
          ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [
            agentToolCall({ id: "lead-1", name: "research.orders", input: { task: "Is order 42 paid?" } }),
            agentToolCall({ id: "lead-2", name: "research.orders", input: { task: "  " } }),
          ] })
          : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "I could not check.") });
      },
    } as AgentModelProvider & { calls: number };
    const { container, runtime } = appWith(failing, SupportModule);
    try {
      const result = await runtime.run(lead, { input: "Is my order 42 paid?" });
      expect(result.status).toBe("completed");
      expect(result.toolResults[0]?.error).toMatchObject({ message: "Agent \"researcher\" did not finish: HTTP 400.", details: { reason: "agent_failed" } });
      expect(result.toolResults[1]?.error?.message).toBe("The task must be a non-empty string.");
    } finally { await container.dispose(); }
  });

  test("refuses to go deeper than maxDepth, so agents that name each other cannot loop", async () => {
    const echo = { name: "echo", instructions: "Ask yourself again.", toolNames: ["echo.again"] };
    const again = agentTool({ name: "echo.again", description: "Asks the same agent again.", agent: echo, maxDepth: 2 });

    @Module({ tools: [again] })
    class EchoModule {}

    const depths: unknown[] = [];
    const model: AgentModelProvider = {
      complete(request, context) {
        const answered = request.messages.some((message) => message.role === "tool");
        if (!answered) depths.push(context.metadata.agentDepth ?? 0);
        return answered
          ? agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Stopped.") })
          : agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: `call-${depths.length}`, name: "echo.again", input: { task: "again" } })] });
      },
    };
    const { container, runtime } = appWith(model, EchoModule);
    try {
      const result = await runtime.run(echo, { input: "start" });
      expect(result.status).toBe("completed");
      // The run itself, then two nested runs; the third nested run is refused.
      expect(depths).toEqual([0, 1, 2]);
    } finally { await container.dispose(); }
  });
});
