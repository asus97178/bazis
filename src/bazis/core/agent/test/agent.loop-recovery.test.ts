import { describe, expect, test } from "bun:test";
import { createContainer, Module } from "@/core/di";
import {
  AgentModelUnavailableError,
  AgentRuntime,
  Tool,
  agentJsonSchema,
  agentMessage,
  agentModelResponse,
  agentOutputContract,
  agentReasoning,
  agentText,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentRuntimeOptions,
  type JsonObject,
} from "../index";
import type { Logger } from "@/core/kernel/logging/Logger";
import { agentDefinition } from "./agentDefinition.fixture";
import { withToolExecution } from "./toolExecution.fixture";

type Reply = (request: AgentModelRequest, context: AgentModelProviderContext) => AgentModelResponse | Promise<AgentModelResponse>;

/** A model that answers request N with reply N. */
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

const text = (value: string, finishReason: "stop" | "length" = "stop"): Reply =>
  (request) => agentModelResponse({ invocationId: request.invocationId, finishReason, message: agentMessage("assistant", value), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });

const calls = (...items: readonly { readonly id: string; readonly name: string; readonly input?: JsonObject; readonly inputError?: string }[]): Reply =>
  (request) => agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: items.map((item) => agentToolCall(item)) });

function lastText(request: AgentModelRequest | undefined): string {
  const part = request?.messages[request.messages.length - 1]?.content[0];
  return part?.kind === "text" ? part.text : "";
}

function quietLogger(): Logger & { readonly warnings: string[]; readonly errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return { warnings, errors, debug() {}, info() {}, warn(message) { warnings.push(message); }, error(message) { errors.push(message); } };
}

const plainAgent = { name: "writer", instructions: "Write." };

function runtimeOf(model: AgentModelProvider, options: AgentRuntimeOptions = {}): { readonly runtime: AgentRuntime; dispose(): Promise<void> } {
  const container = createContainer({});
  return { runtime: new AgentRuntime(container, model, options), dispose: () => container.dispose() };
}

