import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withToolExecution } from "./toolExecution.fixture";
import { createContainer, Module, scoped } from "../../di";
import { registerGeneratedOpenApiMetadata, restoreGeneratedOpenApiRegistry, snapshotGeneratedOpenApiRegistry } from "../../http/OpenApi/generatedOpenApiRegistry";
import { registerRequestModelShape, restoreRequestModelRegistry, snapshotRequestModelRegistry } from "../../http/Binding/requestModelRegistry";
import { Validator, modelValidatorAdapter } from "../../../library/validation";
import {
  Tool,
  AgentRuntime,
  agentClassSchema,
  agentData,
  agentMessage,
  agentModelResponse,
  agentOutputContract,
  agentJsonSchema,
  agentToolCall,
  type AgentToolSettlementEventV1,
  type AgentToolObserverEventV1,
  type AgentOutputContract,
  type AgentToolExecutionContext,
} from "../index";
import { AgentToolExecutor } from "../AgentToolExecutor";
import { AgentRegistry } from "../AgentRegistry";
import { agentDefinition, agentRegistry } from "./agentDefinition.fixture";

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
          @Tool({ callers: ["agent"], name: "audit.pending", description: "Controlled pending effect", sideEffect })
          class PendingTool {
            async execute() { started.resolve(); await release.promise; effects++; return { done: true }; }
            [Symbol.dispose]() { disposals++; disposed.resolve(); }
          }
          class Settlement { settle(event: AgentToolSettlementEventV1) { events.push(event); return { status: "recorded" as const }; } }
          class Observer { observe(event: AgentToolObserverEventV1) { events.push(event.settlement); } }
          const PendingAgent = agentDefinition({ name: "pending-agent", tools: [PendingTool] });
          @Module({ tools: [PendingTool], providers: [scoped(PendingTool)], exports: [], agentToolHooks: [
            ...(hooks === "settlement" || hooks === "both" ? [{ kind: "settlement" as const, id: "settle", version: 1, handler: Settlement }] : []),
            ...(hooks === "observer" || hooks === "both" ? [{ kind: "observer" as const, id: "observe", version: 1, handler: Observer }] : []),
          ] }) class Fixture {}
          const container = createContainer(Fixture);
          const executor = new AgentToolExecutor(container, agentRegistry(container, PendingAgent), { approvalPolicy: () => true, auditSink: (entry) => {
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
    @Tool({ callers: ["agent"], name: "audit.write", description: "Delayed write", sideEffect: "write" })
    class WriteTool {
      async execute() { await release.promise; effects++; return {}; }
      [Symbol.dispose]() { disposed.resolve(); }
    }
    class Settlement { settle() { return { status: "recorded" as const }; } }
    class Observer { observe() {} }
    const WriteAgent = agentDefinition({ name: "write-agent", tools: [WriteTool] });
    @Module({ tools: [WriteTool], providers: [scoped(WriteTool)], agentToolHooks: [
      { kind: "settlement", id: "settle", version: 1, handler: Settlement },
      { kind: "observer", id: "observe", version: 1, handler: Observer },
    ], exports: [] }) class Fixture {}
    const container = createContainer(withToolExecution(Fixture, { defaultTimeoutMs: 30, approvalPolicy: () => true, auditSink: () => {} }));
    const runtime = new AgentRuntime(container, {
      complete(request) {
        calls++;
        return calls === 1 ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "write", name: "audit.write" })] })
          : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") });
      },
    });
    try {
      const result = await runtime.run(WriteAgent, { input: "write" });
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
      @Module({ exports: [] }) class Fixture {}
      const container = createContainer(Fixture);
      const runtime = new AgentRuntime(container, {
        complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", response) }); },
      });
      try {
        const result = await runtime.run({ name: "output-agent", instructions: "" }, { input: "answer", output });
        expect(result.status).toBe(valid ? "completed" : "failed");
        if (valid) expect(result.output).toEqual(JSON.parse(response));
        else { expect(result.error?.code).toStartWith("AGENT_OUTPUT_"); expect(result.output).toBeUndefined(); }
      } finally { await container.dispose(); }
    });
  }

  test("resolves and validates an explicit generated class output", async () => {
    registerGeneratedOpenApiMetadata({ schemas: { ExplicitOutput: numberSchema }, operations: {} });
    @Module({ exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    const runtime = new AgentRuntime(container, {
      complete(request) {
        expect(request.output?.schema).toMatchObject({ kind: "json-schema", name: "ExplicitOutput", schema: numberSchema });
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData({ value: 3 })) });
      },
    });
    try {
      const result = await runtime.run({ name: "explicit-class", instructions: "" }, { input: "answer", output: agentOutputContract({ mode: "json", schema: agentClassSchema("ExplicitOutput") }) });
      expect(result.output).toEqual({ value: 3 });
    } finally { await container.dispose(); }
  });

  test("a generated class output enforces patterns and formats without an injected validator", async () => {
    registerGeneratedOpenApiMetadata({ schemas: { AuditRules: { type: "object", properties: { email: { type: "string", format: "email" }, code: { type: "string", pattern: "^[A-Z]{3}$" } }, required: ["email", "code"] } }, operations: {} });
    @Module({ exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    let answer = { email: "bad", code: "lowercase" };
    const runtime = new AgentRuntime(container, {
      complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", agentData(answer)) }); },
    });
    const output = agentOutputContract({ mode: "json", schema: agentClassSchema("AuditRules") });
    try {
      expect((await runtime.run({ name: "rules-agent", instructions: "" }, { input: "check", output })).error?.code).toBe("AGENT_OUTPUT_INVALID");
      answer = { email: "user@example.com", code: "ABC" };
      expect((await runtime.run({ name: "rules-agent", instructions: "" }, { input: "check", output })).output).toEqual(answer);
    } finally { await container.dispose(); }
  });

  for (const generated of [false, true]) {
    test(`hydrates and serializes nested Tool DTOs, generated=${generated}`, async () => {
      class Child { @Validator({ required: true, min: 1 }) amount = 1; }
      class Parent { @Validator({ required: true, nested: true }) child = new Child(); }
      if (generated) registerGeneratedOpenApiMetadata({ schemas: { Parent: { type: "object", properties: { child: { type: "object", properties: { amount: { type: "number", minimum: 1 } }, required: ["amount"] } }, required: ["child"] } }, operations: {} });
      let executions = 0;
      @Tool({ callers: ["agent"], name: "audit.nested", description: "Nested round trip", input: Parent, output: Parent, sideEffect: "read" })
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
      const NestedAgent = agentDefinition({ name: "nested-agent", tools: [NestedTool] });
      @Module({ tools: [NestedTool], providers: [scoped(NestedTool)], exports: [] }) class Fixture {}
      const container = createContainer(Fixture);
      const executor = new AgentToolExecutor(container, agentRegistry(container, NestedAgent), { schemaValidator: modelValidatorAdapter });
      const input = { child: { amount: 2 } };
      try {
        const tool = await executor.execute(agentToolCall({ id: "valid", name: "audit.nested", input }), { agentName: "nested-agent" });
        expect(tool.status).toBe("success");
        expect(tool.output).toEqual(input);
        for (const child of [{ amount: 0 }, { amount: 2, extra: true }]) {
          expect((await executor.execute(agentToolCall({ id: "invalid", name: "audit.nested", input: { child } }), { agentName: "nested-agent" })).status).toBe("error");
        }
        expect(executions).toBe(1);
      } finally { await container.dispose(); }
    });
  }

  test("generated arrays hydrate uninitialized Tool DTO fields and keep nested validation", async () => {
    class ArrayChild { @Validator({ required: true, min: 1 }) amount!: number; }
    class ArrayParent { @Validator({ required: true, nested: true }) children!: ArrayChild[]; }
    registerRequestModelShape(ArrayParent, { children: { model: ArrayChild, array: true } });
    registerGeneratedOpenApiMetadata({ schemas: { ArrayParent: { type: "object", properties: { children: { type: "array", items: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } } }, required: ["children"] } }, operations: {} });
    let executions = 0;
    @Tool({ callers: ["agent"], name: "audit.array", description: "Array round trip", input: ArrayParent, output: ArrayParent, sideEffect: "read" })
    class ArrayTool {
      execute(input: ArrayParent) {
        expect(input.children[0]).toBeInstanceOf(ArrayChild);
        executions++;
        return input;
      }
    }
    const ArrayAgent = agentDefinition({ name: "array-agent", tools: [ArrayTool] });
    @Module({ tools: [ArrayTool], providers: [scoped(ArrayTool)], exports: [] }) class Fixture {}
    const container = createContainer(Fixture);
    const executor = new AgentToolExecutor(container, agentRegistry(container, ArrayAgent), { schemaValidator: modelValidatorAdapter });
    const input = { children: [{ amount: 2 }] };
    try {
      expect((await executor.execute(agentToolCall({ id: "invalid", name: "audit.array", input: { children: [{ amount: 0 }] } }), { agentName: "array-agent" })).status).toBe("error");
      expect(executions).toBe(0);
      expect((await executor.execute(agentToolCall({ id: "valid", name: "audit.array", input }), { agentName: "array-agent" })).output).toEqual(input);
    } finally { await container.dispose(); }
  });
});
