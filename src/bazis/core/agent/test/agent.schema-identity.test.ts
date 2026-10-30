import { afterEach, beforeEach, expect, test } from "bun:test";
import { createContainer } from "../../di";
import { getGeneratedOpenApiSchemaName, registerGeneratedOpenApiMetadata, registerGeneratedOpenApiSchemaModel, restoreGeneratedOpenApiRegistry, snapshotGeneratedOpenApiRegistry } from "../../http/OpenApi/generatedOpenApiRegistry";
import { AgentRuntime, Tool, agentClassSchema, agentMessage, agentModelResponse, agentOutputContract, describeTool, toolMetadataOf, type AgentModelRequest } from "../index";
import { AgentRegistry } from "../AgentRegistry";
import { bindAgentModel } from "../internal/AgentModelBinding";

let snapshot: ReturnType<typeof snapshotGeneratedOpenApiRegistry>;
beforeEach(() => { snapshot = snapshotGeneratedOpenApiRegistry(); });
afterEach(() => { restoreGeneratedOpenApiRegistry(snapshot); });

class SharedInput { declare id: string; }
class SharedOutput { declare answer: string; }
@Tool({ callers: ["agent"], name: "schema.identity", description: "Exact DTO identities", input: SharedInput, output: SharedOutput })
class IdentityTool { execute(input: SharedInput) { return { answer: input.id }; } }

function identityCatalog() {
  return [{ target: IdentityTool, metadata: toolMetadataOf(IdentityTool)! }];
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
  const registry = AgentRegistry.fromDefinition({ name: "identity", instructions: "", toolNames: ["schema.identity"] }, identityCatalog());
  const contract = describeTool(registry.getTool("schema.identity")!);
  expect(contract.input).toMatchObject({ kind: "json-schema", name: "ExactInput", schema: { properties: { id: { type: "string" } } } });
  expect(contract.output).toMatchObject({ kind: "json-schema", name: "ExactOutput" });
  expect(bindAgentModel(SharedInput, { id: "alice" })).toBeInstanceOf(SharedInput);
  expect(() => bindAgentModel(SharedInput, { count: 1 })).toThrow();
});

test("a missing exact schema never falls back to another short-name schema", () => {
  registerGeneratedOpenApiMetadata({ schemas: { SharedInput: { type: "object", properties: { count: { type: "number" } } } }, operations: {} });
  registerGeneratedOpenApiSchemaModel(SharedInput, "MissingExactInput");
  const tool = identityCatalog().find((entry) => entry.metadata.name === "schema.identity")!;
  expect(describeTool(tool).input).toMatchObject({ kind: "class", name: "MissingExactInput" });
  expect(() => bindAgentModel(SharedInput, { count: 1 })).toThrow();
});

test("an explicit class output contract uses the exact schema identity", async () => {
  register();
  const services = createContainer({ exports: [] });
  const requests: AgentModelRequest[] = [];
  const runtime = new AgentRuntime(services, {
    complete(request) {
      requests.push(request);
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", '{"answer":"ok"}') });
    },
  });
  try {
    const output = agentOutputContract({ mode: "json", schema: agentClassSchema("ExactOutput") });
    expect((await runtime.run({ name: "identity-agent", instructions: "" }, { input: { id: "alice" }, output })).output).toEqual({ answer: "ok" });
    expect(requests[0]?.output?.schema).toMatchObject({ kind: "json-schema", name: "ExactOutput" });
    expect(getGeneratedOpenApiSchemaName(SharedOutput)).toBe("ExactOutput");
  } finally { await services.dispose(); }
});
