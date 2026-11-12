import { describe, expect, test } from "bun:test";
import { createContainer, Module } from "@/core/di";
import {
  AgentModelContextOverflowError,
  AgentRuntime,
  AgentSetupError,
  Tool,
  agentMessage,
  agentModelResponse,
  agentReasoning,
  agentText,
  agentToolCall,
  agentToolCallPart,
  agentToolResult,
  agentToolResultPart,
  type AgentMessage,
  type AgentModelProvider,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentRuntimeOptions,
  type JsonObject,
} from "../index";
import type { Logger } from "@/core/kernel/logging/Logger";
import { agentDefinition } from "./agentDefinition.fixture";

const isSummaryRequest = (request: AgentModelRequest): boolean => request.metadata.purpose === "compaction";

function textOf(message: AgentMessage | undefined): string {
  return (message?.content ?? []).map((part) => part.kind === "text" ? part.text : "").join("");
}

/** A model that writes "SUMMARY" when asked for one and answers "Done." otherwise. */
class Model implements AgentModelProvider {
  readonly requests: AgentModelRequest[] = [];
  readonly summaries: AgentModelRequest[] = [];
  window: number | undefined;
  /** How many of the first answer requests are refused as too long. */
  refusals = 0;
  summary: (request: AgentModelRequest) => AgentModelResponse = (request) =>
    agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "SUMMARY"), usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
  answer: (request: AgentModelRequest) => AgentModelResponse = (request) =>
    agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done."), usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } });

  complete(request: AgentModelRequest): AgentModelResponse {
    if (isSummaryRequest(request)) {
      this.summaries.push(request);
      return this.summary(request);
    }
    this.requests.push(request);
    if (this.refusals > 0) {
      this.refusals -= 1;
      throw new AgentModelContextOverflowError("The request does not fit the model's context window.");
    }
    return this.answer(request);
  }

  contextTokens(): number | undefined {
    return this.window;
  }
}

