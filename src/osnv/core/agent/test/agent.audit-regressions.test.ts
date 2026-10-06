import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createContainer, Module, scoped } from "../../di";
import { registerGeneratedOpenApiMetadata, restoreGeneratedOpenApiRegistry, snapshotGeneratedOpenApiRegistry } from "../../http/OpenApi/generatedOpenApiRegistry";
import { registerRequestModelShape, restoreRequestModelRegistry, snapshotRequestModelRegistry } from "../../http/Binding/requestModelRegistry";
import { Validator, modelValidatorAdapter } from "../../../library/validation";
import {
  Agent, Tool, Task, AgentRegistry, AgentRuntime, AgentToolExecutor,
  agentClassSchema, agentData, agentMessage, agentModelResponse, agentOutput, agentOutputContract, agentJsonSchema, agentToolCall,
  type AgentToolSettlementEventV1, type AgentToolObserverEventV1, type AgentOutputContract, type AgentToolExecutionContext,
} from "../index";

let schemas: ReturnType<typeof snapshotGeneratedOpenApiRegistry>;
let models: ReturnType<typeof snapshotRequestModelRegistry>;
beforeEach(() => { schemas = snapshotGeneratedOpenApiRegistry(); models = snapshotRequestModelRegistry(); });
afterEach(() => { restoreGeneratedOpenApiRegistry(schemas); restoreRequestModelRegistry(models); });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Agent regressions: interrupted effects", () => {
  for (const hooks of ["none", "settlement", "observer", "both"] as const) {
    for (const sideEffect of ["read", "write", "external"] as const) {
      for (const boundary of ["timeout", "abort"] as const) {
        test(`${boundary} of pending ${sideEffect}, hooks=${hooks}`, async () => {
          const started = gate(), release = gate(), disposed = gate();
          let effects = 0, disposals = 0;
          const events: AgentToolSettlementEventV1[] = [];
          const observerOutcomes: string[] = [];
          @Tool({ name: "audit.pending", description: "Controlled pending effect", sideEffect })
          class PendingTool {
            async execute() { started.resolve(); await release.promise; effects++; return { done: true }; }
            [Symbol.dispose]() { disposals++; disposed.resolve(); }
          }
          class Settlement { settle(event: AgentToolSettlementEventV1) { events.push(event); return { status: "recorded" as const }; } }
          class Observer { observe(event: AgentToolObserverEventV1) { events.push(event.settlement); } }
          @Agent({ name: "pending-agent", tools: [PendingTool] }) class PendingAgent {}
          @Module({ agents: [PendingAgent], tools: [PendingTool], providers: [scoped(PendingTool)], exports: [], agentToolHooks: [
            ...(hooks === "settlement" || hooks === "both" ? [{ kind: "settlement" as const, id: "settle", version: 1, handler: Settlement }] : []),
            ...(hooks === "observer" || hooks === "both" ? [{ kind: "observer" as const, id: "observe", version: 1, handler: Observer }] : []),
          ] }) class Fixture {}
          const container = createContainer(Fixture);
          const executor = new AgentToolExecutor(container, AgentRegistry.fromModules([Fixture]), { approvalPolicy: () => true, auditSink: (entry) => {
            if (entry.hook?.kind === "observer") observerOutcomes.push(entry.hook.outcome);
          } });
          const controller = new AbortController();
          try {
            const pending = executor.execute(agentToolCall({ id: "pending", name: "audit.pending" }), { agentName: "pending-agent", timeoutMs: boundary === "timeout" ? 30 : 0, signal: controller.signal });
            await started.promise;
            if (boundary === "abort") controller.abort();
            const result = await pending;
            const known = sideEffect === "read";
            const code = `TOOL_${boundary === "timeout" ? "TIMEOUT" : "ABORTED"}${known ? "" : "_OUTCOME_UNKNOWN"}`;
            expect(result.error?.code).toBe(code);
            expect(effects).toBe(0);
            expect(disposals).toBe(0);
            // Best-effort observers skip activation under an aborted signal;
            // required post-effect settlement still runs and records uncertainty.
            expect(events).toHaveLength(hooks === "settlement" || hooks === "both" ? 1 : 0);
            for (const event of events) expect(event.terminal).toMatchObject({ executeStarted: true, outcomeKnown: known, errorCode: code });
            expect(observerOutcomes).toEqual(hooks === "observer" || hooks === "both" ? ["cancelled"] : []);
          } finally {
            release.resolve();
            await disposed.promise;
            await container.dispose();
          }
          expect(effects).toBe(1);
          expect(disposals).toBe(1);
        });
      }
    }
  }

  test("runtime stops before the next model dispatch when hooked writes time out", async () => {
    const release = gate(), disposed = gate();
    let calls = 0, effects = 0;
    @Tool({ name: "audit.write", description: "Delayed write", sideEffect: "write" })
    class WriteTool {
      async execute() { await release.promise; effects++; return {}; }
      [Symbol.dispose]() { disposed.resolve(); }
    }
    class Settlement { settle() { return { status: "recorded" as const }; } }
    class Observer { observe() {} }
    @Agent({ name: "write-agent", tools: [WriteTool] }) class WriteAgent {}
    @Module({ agents: [WriteAgent], tools: [WriteTool], providers: [scoped(WriteTool)], agentToolHooks: [
      { kind: "settlement", id: "settle", version: 1, handler: Settlement },
      { kind: "observer", id: "observe", version: 1, handler: Observer },
    ], exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([Fixture]), {
      complete(request) {
        calls++;
        return calls === 1 ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "write", name: "audit.write" })] })
          : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") });
      },
    }, { toolExecutorOptions: { defaultTimeoutMs: 30, approvalPolicy: () => true, auditSink: () => {} } });
    try {
      const result = await runtime.invoke("write-agent", { input: "write" });
      expect(result.error?.code).toBe("AGENT_TOOL_OUTCOME_UNKNOWN");
      expect(calls).toBe(1);
      expect(effects).toBe(0);
    } finally { release.resolve(); await disposed.promise; await container.dispose(); }
  });
});

