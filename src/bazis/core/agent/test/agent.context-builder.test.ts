import { describe, expect, test } from "bun:test";
import {
  DefaultAgentContextBuilder,
  agentMessage,
  agentToolCall,
  agentToolCallPart,
  agentToolResult,
  agentToolResultPart,
} from "../index";
import { AgentRegistry } from "../AgentRegistry";
import { agentDefinition } from "./agentDefinition.fixture";

const ProductDesignerAgent = agentDefinition({
  name: "product-designer",
  description: "Designs enterprise product processes.",
  instructions: [
    "You are a senior product analyst. Turn product ideas into a clear delivery plan.",
    "- Ask for missing business context.",
    "- Do not invent regulatory claims.",
  ].join("\n"),
});

const PlainAgent = agentDefinition({ name: "plain-agent" });

const agents = new Map([ProductDesignerAgent, PlainAgent].map((definition) => [definition.name, AgentRegistry.fromDefinition(definition).requireAgent(definition.name)]));

function agentNamed(name: string) {
  return agents.get(name)!;
}

function textOf(message: ReturnType<typeof agentMessage> | undefined): string {
  const part = message?.content[0];
  return part?.kind === "text" ? part.text : "";
}

describe("agent context builder", () => {
  test("sends the definition's instructions as the system message, as written", () => {
    const agent = agentNamed("product-designer");
    const context = new DefaultAgentContextBuilder().build({
      invocationId: "inv-1",
      agent,
      messages: [agentMessage("user", "Design the checkout")],
      metadata: {},
    });

    expect(context.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(textOf(context.messages[0])).toBe(agent.instructions);
    expect(context.messages[0]?.metadata).toEqual({ agentName: "product-designer" });
    expect(context.trace[0]).toMatchObject({ section: "prompt", role: "system", included: true });
    expect(context.trace[0]?.tokens).toBeGreaterThan(0);
    expect(context.trace[1]).toMatchObject({ section: "conversation[0]", role: "user", included: true });
    expect(context.metadata.messageCount).toBe(2);
    expect(context.metadata.tokenCount).toBeGreaterThan(0);
  });

  test("sends no system message for empty instructions", () => {
    const context = new DefaultAgentContextBuilder().build({
      invocationId: "inv-1",
      agent: agentNamed("plain-agent"),
      messages: [agentMessage("user", "Show the products")],
      metadata: {},
    });
    expect(context.messages.map((message) => message.role)).toEqual(["user"]);
  });

  test("keeps the system prompt and newest conversation messages when maxMessages trims history", () => {
    const agent = agentNamed("product-designer");
    const builder = new DefaultAgentContextBuilder();

    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [
        agentMessage("user", "Old request"),
        agentMessage("assistant", "Old answer"),
        agentMessage("user", "Current request"),
      ],
      metadata: {},
      limits: { maxMessages: 3 },
    });

    expect(context.messages.map((message) => textOf(message))).toEqual([
      textOf(context.messages[0]),
      "Old answer",
      "Current request",
    ]);
    expect(context.messages[0]?.role).toBe("system");
    expect(context.trace.find((entry) => entry.section === "conversation[0]")).toMatchObject({
      included: false,
      reason: "maxMessages",
    });
  });

  test("drops oldest non-protected messages when maxChars trims history", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder();

    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [
        agentMessage("user", "x".repeat(80)),
        agentMessage("assistant", "old"),
        agentMessage("user", "now"),
      ],
      metadata: {},
      limits: { maxChars: 40 },
    });

    expect(context.messages.map((message) => textOf(message))).toEqual(["old", "now"]);
    expect(context.trace.find((entry) => entry.section === "conversation[0]")).toMatchObject({
      included: false,
      reason: "maxChars",
    });
  });

  test("drops oldest non-protected messages when maxTokens trims history", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder();

    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [
        agentMessage("user", "alpha beta gamma delta epsilon zeta eta theta iota kappa"),
        agentMessage("assistant", "short answer"),
        agentMessage("user", "now"),
      ],
      metadata: {},
      limits: { maxTokens: 8 },
    });

    expect(context.messages.map((message) => textOf(message))).toEqual(["short answer", "now"]);
    expect(context.trace.find((entry) => entry.section === "conversation[0]")).toMatchObject({
      included: false,
      reason: "maxTokens",
    });
    expect(context.metadata.tokenCount).toBeLessThanOrEqual(8);
  });

  test("trims an assistant tool call and its result as one protocol unit", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder();
    const call = agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "old" } });
    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [
        agentMessage("user", "Old request"),
        agentMessage("assistant", agentToolCallPart(call)),
        agentMessage("tool", agentToolResultPart(agentToolResult({
          callId: call.id,
          name: call.name,
          output: { count: 1 },
        })), { toolCallId: call.id }),
        agentMessage("user", "Current request"),
      ],
      metadata: {},
      limits: { maxMessages: 2 },
    });

    expect(context.messages.map((message) => message.role)).toEqual(["user"]);
    expect(textOf(context.messages[0])).toBe("Current request");
    expect(context.trace.slice(1, 3).every((entry) => entry.included === false)).toBe(true);
  });

  test("protects the assistant call when the newest message is a tool result", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder();
    const call = agentToolCall({ id: "call-1", name: "catalog.search" });

    expect(() => builder.build({
      invocationId: "inv-1",
      agent,
      messages: [
        agentMessage("assistant", agentToolCallPart(call)),
        agentMessage("tool", agentToolResultPart(agentToolResult({
          callId: call.id,
          name: call.name,
          output: { count: 1 },
        })), { toolCallId: call.id }),
      ],
      metadata: {},
      limits: { maxMessages: 1 },
    })).toThrow(/maxMessages/);
  });

  test("fails when limits would remove protected context", () => {
    const agent = agentNamed("product-designer");
    const builder = new DefaultAgentContextBuilder();

    expect(() =>
      builder.build({
        invocationId: "inv-1",
        agent,
        messages: [agentMessage("user", "Current request")],
        metadata: {},
        limits: { maxMessages: 1 },
      }),
    ).toThrow(/maxMessages/);
  });

  test("fails when maxTokens is too small for protected context", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder();

    expect(() =>
      builder.build({
        invocationId: "inv-1",
        agent,
        messages: [agentMessage("user", "one two three")],
        metadata: {},
        limits: { maxTokens: 1 },
      }),
    ).toThrow(/maxTokens/);
  });

  test("rejects invalid custom token estimates before budget trimming", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder({ tokenEstimator: { estimateMessage: () => Number.NaN } });
    expect(() => builder.build({ invocationId: "inv", agent, messages: [agentMessage("user", "x")], metadata: {}, limits: { maxTokens: 1 } })).toThrow(/invalid estimate/);
  });

  test("applies all budgets in order on a long history and preserves protocol blocks", () => {
    const agent = agentNamed("plain-agent");
    const builder = new DefaultAgentContextBuilder({ tokenEstimator: { estimateMessage: () => 10 } });
    const call = agentToolCall({ id: "latest", name: "catalog.search" });
    const input = {
      invocationId: "large", agent, metadata: {}, messages: [
        ...Array.from({ length: 16_000 }, (_, i) => agentMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(40))),
        agentMessage("assistant", agentToolCallPart(call)),
        agentMessage("tool", agentToolResultPart(agentToolResult({ callId: call.id, name: call.name, output: { found: true } })), { toolCallId: call.id }),
      ],
    };
    const full = builder.build(input);
    const protectedChars = full.trace.slice(-2).reduce((sum, entry) => sum + entry.chars, 0);
    const maxChars = full.trace.slice(-5).reduce((sum, entry) => sum + entry.chars, 0);
    const context = builder.build({ ...input, limits: { maxMessages: 8, maxChars, maxTokens: 20 } });
    expect(context.messages).toEqual(input.messages.slice(-2));
    expect(context.metadata.tokenCount).toBe(20);
    expect(context.metadata.charCount).toBe(protectedChars);
    expect(context.trace.slice(0, 15_994).every((entry) => entry.reason === "maxMessages")).toBe(true);
    expect(context.trace.slice(15_994, 15_997).every((entry) => entry.reason === "maxChars")).toBe(true);
    expect(context.trace.slice(15_997, 16_000).every((entry) => entry.reason === "maxTokens")).toBe(true);
    expect(context.trace.slice(-2).every((entry) => entry.included)).toBe(true);
  });

  test("preserves custom fractional and overflowing token estimates while trimming", () => {
    const agent = agentNamed("plain-agent");
    for (const estimates of [[0.1, 0.2, 1], [1e308, 1e308, 1]]) {
      let index = 0;
      const builder = new DefaultAgentContextBuilder({ tokenEstimator: { estimateMessage: () => estimates[index++]! } });
      const context = builder.build({ invocationId: "custom", agent, metadata: {}, messages: [agentMessage("user", "old"), agentMessage("assistant", "old answer"), agentMessage("user", "current")], limits: { maxTokens: 1 } });
      expect(context.messages.map(textOf)).toEqual(["current"]);
      expect(context.metadata.tokenCount).toBe(1);
    }
  });
});