function logs(): Logger & { readonly lines: { readonly level: string; readonly message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => { lines.push({ level, message }); };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const support = { name: "support", instructions: "Answer about orders." };

/** Twenty questions and answers of about fifty tokens each, then a new question. */
function longDialog(): AgentMessage[] {
  const filler = "The order was packed, shipped and delivered to the customer without any problem at all. ".repeat(2);
  const dialog: AgentMessage[] = [];
  for (let index = 1; index <= 20; index += 1) {
    dialog.push(agentMessage("user", `Question ${index}: ${filler}`), agentMessage("assistant", `Answer ${index}: ${filler}`));
  }
  dialog.push(agentMessage("user", "And where is order 42 now?"));
  return dialog;
}

function runtimeOf(model: AgentModelProvider, options: AgentRuntimeOptions = {}) {
  const container = createContainer({});
  return { runtime: new AgentRuntime(container, model, options), dispose: () => container.dispose() };
}

describe("agent dialog compaction", () => {
  test("replaces the older part of a dialog above maxTokens with a summary and keeps the newest messages", async () => {
    const model = new Model();
    const logger = logs();
    const { runtime, dispose } = runtimeOf(model, { logger, compaction: { maxTokens: 600, keepTokens: 150 } });
    try {
      const dialog = longDialog();
      const result = await runtime.run(support, { messages: dialog });

      expect(result.status).toBe("completed");
      // A summary is not a step of the agent.
      expect(result.steps).toBe(1);
      expect(result.compactions).toBe(1);
      expect(model.summaries).toHaveLength(1);

      // The model that writes the summary gets the old messages as plain text.
      const asked = model.summaries[0]!;
      expect(asked.tools).toEqual([]);
      expect(asked.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(textOf(asked.messages[1])).toContain("User: Question 1:");
      expect(textOf(asked.messages[1])).not.toContain("And where is order 42 now?");

      // The agent's model gets the instructions, the summary and the newest messages.
      const sent = model.requests[0]!.messages;
      expect(sent[0]?.role).toBe("system");
      expect(textOf(sent[1])).toContain("Summary of the earlier part of this conversation");
      expect(textOf(sent[1])).toContain("SUMMARY");
      expect(sent[1]?.metadata.runtime).toBe("summary");
      expect(textOf(sent.at(-1))).toBe("And where is order 42 now?");
      expect(sent.length).toBeLessThan(dialog.length);

      // The dialog the application stores starts with the summary now.
      expect(result.messages[0]?.metadata).toMatchObject({ runtime: "summary" });
      expect(textOf(result.messages.at(-1))).toBe("Done.");
      expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 15, totalTokens: 165 });
      expect(logger.lines).toContainEqual({ level: "info", message: "Agent context compacted" });
    } finally { await dispose(); }
  });

  test("leaves a dialog below maxTokens as written", async () => {
    const model = new Model();
    const { runtime, dispose } = runtimeOf(model, { compaction: { maxTokens: 100_000 } });
    try {
      const result = await runtime.run(support, { messages: longDialog() });
      expect(result.compactions).toBeUndefined();
      expect(model.summaries).toHaveLength(0);
      expect(result.messages).toHaveLength(42);
    } finally { await dispose(); }
  });

  test("starts at 80% of the model's window when the provider states it", async () => {
    const model = new Model();
    model.window = 1_000;
    const { runtime, dispose } = runtimeOf(model);
    try {
      expect((await runtime.run(support, { messages: longDialog() })).compactions).toBe(1);
      model.window = 100_000;
      expect((await runtime.run(support, { messages: longDialog() })).compactions).toBeUndefined();
    } finally { await dispose(); }
  });

  test("compacts and asks again when the provider refuses the request as too long", async () => {
    const model = new Model();
    model.refusals = 1;
    const { runtime, dispose } = runtimeOf(model, { logger: logs() });
    try {
      const result = await runtime.run(support, { messages: longDialog() });
      expect(result.status).toBe("completed");
      expect(result.steps).toBe(1);
      expect(result.compactions).toBe(1);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]!.messages.length).toBeLessThan(model.requests[0]!.messages.length);
    } finally { await dispose(); }
  });

  test("fails with AGENT_CONTEXT_OVERFLOW when the compacted dialog is refused too, or compaction is off", async () => {
    const twice = new Model();
    twice.refusals = 2;
    const first = runtimeOf(twice, { logger: logs() });
    try {
      const result = await first.runtime.run(support, { messages: longDialog() });
      expect(result.error?.code).toBe("AGENT_CONTEXT_OVERFLOW");
      expect(twice.summaries).toHaveLength(1);
    } finally { await first.dispose(); }

    const off = new Model();
    off.refusals = 1;
    const second = runtimeOf(off, { logger: logs(), compaction: false });
    try {
      const result = await second.runtime.run(support, { messages: longDialog() });
      expect(result.error?.code).toBe("AGENT_CONTEXT_OVERFLOW");
      expect(off.summaries).toHaveLength(0);
    } finally { await second.dispose(); }
  });

  test("a run may keep its dialog as written", async () => {
    const model = new Model();
    const { runtime, dispose } = runtimeOf(model, { compaction: { maxTokens: 600 } });
    try {
      const result = await runtime.run(support, { messages: longDialog(), compaction: false });
      expect(result.compactions).toBeUndefined();
      expect(result.messages).toHaveLength(42);
    } finally { await dispose(); }
  });

  test("goes on with the whole dialog when the summary fails", async () => {
    const model = new Model();
    model.summary = () => { throw new Error("HTTP 400."); };
    const logger = logs();
    const { runtime, dispose } = runtimeOf(model, { logger, compaction: { maxTokens: 600 } });
    try {
      const result = await runtime.run(support, { messages: longDialog() });
      expect(result.status).toBe("completed");
      expect(result.compactions).toBeUndefined();
      expect(model.requests[0]!.messages).toHaveLength(42);
      expect(logger.lines).toContainEqual({ level: "warn", message: "Agent context was not compacted" });
    } finally { await dispose(); }
  });

  test("never separates a Tool call from its results", async () => {
    let executed = 0;

    @Tool({ callers: ["agent"], name: "orders.find", description: "Finds an order.", sideEffect: "read" })
    class FindOrderTool {
      execute(): JsonObject {
        executed += 1;
        return { id: 42, status: "paid" };
      }
    }

    @Module({ tools: [FindOrderTool] })
    class OrdersModule {}

    const model = new Model();
    model.answer = (request) => model.requests.length === 1
      ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "new-call", name: "orders.find", input: { id: 42 } })] })
      : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done.") });
    const container = createContainer(OrdersModule);
    const runtime = new AgentRuntime(container, model, { compaction: { maxTokens: 120, keepTokens: 1 } });
    try {
      const history = [
        agentMessage("user", "Find order 7. ".repeat(20)),
        agentMessage("assistant", [agentToolCallPart(agentToolCall({ id: "old-call", name: "orders.find", input: { id: 7 } }))]),
        agentMessage("tool", agentToolResultPart(agentToolResult({ callId: "old-call", name: "orders.find", output: { id: 7, note: "delivered ".repeat(40) } })), { toolCallId: "old-call" }),
        agentMessage("assistant", "Order 7 is delivered. ".repeat(10)),
        agentMessage("user", "And order 42?"),
      ];
      const result = await runtime.run(agentDefinition({ name: "orders", tools: [FindOrderTool] }), { messages: history });
      expect(result.status).toBe("completed");
      expect(executed).toBe(1);
      expect(result.compactions).toBeGreaterThanOrEqual(1);
      // Every request the model got is a valid dialog: a result always follows its call.
      for (const request of model.requests) {
        const pending = new Set<string>();
        for (const message of request.messages) {
          if (message.role === "tool") expect(pending.delete(message.toolCallId!)).toBe(true);
          else {
            expect(pending.size).toBe(0);
            for (const part of message.content) if (part.kind === "tool-call") pending.add(part.call.id);
          }
        }
        expect(pending.size).toBe(0);
      }
    } finally { await container.dispose(); }
  });

  test("drops reasoning from the kept messages: it was written with the whole dialog in view", async () => {
    const model = new Model();
    const { runtime, dispose } = runtimeOf(model, { compaction: { maxTokens: 600, keepTokens: 150 } });
    try {
      const dialog = longDialog();
      // The last answer before the new question carries the model's reasoning.
      dialog[dialog.length - 2] = agentMessage("assistant", [agentReasoning("Order 20 was delivered, so…", { data: { signature: "sig-20" } }), agentText("Answer 20: delivered.")]);
      const result = await runtime.run(support, { messages: dialog });
      expect(result.compactions).toBe(1);
      const kept = model.requests[0]!.messages.find((message) => textOf(message) === "Answer 20: delivered.");
      expect(kept?.content).toEqual([{ kind: "text", text: "Answer 20: delivered." }]);
      expect(model.requests[0]!.messages.some((message) => message.content.some((part) => part.kind === "reasoning"))).toBe(false);
    } finally { await dispose(); }
  });

  test("learns from the provider's usage how many real tokens an estimated one is", async () => {
    const model = new Model();
    // The provider counts five times more tokens than the estimate says.
    model.answer = (request) => {
      const counted = (request.metadata.agentContext as JsonObject).tokenCount as number;
      const scale = ((request.metadata.agentContext as JsonObject).tokenScale as number | undefined) ?? 1;
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done."), usage: { inputTokens: Math.round(counted / scale * 5) } });
    };
    const { runtime, dispose } = runtimeOf(model);
    try {
      await runtime.run(support, { input: "Where is order 42?" });
      expect((model.requests[0]!.metadata.agentContext as JsonObject).tokenScale).toBeUndefined();
      await runtime.run(support, { input: "Where is order 42?" });
      expect((model.requests[1]!.metadata.agentContext as JsonObject).tokenScale).toBe(5);
      // The same text now counts five times more against maxTokens.
      const first = (model.requests[0]!.metadata.agentContext as JsonObject).tokenCount as number;
      const second = (model.requests[1]!.metadata.agentContext as JsonObject).tokenCount as number;
      expect(second).toBeGreaterThanOrEqual(first * 4);
    } finally { await dispose(); }
  });

  test("rejects wrong compaction settings when the runtime is built", () => {
    const container = createContainer({});
    try {
      expect(() => new AgentRuntime(container, new Model(), { compaction: { maxTokens: 0 } })).toThrow(/compaction\.maxTokens/);
      const routed = Object.assign(new Model(), { modelProfiles: () => ["fast"] });
      expect(() => new AgentRuntime(container, routed, { compaction: { modelProfile: "cheap" } })).toThrow(AgentSetupError);
    } finally { void container.dispose(); }
  });
});
