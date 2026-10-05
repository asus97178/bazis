import { expect, test } from "bun:test";
import { createContainer, scoped } from "osnv/core/di";
import { AgentRegistry, AgentRuntime, AgentSetupError, Tool, agentMessage, agentModelResponse, agentToolCall, type AgentModelRequest } from "../index";

test("a data agent invokes the existing runtime without an agent class or module registration", async () => {
  const source = { name: "main", instructions: "Be concise", modelProfile: "fast", toolNames: [] as string[] };
  const registry = AgentRegistry.fromDefinition(source);
  source.instructions = "Changed later";
  source.toolNames.push("untrusted");
  const container = createContainer({});
  let request: AgentModelRequest | undefined;
  try {
    const runtime = new AgentRuntime(container, registry, { complete: (input, context) => {
      request = input;
      expect(context.modelProfile).toBe("fast");
      return agentModelResponse({ invocationId: input.invocationId, finishReason: "stop", message: agentMessage("assistant", "Answer") });
    } });
    const result = await runtime.invoke("main", { messages: [agentMessage("user", "Question")] });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(request?.messages)).toContain("Be concise");
    expect(JSON.stringify(request?.messages)).not.toContain("Changed later");
    expect(request?.tools).toEqual([]);
    expect(registry.requireAgent("main").tasks).toEqual([]);
  } finally { await container.dispose(); }
});

@Tool({ name: "host.read", description: "Approved reader", sideEffect: "read" })
class HostReadTool { execute() { return "Read through ToolExecutor"; } }

test("data agents receive only explicit host tools and use the existing tool executor", async () => {
  const host = AgentRegistry.fromModules([], { tools: [HostReadTool] });
  const registry = AgentRegistry.fromDefinition({ name: "reader", instructions: "Read", toolNames: ["host.read"] }, host.listTools());
  const container = createContainer({ tools: [HostReadTool], providers: [scoped(HostReadTool)] });
  let count = 0;
  try {
    const runtime = new AgentRuntime(container, registry, { complete: request => {
      count++;
      return count === 1
        ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "call-1", name: "host.read", input: {} })] })
        : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done") });
    } });
    const result = await runtime.invoke("reader", { input: "Read" });
    expect(result.status).toBe("completed");
    expect(result.toolResults[0]?.output).toBe("Read through ToolExecutor");
    expect(count).toBe(2);
  } finally { await container.dispose(); }
});

test("unknown, duplicate and malformed capabilities fail before dispatch", () => {
  const definition = { name: "main", instructions: "" };
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: ["host.read"] })).toThrow(AgentSetupError);
  const host = AgentRegistry.fromModules([], { tools: [HostReadTool] });
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: ["host.read", "host.read"] }, host.listTools())).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition(definition, [...host.listTools(), ...host.listTools()])).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, modelProfile: "" })).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, instructions: null } as never)).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: null } as never)).toThrow(AgentSetupError);
});