describe("agent loop recovery", () => {
  describe("a model request the provider cannot serve right now", () => {
    test("is repeated, and the run completes", async () => {
      const logger = quietLogger();
      const model = new ScriptedModel([
        () => { throw new AgentModelUnavailableError("HTTP 429."); },
        () => { throw new AgentModelUnavailableError("HTTP 503."); },
        text("Done."),
      ]);
      const { runtime, dispose } = runtimeOf(model, { logger, modelRetry: { delayMs: 1 } });
      try {
        const result = await runtime.run(plainAgent, { input: "Go" });
        expect(result.status).toBe("completed");
        // Repeats are one step: the model answered once.
        expect(result.steps).toBe(1);
        expect(model.requests).toHaveLength(3);
        expect(logger.warnings).toEqual(["Agent model call failed, repeating", "Agent model call failed, repeating"]);
        expect(logger.errors).toEqual([]);
      } finally { await dispose(); }
    });

    test("fails the run after maxAttempts", async () => {
      const logger = quietLogger();
      const model = new ScriptedModel([() => { throw new AgentModelUnavailableError("HTTP 503."); }, () => { throw new AgentModelUnavailableError("HTTP 503."); }]);
      const { runtime, dispose } = runtimeOf(model, { logger, modelRetry: { maxAttempts: 2, delayMs: 1 } });
      try {
        const result = await runtime.run(plainAgent, { input: "Go" });
        expect(result.error).toMatchObject({ code: "AGENT_PROVIDER_FAILED", message: "HTTP 503." });
        expect(model.requests).toHaveLength(2);
        expect(logger.errors).toEqual(["Agent model call failed"]);
      } finally { await dispose(); }
    });

    test("waits as long as the provider asked, but not longer than maxDelayMs", async () => {
      const model = new ScriptedModel([() => { throw new AgentModelUnavailableError("HTTP 429.", { retryAfterMs: 60_000 }); }, text("Done.")]);
      const { runtime, dispose } = runtimeOf(model, { logger: quietLogger(), modelRetry: { delayMs: 1, maxDelayMs: 30 } });
      try {
        const startedAt = Date.now();
        const result = await runtime.run(plainAgent, { input: "Go" });
        const waited = Date.now() - startedAt;
        expect(result.status).toBe("completed");
        expect(waited).toBeGreaterThanOrEqual(25);
        expect(waited).toBeLessThan(5_000);
      } finally { await dispose(); }
    });

    test("is not repeated for another error, or after text reached the caller", async () => {
      const other = new ScriptedModel([() => { throw new Error("HTTP 400."); }]);
      const first = runtimeOf(other, { logger: quietLogger(), modelRetry: { delayMs: 1 } });
      try {
        expect((await first.runtime.run(plainAgent, { input: "Go" })).error?.code).toBe("AGENT_PROVIDER_FAILED");
        expect(other.requests).toHaveLength(1);
      } finally { await first.dispose(); }

      const shown: string[] = [];
      const streaming = new ScriptedModel([(_request, context) => { context.onTextDelta?.("Half an ans"); throw new AgentModelUnavailableError("The connection broke."); }]);
      const second = runtimeOf(streaming, { logger: quietLogger(), modelRetry: { delayMs: 1 } });
      try {
        const result = await second.runtime.run(plainAgent, { input: "Go", onTextDelta: (event) => shown.push(event.text) });
        expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
        expect(streaming.requests).toHaveLength(1);
        expect(shown).toEqual(["Half an ans"]);
      } finally { await second.dispose(); }
    });

    test("stops waiting when the run is cancelled", async () => {
      const model = new ScriptedModel([() => { throw new AgentModelUnavailableError("HTTP 429."); }]);
      const { runtime, dispose } = runtimeOf(model, { logger: quietLogger(), modelRetry: { delayMs: 10_000, maxDelayMs: 10_000 } });
      try {
        const cancel = new AbortController();
        setTimeout(() => cancel.abort(), 10);
        const result = await runtime.run(plainAgent, { input: "Go", signal: cancel.signal });
        expect(result.error?.code).toBe("AGENT_ABORTED");
        expect(model.requests).toHaveLength(1);
      } finally { await dispose(); }
    });
  });

  describe("an answer cut off by the output limit", () => {
    test("is continued and returned as one message", async () => {
      const model = new ScriptedModel([text("The report starts he", "length"), text("re and goes o", "length"), text("n to the end.")]);
      const { runtime, dispose } = runtimeOf(model);
      try {
        const result = await runtime.run(plainAgent, { input: "Write the report" });
        expect(result.status).toBe("completed");
        expect(result.steps).toBe(3);
        expect(result.finalMessage?.content).toEqual([{ kind: "text", text: "The report starts here and goes on to the end." }]);
        // The dialog keeps the question and one answer: no pieces, no runtime requests.
        expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(result.messages[1]).toEqual(result.finalMessage!);
        // The model saw its own piece and the request to go on.
        expect(model.requests[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(lastText(model.requests[1])).toContain("cut off by the output limit");
        expect(model.requests[1]?.messages.at(-1)?.metadata).toEqual({ runtime: "continue-output" });
        expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
      } finally { await dispose(); }
    });

    test("fails with what was written when the limit of continuations is reached", async () => {
      const model = new ScriptedModel([text("a", "length"), text("b", "length"), text("c", "length")]);
      const { runtime, dispose } = runtimeOf(model, { maxOutputContinuations: 2 });
      try {
        const result = await runtime.run(plainAgent, { input: "Write" });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("AGENT_PROVIDER_STOPPED");
        expect(result.finalMessage?.content).toEqual([{ kind: "text", text: "abc" }]);
        expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      } finally { await dispose(); }
    });

    test("fails at once with maxOutputContinuations: 0", async () => {
      const model = new ScriptedModel([text("a", "length")]);
      const { runtime, dispose } = runtimeOf(model, { maxOutputContinuations: 0 });
      try {
        const result = await runtime.run(plainAgent, { input: "Write" });
        expect(result.error?.code).toBe("AGENT_PROVIDER_STOPPED");
        expect(model.requests).toHaveLength(1);
      } finally { await dispose(); }
    });
  });

  describe("a structured answer that is not accepted", () => {
    const output = agentOutputContract({
      mode: "json",
      schema: agentJsonSchema("Requirements", { type: "object", properties: { goal: { type: "string" } }, required: ["goal"], additionalProperties: false }),
    });

    test("is corrected by the model, and the run completes", async () => {
      const model = new ScriptedModel([text("Here it is: {goal}"), text("{\"goal\":42}"), text("{\"goal\":\"Promo codes work.\"}")]);
      const { runtime, dispose } = runtimeOf(model);
      try {
        const result = await runtime.run(plainAgent, { input: "Checkout", output });
        expect(result.status).toBe("completed");
        expect(result.output).toEqual({ goal: "Promo codes work." });
        expect(result.steps).toBe(3);
        expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(lastText(model.requests[1])).toContain("JSON output is malformed.");
        expect(lastText(model.requests[2])).toContain("Issues:");
        expect(model.requests[2]?.messages.at(-1)?.metadata).toEqual({ runtime: "repair-output" });
      } finally { await dispose(); }
    });

    test("is read past the model's reasoning, which stays in the dialog", async () => {
      const thinking: Reply = (request) => agentModelResponse({
        invocationId: request.invocationId, finishReason: "stop",
        message: agentMessage("assistant", [agentReasoning("The goal is about promo codes.", { data: { signature: "sig" } }), agentText("{\"goal\":\"Promo codes work.\"}")]),
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, reasoningTokens: 20 },
      });
      const model = new ScriptedModel([thinking]);
      const { runtime, dispose } = runtimeOf(model);
      try {
        const result = await runtime.run(plainAgent, { input: "Checkout", output });
        expect(result.status).toBe("completed");
        expect(result.output).toEqual({ goal: "Promo codes work." });
        expect(result.finalMessage?.content[0]).toEqual({ kind: "reasoning", text: "The goal is about promo codes.", data: { signature: "sig" } });
        expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, reasoningTokens: 20 });
      } finally { await dispose(); }
    });

    test("fails after maxOutputRepairs corrections", async () => {
      const model = new ScriptedModel([text("no"), text("no"), text("no")]);
      const { runtime, dispose } = runtimeOf(model);
      try {
        const result = await runtime.run(plainAgent, { input: "Checkout", output });
        expect(result.error).toMatchObject({ code: "AGENT_OUTPUT_INVALID", message: "JSON output is malformed." });
        expect(model.requests).toHaveLength(3);
        expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      } finally { await dispose(); }
    });

    test("never asks beyond maxSteps", async () => {
      const model = new ScriptedModel([text("no"), text("no")]);
      const { runtime, dispose } = runtimeOf(model);
      try {
        const result = await runtime.run(plainAgent, { input: "Checkout", output, maxSteps: 2 });
        expect(result.error?.code).toBe("AGENT_OUTPUT_INVALID");
        expect(result.steps).toBe(2);
      } finally { await dispose(); }
    });
  });

  describe("tool calls", () => {
    let running = 0;
    let peak = 0;
    const order: string[] = [];

    @Tool({ callers: ["agent"], name: "stock.read", description: "Reads the stock.", sideEffect: "read" })
    class ReadStockTool {
      async execute(input: JsonObject): Promise<JsonObject> {
        running += 1;
        peak = Math.max(peak, running);
        // The first call is the slowest: results must still come back in the model's order.
        await Bun.sleep(input.sku === "a" ? 30 : 5);
        running -= 1;
        order.push(`read:${String(input.sku)}`);
        return { sku: input.sku ?? null };
      }
    }

    @Tool({ callers: ["agent"], name: "stock.write", description: "Changes the stock.", sideEffect: "write", approval: "policy" })
    class WriteStockTool {
      async execute(input: JsonObject): Promise<JsonObject> {
        running += 1;
        peak = Math.max(peak, running);
        await Bun.sleep(5);
        running -= 1;
        order.push(`write:${String(input.sku)}`);
        return { ok: true };
      }
    }

    @Module({ tools: [ReadStockTool, WriteStockTool] })
    class StockModule {}

    const stockAgent = agentDefinition({ name: "stock", tools: [ReadStockTool, WriteStockTool] });

    function stockRuntime(model: AgentModelProvider, options: AgentRuntimeOptions = {}) {
      const container = createContainer(withToolExecution(StockModule, { approvalPolicy: () => true, auditSink: () => undefined }));
      return { runtime: new AgentRuntime(container, model, options), dispose: () => container.dispose() };
    }

    test("that only read run together, and their results keep the model's order", async () => {
      running = 0; peak = 0; order.length = 0;
      const model = new ScriptedModel([
        calls({ id: "1", name: "stock.read", input: { sku: "a" } }, { id: "2", name: "stock.read", input: { sku: "b" } }, { id: "3", name: "stock.read", input: { sku: "c" } }),
        text("Done."),
      ]);
      const { runtime, dispose } = stockRuntime(model);
      try {
        const result = await runtime.run(stockAgent, { input: "Check" });
        expect(result.status).toBe("completed");
        expect(peak).toBe(3);
        expect(order[2]).toBe("read:a");
        expect(result.toolResults.map((item) => item.callId)).toEqual(["1", "2", "3"]);
        expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["1", "2", "3"]);
      } finally { await dispose(); }
    });

    test("that write run alone, in the model's order", async () => {
      running = 0; peak = 0; order.length = 0;
      const model = new ScriptedModel([
        calls({ id: "1", name: "stock.read", input: { sku: "a" } }, { id: "2", name: "stock.write", input: { sku: "a" } }, { id: "3", name: "stock.read", input: { sku: "b" } }, { id: "4", name: "stock.read", input: { sku: "c" } }),
        text("Done."),
      ]);
      const { runtime, dispose } = stockRuntime(model);
      try {
        const result = await runtime.run(stockAgent, { input: "Move" });
        expect(result.status).toBe("completed");
        expect(order.slice(0, 2)).toEqual(["read:a", "write:a"]);
        expect(peak).toBe(2);
        expect(result.toolResults.map((item) => item.callId)).toEqual(["1", "2", "3", "4"]);
      } finally { await dispose(); }
    });

    test("run one by one with maxParallelToolCalls: 1", async () => {
      running = 0; peak = 0; order.length = 0;
      const model = new ScriptedModel([
        calls({ id: "1", name: "stock.read", input: { sku: "a" } }, { id: "2", name: "stock.read", input: { sku: "b" } }),
        text("Done."),
      ]);
      const { runtime, dispose } = stockRuntime(model, { maxParallelToolCalls: 1 });
      try {
        await runtime.run(stockAgent, { input: "Check" });
        expect(peak).toBe(1);
        expect(order).toEqual(["read:a", "read:b"]);
      } finally { await dispose(); }
    });

    test("with arguments the provider could not read are not run, and the model hears why", async () => {
      running = 0; peak = 0; order.length = 0;
      const model = new ScriptedModel([
        calls({ id: "1", name: "stock.write", inputError: "Unexpected end of JSON input" }),
        calls({ id: "2", name: "stock.write", input: { sku: "a" } }),
        text("Done."),
      ]);
      const { runtime, dispose } = stockRuntime(model);
      try {
        const result = await runtime.run(stockAgent, { input: "Move" });
        expect(result.status).toBe("completed");
        expect(order).toEqual(["write:a"]);
        expect(result.toolResults[0]).toMatchObject({ callId: "1", status: "error", error: { code: "TOOL_ARGUMENTS_INVALID" } });
        expect(result.toolResults[0]?.error?.message).toContain("Unexpected end of JSON input");
        expect(result.toolResults[1]).toMatchObject({ callId: "2", status: "success" });
      } finally { await dispose(); }
    });
  });

  test("thirty steps are allowed by default, and the thirty-first is not asked", async () => {
    const model = new ScriptedModel(Array.from({ length: 30 }, (_unused, index) => text(`piece ${index}`, "length")));
    // Continuations are steps: with no other limit in the way the default one stops the run.
    const { runtime, dispose } = runtimeOf(model, { maxOutputContinuations: 100 });
    try {
      const result = await runtime.run(plainAgent, { input: "Write" });
      expect(result.steps).toBe(30);
      expect(model.requests).toHaveLength(30);
      expect(result.error?.code).toBe("AGENT_PROVIDER_STOPPED");
    } finally { await dispose(); }
  });

  describe("the run deadline", () => {
    test("stops a run that takes longer than runTimeoutMs", async () => {
      const model = new ScriptedModel([
        (_request, context) => new Promise<AgentModelResponse>((_resolve, reject) => { context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }),
      ]);
      const { runtime, dispose } = runtimeOf(model, { logger: quietLogger() });
      try {
        const result = await runtime.run(plainAgent, { input: "Go", runTimeoutMs: 20 });
        expect(result.status).toBe("failed");
        expect(result.error).toMatchObject({ code: "AGENT_RUN_TIMEOUT", details: { runTimeoutMs: 20 } });
      } finally { await dispose(); }
    });

    test("leaves a caller's cancellation what it is", async () => {
      const model = new ScriptedModel([
        (_request, context) => new Promise<AgentModelResponse>((_resolve, reject) => { context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }),
      ]);
      const { runtime, dispose } = runtimeOf(model, { logger: quietLogger(), runTimeoutMs: 5_000 });
      try {
        const cancel = new AbortController();
        setTimeout(() => cancel.abort(), 10);
        const result = await runtime.run(plainAgent, { input: "Go", signal: cancel.signal });
        expect(result.error?.code).toBe("AGENT_ABORTED");
      } finally { await dispose(); }
    });
  });
});
