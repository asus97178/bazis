import { describe, expect, test } from "bun:test";
import { Module } from "@/core/di";
import {
  Agent,
  AgentRegistry,
  DefaultAgentContextBuilder,
  Prompt,
  agentMessage,
  agentToolCall,
  agentToolCallPart,
  agentToolResult,
  agentToolResultPart,
} from "../index";

@Prompt({
  name: "product.designer.prompt",
  role: "Продуктовый аналитик",
  goal: "Превратить продуктовые идеи в понятный план поставки.",
  instructions: ["Запрашивай недостающий бизнес-контекст.", "Предпочитай явные критерии приемки."],
  constraints: ["Не выдумывай регуляторные утверждения."],
  sections: [
    {
      kind: "developer",
      title: "Правила домена",
      content: ["Сохраняй enterprise-процессы аудируемыми.", "Предпочитай обратимые операции."],
    },
    {
      kind: "tool-policy",
      content: "Используй read-инструменты перед предложением write-действий.",
    },
  ],
})
class ProductDesignerPrompt {}

@Agent({
  name: "product-designer",
  role: "Старший продуктовый аналитик",
  description: "Проектирует enterprise-процессы продукта.",
  prompt: ProductDesignerPrompt,
})
class ProductDesignerAgent {}

@Agent({ name: "plain-agent" })
class PlainAgent {}

@Agent({
  name: "inline-prompt-agent",
  role: "Оператор каталога",
  goal: "Помочь пользователю управлять каталогом товаров.",
  instructions: ["Отвечай кратко.", "Не выдумывай товары и остатки."],
  constraints: ["Используй только данные из tools."],
  sections: [
    {
      kind: "tool-policy",
      content: "Перед ответом по товарам вызови read-инструмент.",
    },
  ],
})
class InlinePromptAgent {}

@Module({
  agents: [ProductDesignerAgent, PlainAgent, InlinePromptAgent],
  prompts: [ProductDesignerPrompt],
})
class AppModule {}

function textOf(message: ReturnType<typeof agentMessage> | undefined): string {
  const part = message?.content[0];
  return part?.kind === "text" ? part.text : "";
}

describe("agent context builder", () => {
  test("renders agent and prompt metadata into a stable system message", () => {
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("product-designer");
    const builder = new DefaultAgentContextBuilder();

    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [agentMessage("user", "Спроектируй оформление заказа")],
      metadata: {},
    });

    expect(context.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(textOf(context.messages[0])).toContain("Role: Старший продуктовый аналитик");
    expect(textOf(context.messages[0])).toContain("Prompt role: Продуктовый аналитик");
    expect(textOf(context.messages[0])).toContain("Goal: Превратить продуктовые идеи в понятный план поставки.");
    expect(textOf(context.messages[0])).toContain("- Предпочитай явные критерии приемки.");
    expect(textOf(context.messages[0])).toContain("- Не выдумывай регуляторные утверждения.");
    expect(textOf(context.messages[0])).toContain("Правила домена:");
    expect(textOf(context.messages[0])).toContain("- Сохраняй enterprise-процессы аудируемыми.");
    expect(textOf(context.messages[0])).toContain("Tool policy:");
    expect(textOf(context.messages[0])).toContain("Используй read-инструменты перед предложением write-действий.");
    expect(context.trace[0]).toMatchObject({ section: "prompt", role: "system", included: true });
    expect(context.trace[0]?.tokens).toBeGreaterThan(0);
    expect(context.trace[1]).toMatchObject({ section: "conversation[0]", role: "user", included: true });
    expect(context.metadata.messageCount).toBe(2);
    expect(context.metadata.tokenCount).toBeGreaterThan(0);
  });

  test("renders inline agent prompt metadata without a prompt class", () => {
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("inline-prompt-agent");
    const builder = new DefaultAgentContextBuilder();

    const context = builder.build({
      invocationId: "inv-1",
      agent,
      messages: [agentMessage("user", "Покажи товары")],
      metadata: {},
    });

    const system = textOf(context.messages[0]);
    expect(context.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(system).toContain("Role: Оператор каталога");
    expect(system).toContain("Goal: Помочь пользователю управлять каталогом товаров.");
    expect(system).toContain("- Отвечай кратко.");
    expect(system).toContain("- Используй только данные из tools.");
    expect(system).toContain("Tool policy:");
    expect(system).toContain("Перед ответом по товарам вызови read-инструмент.");
    expect(agent.prompt).toBeUndefined();
  });

  test("keeps the system prompt and newest conversation messages when maxMessages trims history", () => {
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("product-designer");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("plain-agent");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("plain-agent");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("plain-agent");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("plain-agent");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("product-designer");
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
    const registry = AgentRegistry.fromModules([AppModule]);
    const agent = registry.requireAgent("plain-agent");
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
    const agent = AgentRegistry.fromModules([AppModule]).requireAgent("plain-agent");
    const builder = new DefaultAgentContextBuilder({ tokenEstimator: { estimateMessage: () => Number.NaN } });
    expect(() => builder.build({ invocationId: "inv", agent, messages: [agentMessage("user", "x")], metadata: {}, limits: { maxTokens: 1 } })).toThrow(/invalid estimate/);
  });

  test("applies all budgets in order on a long history and preserves protocol blocks", () => {
    const agent = AgentRegistry.fromModules([AppModule]).requireAgent("plain-agent");
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
    const agent = AgentRegistry.fromModules([AppModule]).requireAgent("plain-agent");
    for (const estimates of [[0.1, 0.2, 1], [1e308, 1e308, 1]]) {
      let index = 0;
      const builder = new DefaultAgentContextBuilder({ tokenEstimator: { estimateMessage: () => estimates[index++]! } });
      const context = builder.build({ invocationId: "custom", agent, metadata: {}, messages: [agentMessage("user", "old"), agentMessage("assistant", "old answer"), agentMessage("user", "current")], limits: { maxTokens: 1 } });
      expect(context.messages.map(textOf)).toEqual(["current"]);
      expect(context.metadata.tokenCount).toBe(1);
    }
  });
});
