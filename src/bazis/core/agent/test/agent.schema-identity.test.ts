import { afterEach, beforeEach, expect, test } from "bun:test";
import { createContainer } from "../../di";
import { getGeneratedOpenApiSchemaName, registerGeneratedOpenApiMetadata, registerGeneratedOpenApiSchemaModel, restoreGeneratedOpenApiRegistry, snapshotGeneratedOpenApiRegistry } from "../../http/OpenApi/generatedOpenApiRegistry";
import { Agent, AgentRegistry, AgentRuntime, Task, Tool, agentMessage, agentModelResponse, describeTool, type AgentModelRequest } from "../index";
import { bindAgentModel } from "../internal/AgentModelBinding";

let snapshot: ReturnType<typeof snapshotGeneratedOpenApiRegistry>;
beforeEach(() => { snapshot = snapshotGeneratedOpenApiRegistry(); });
afterEach(() => { restoreGeneratedOpenApiRegistry(snapshot); });

class SharedInput { declare id: string; }
class SharedOutput { declare answer: string; }
@Tool({ name: "schema.identity", description: "Exact DTO identities", input: SharedInput, output: SharedOutput })
class IdentityTool { execute(input: SharedInput) { return { answer: input.id }; } }
@Agent({ name: "schema.identity-agent", input: SharedInput, output: SharedOutput })
class IdentityAgent {
  @Task({ name: "identity", input: SharedInput, output: SharedOutput })
  run(): never { throw new Error("declarative task must not execute"); }
}

function register(): void {
  registerGeneratedOpenApiMetadata({ schemas: {
    ExactInput: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    ExactOutput: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    SharedInput: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    SharedOutput: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
  }, operations: {} });
  registerGeneratedOpenApiSchemaModel(SharedInput, "ExactInput");
  registerGeneratedOpenApiSchemaModel(SharedOutput, "ExactOutput");
}

test("Tool descriptions and DTO binding prefer exact identities over colliding short names", () => {
  register();
  const registry = AgentRegistry.fromModules([], { tools: [IdentityTool] });
  const contract = describeTool(registry.getTool("schema.identity")!);
  expect(contract.input).toMatchObject({ kind: "json-schema", name: "ExactInput", schema: { properties: { id: { type: "string" } } } });
  expect(contract.output).toMatchObject({ kind: "json-schema", name: "ExactOutput" });
  expect(bindAgentModel(SharedInput, { id: "alice" })).toBeInstanceOf(SharedInput);
  expect(() => bindAgentModel(SharedInput, { count: 1 })).toThrow();
});

test("a missing exact schema never falls back to another short-name schema", () => {
  registerGeneratedOpenApiMetadata({ schemas: { SharedInput: { type: "object", properties: { count: { type: "number" } } } }, operations: {} });
  registerGeneratedOpenApiSchemaModel(SharedInput, "MissingExactInput");
  const tool = AgentRegistry.fromModules([], { tools: [IdentityTool] }).getTool("schema.identity")!;
  expect(describeTool(tool).input).toMatchObject({ kind: "class", name: "MissingExactInput" });
  expect(() => bindAgentModel(SharedInput, { count: 1 })).toThrow();
});

test("Agent and Task inputs, outputs and provider contracts share the exact schema identity", async () => {
  register();
  const services = createContainer({ exports: [] });
  const requests: AgentModelRequest[] = [];
  const runtime = new AgentRuntime(services, AgentRegistry.fromModules([], { agents: [IdentityAgent] }), {
    complete(request) {
      requests.push(request);
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"answer":"ok"}') });
    },
  });
  try {
    expect((await runtime.invoke("schema.identity-agent", { input: { id: "alice" } })).output).toEqual({ answer: "ok" });
    expect((await runtime.invokeTask("schema.identity-agent", "identity", { id: "bob" })).output).toEqual({ answer: "ok" });
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.output?.schema).toMatchObject({ kind: "json-schema", name: "ExactOutput" });
    expect((await runtime.invoke("schema.identity-agent", { input: { count: 1 } })).status).toBe("failed");
    expect(requests).toHaveLength(2);
    expect(getGeneratedOpenApiSchemaName(SharedInput)).toBe("ExactInput");
  } finally { await services.dispose(); }
});
