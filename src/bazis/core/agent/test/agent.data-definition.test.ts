import { expect, test } from "bun:test";
import { createContainer, scoped } from "bazis/core/di";
import { AgentRuntime, AgentSetupError, Tool, agentMessage, agentModelResponse, agentToolCall, type AgentModelRequest } from "../index";
import { AgentRegistry } from "../AgentRegistry";

test("a meta-agent definition runs without an agent class; later edits of the source object do not leak in", async () => {
  const source = { name: "main", instructions: "Be concise", modelProfile: "fast", toolNames: [] as string[] };
  const registry = AgentRegistry.fromDefinition(source);
  source.instructions = "Changed later";
  source.toolNames.push("untrusted");
  expect(registry.requireAgent("main")).toMatchObject({ name: "main", instructions: "Be concise", modelProfile: "fast", tools: [] });

  const container = createContainer({});
  let request: AgentModelRequest | undefined;
  try {
    const runtime = new AgentRuntime(container, { complete: (input, context) => {
      request = input;
      expect(context.modelProfile).toBe("fast");
      return agentModelResponse({ invocationId: input.invocationId, finishReason: "stop", message: agentMessage("assistant", "Answer") });
    } });
    const result = await runtime.run({ name: "main", instructions: "Be concise", modelProfile: "fast" }, { messages: [agentMessage("user", "Question")] });
    expect(result.status).toBe("completed");
    expect(result.agentName).toBe("main");
    expect(request?.messages[0]).toMatchObject({ role: "system", content: [{ kind: "text", text: "Be concise" }] });
    expect(request?.tools).toEqual([]);
  } finally { await container.dispose(); }
});

@Tool({ name: "host.read", description: "Approved reader", sideEffect: "read" })
class HostReadTool { execute() { return "Read through ToolExecutor"; } }

@Tool({ name: "host.hidden", description: "Registered, but not named by the agent", sideEffect: "read" })
class HostHiddenTool { execute() { return "must not run"; } }

test("an agent sees only the registered tools it names and calls them through the tool executor", async () => {
  const container = createContainer({ tools: [HostReadTool, HostHiddenTool], providers: [scoped(HostReadTool), scoped(HostHiddenTool)] });
  const requests: AgentModelRequest[] = [];
  try {
    const runtime = new AgentRuntime(container, { complete: request => {
      requests.push(request);
      return requests.length === 1
        ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [
          agentToolCall({ id: "call-1", name: "host.read", input: {} }),
          agentToolCall({ id: "call-2", name: "host.hidden", input: {} }),
        ] })
        : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Done") });
    } });
    expect(runtime.listTools().map((tool) => tool.metadata.name)).toEqual(["host.read", "host.hidden"]);
    const result = await runtime.run({ name: "reader", instructions: "Read", toolNames: ["host.read"] }, { input: "Read" });
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["host.read"]);
    expect(result.status).toBe("completed");
    expect(result.toolResults[0]?.output).toBe("Read through ToolExecutor");
    expect(result.toolResults[1]?.error?.code).toBe("TOOL_NOT_REGISTERED");
    expect(requests).toHaveLength(2);
  } finally { await container.dispose(); }
});

test("unknown, duplicate and malformed definitions fail before dispatch", () => {
  const definition = { name: "main", instructions: "" };
  const container = createContainer({ tools: [HostReadTool], providers: [scoped(HostReadTool)] });
  const catalog = AgentRegistry.fromContainer(container).listTools();
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: ["host.read"] })).toThrow(
    'Agent "main": tool "host.read" is not registered in the application (no tools are registered in @Module.tools).',
  );
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: ["host.write"] }, catalog)).toThrow(
    'Agent "main": tool "host.write" is not registered in the application (registered: host.read).',
  );
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: ["host.read", "host.read"] }, catalog)).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition(definition, [...catalog, ...catalog])).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, name: "" })).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, modelProfile: "" })).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, instructions: null } as never)).toThrow(AgentSetupError);
  expect(() => AgentRegistry.fromDefinition({ ...definition, toolNames: null } as never)).toThrow(AgentSetupError);
  void container.dispose();
});

test("a class listed in @Module.tools without @Tool is a setup error", () => {
  class NotATool { execute() { return null; } }
  expect(() => createContainer({ tools: [NotATool], providers: [scoped(NotATool)] })).toThrow(
    "NotATool is listed as a tool but is not decorated with @Tool(...).",
  );
});