describe("Agent regressions: structured contracts", () => {
  const numberSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
  const cases: ReadonlyArray<readonly [string, string, AgentOutputContract, boolean]> = [
    ["valid explicit schema", '{"value":3}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Value", numberSchema) }), true],
    ["non-JSON text", "not JSON", agentOutputContract({ mode: "json", schema: agentJsonSchema("Value", numberSchema) }), false],
    ["wrong type", '{"value":"3"}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Value", numberSchema) }), false],
    ["missing required", "{}", agentOutputContract({ mode: "json", schema: agentJsonSchema("Value", numberSchema) }), false],
    ["unknown field", '{"value":3,"extra":true}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Value", numberSchema) }), false],
    ["plain JSON mode", '{"ok":true}', agentOutputContract({ mode: "json" }), true],
    ["malformed plain JSON mode", "{", agentOutputContract({ mode: "json" }), false],
    ["unsafe keys", '{"constructor":{}}', agentOutputContract({ mode: "json" }), false],
    ["unknown class", "{}", agentOutputContract({ mode: "json", schema: agentClassSchema("MissingAuditSchema") }), false],
    ["unsupported rule", '{"value":3}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Unsupported", { ...numberSchema, not: { required: ["value"] } }) }), false],
    ["pattern", '"lowercase"', agentOutputContract({ mode: "json", schema: agentJsonSchema("Code", { type: "string", pattern: "^[A-Z]{3}$" }) }), false],
    ["format", '"invalid"', agentOutputContract({ mode: "json", schema: agentJsonSchema("Email", { type: "string", format: "email" }) }), false],
    ["nullable union", "null", agentOutputContract({ mode: "json", schema: agentJsonSchema("Nullable", { type: ["string", "null"] }) }), true],
    ["anyOf siblings", '"lower"', agentOutputContract({ mode: "json", schema: agentJsonSchema("Code", { anyOf: [{ type: "string" }, { type: "null" }], pattern: "^[A-Z]{3}$" }) }), false],
    ["oneOf ambiguity", "3", agentOutputContract({ mode: "json", schema: agentJsonSchema("Number", { oneOf: [{ type: "number" }, { type: "integer" }] }) }), false],
    ["schema for additional fields", '{"count":"bad"}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Counts", { type: "object", additionalProperties: { type: "integer" } }) }), false],
    ["structural enum", '{"b":2,"a":1}', agentOutputContract({ mode: "json", schema: agentJsonSchema("Enum", { enum: [{ a: 1, b: 2 }] }) }), true],
    ["unique object array", '[{"a":1,"b":2},{"b":2,"a":1}]', agentOutputContract({ mode: "json", schema: agentJsonSchema("Unique", { type: "array", items: { type: "object" }, uniqueItems: true }) }), false],
    ["unknown format on absent field", "{}", agentOutputContract({ mode: "json", schema: agentJsonSchema("UnsupportedOptional", { type: "object", properties: { value: { type: "string", format: "unknown-format" } } }) }), false],
    ["invalid pattern on absent field", "{}", agentOutputContract({ mode: "json", schema: agentJsonSchema("InvalidPattern", { type: "object", properties: { value: { type: "string", pattern: "[" } } }) }), false],
  ];
  for (const [name, response, output, valid] of cases) {
    test(name, async () => {
      @Agent({ name: "output-agent" }) class OutputAgent { @Task({ name: "run" }) run() { return agentOutput(); } }
      @Module({ agents: [OutputAgent], exports: [] }) class Fixture {}
      const container = createContainer(Fixture);
      const runtime = new AgentRuntime(container, AgentRegistry.fromModules([Fixture]), {
        complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", response) }); },
      });
      try {
        for (const result of [await runtime.invoke("output-agent", { input: "answer", output }), await runtime.invokeTask("output-agent", "run", {}, { output })]) {
          expect(result.status).toBe(valid ? "completed" : "failed");
          if (valid) expect(result.output).toEqual(JSON.parse(response));
          else { expect(result.error?.code).toStartWith("AGENT_OUTPUT_"); expect(result.output).toBeUndefined(); }
        }
      } finally { await container.dispose(); }
    });
  }

  test("resolves and validates an explicit generated class output", async () => {
    registerGeneratedOpenApiMetadata({ schemas: { ExplicitOutput: numberSchema }, operations: {} });
    @Agent({ name: "explicit-class" }) class ExplicitClassAgent {}
    @Module({ agents: [ExplicitClassAgent], exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([Fixture]), {
      complete(request) {
        expect(request.output?.schema).toMatchObject({ kind: "json-schema", name: "ExplicitOutput", schema: numberSchema });
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData({ value: 3 })) });
      },
    });
    try {
      const result = await runtime.invoke("explicit-class", { input: "answer", output: agentOutputContract({ mode: "json", schema: agentClassSchema("ExplicitOutput") }) });
      expect(result.output).toEqual({ value: 3 });
    } finally { await container.dispose(); }
  });

  test("generated input and output enforce patterns and formats without an injected validator", async () => {
    class AuditRules { email = ""; code = ""; }
    registerGeneratedOpenApiMetadata({ schemas: { AuditRules: { type: "object", properties: { email: { type: "string", format: "email" }, code: { type: "string", pattern: "^[A-Z]{3}$" } }, required: ["email", "code"] } }, operations: {} });
    @Agent({ name: "rules-agent", input: AuditRules, output: AuditRules }) class RulesAgent {}
    @Module({ agents: [RulesAgent], exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    let calls = 0;
    let answer = { email: "bad", code: "lowercase" };
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([Fixture]), {
      complete(request) { calls++; return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData(answer)) }); },
    });
    try {
      expect((await runtime.invoke("rules-agent", { input: answer })).error?.code).toBe("AGENT_INPUT_INVALID");
      expect(calls).toBe(0);
      const valid = { email: "user@example.com", code: "ABC" };
      expect((await runtime.invoke("rules-agent", { input: valid })).error?.code).toBe("AGENT_OUTPUT_INVALID");
      answer = valid;
      expect((await runtime.invoke("rules-agent", { input: valid })).output).toEqual(valid);
    } finally { await container.dispose(); }
  });

  for (const generated of [false, true]) {
    test(`hydrates and serializes nested Tool/Agent/Task DTOs, generated=${generated}`, async () => {
      class Child { @Validator({ required: true, min: 1 }) amount = 1; }
      class Parent { @Validator({ required: true, nested: true }) child = new Child(); }
      if (generated) registerGeneratedOpenApiMetadata({ schemas: { Parent: { type: "object", properties: { child: { type: "object", properties: { amount: { type: "number", minimum: 1 } }, required: ["amount"] } }, required: ["child"] } }, operations: {} });
      let executions = 0;
      @Tool({ name: "audit.nested", description: "Nested round trip", input: Parent, output: Parent, sideEffect: "read" })
      class NestedTool {
        execute(input: Parent, context: AgentToolExecutionContext) {
          expect(input.child).toBeInstanceOf(Child);
          expect(context.call.input).toEqual({ child: { amount: 2 } });
          executions++;
          const output = new Parent();
          output.child.amount = input.child.amount;
          return output;
        }
      }
      @Agent({ name: "nested-agent", input: Parent, output: Parent, tools: [NestedTool] })
      class NestedAgent { @Task({ name: "run", input: Parent, output: Parent }) run() { return agentOutput(); } }
      @Module({ agents: [NestedAgent], tools: [NestedTool], providers: [scoped(NestedTool)], exports: [] }) class Fixture {}
      const container = createContainer(Fixture), registry = AgentRegistry.fromModules([Fixture]);
      const executor = new AgentToolExecutor(container, registry, { schemaValidator: modelValidatorAdapter });
      const runtime = new AgentRuntime(container, registry, {
        complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData({ child: { amount: 2 } })) }); },
      }, { taskSchemaValidator: modelValidatorAdapter });
      const input = { child: { amount: 2 } };
      try {
        const tool = await executor.execute(agentToolCall({ id: "valid", name: "audit.nested", input }), { agentName: "nested-agent" });
        expect(tool.status).toBe("success");
        expect(tool.output).toEqual(input);
        for (const child of [{ amount: 0 }, { amount: 2, extra: true }]) {
          expect((await executor.execute(agentToolCall({ id: "invalid", name: "audit.nested", input: { child } }), { agentName: "nested-agent" })).status).toBe("error");
          expect((await runtime.invoke("nested-agent", { input: { child } })).status).toBe("failed");
        }
        expect(executions).toBe(1);
        expect((await runtime.invoke("nested-agent", { input })).output).toEqual(input);
        expect((await runtime.invokeTask("nested-agent", "run", input)).output).toEqual(input);
        const instance = new Parent();
        instance.child.amount = 2;
        expect((await runtime.invokeTask("nested-agent", "run", instance)).output).toEqual(input);
      } finally { await container.dispose(); }
    });
  }

  test("generated arrays hydrate uninitialized DTO fields and keep nested validation", async () => {
    class ArrayChild { @Validator({ required: true, min: 1 }) amount!: number; }
    class ArrayParent { @Validator({ required: true, nested: true }) children!: ArrayChild[]; }
    registerRequestModelShape(ArrayParent, { children: { model: ArrayChild, array: true } });
    registerGeneratedOpenApiMetadata({ schemas: { ArrayParent: { type: "object", properties: { children: { type: "array", items: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } } }, required: ["children"] } }, operations: {} });
    @Agent({ name: "array-agent", input: ArrayParent, output: ArrayParent }) class ArrayAgent {}
    @Module({ agents: [ArrayAgent], exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    let calls = 0;
    const input = { children: [{ amount: 2 }] };
    const runtime = new AgentRuntime(container, AgentRegistry.fromModules([Fixture]), {
      complete(request) { calls++; return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData(input)) }); },
    }, { taskSchemaValidator: modelValidatorAdapter });
    try {
      expect((await runtime.invoke("array-agent", { input: { children: [{ amount: 0 }] } })).status).toBe("failed");
      expect(calls).toBe(0);
      expect((await runtime.invoke("array-agent", { input })).output).toEqual(input);
    } finally { await container.dispose(); }
  });
});
