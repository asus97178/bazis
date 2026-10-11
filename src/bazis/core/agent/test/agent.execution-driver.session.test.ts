import { describe, expect, test } from "bun:test";
import { createContainer, Module, scoped } from "@/core/di";
import {
  Tool,
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolExecutionContext,
  type JsonValue,
} from "../index";
import { agentDefinition, agentRegistry } from "./agentDefinition.fixture";
import { AgentExecutionBoundaryError, AgentExecutionDriver } from "../internal/AgentExecutionDriver";
import type { AgentSessionPreparationV1 } from "../internal/AgentExecutionDriver";
import { canonicalAgentExecutionCheckpointV1, evolveAgentExecutionCheckpointV1, parseAgentExecutionCheckpointV1, type AgentExecutionBoundary, type AgentExecutionCheckpointV1 } from "../internal/AgentExecutionState";

@Tool({ name: "session.echo", description: "Deterministic test Tool.", sideEffect: "read" })
class SessionEchoTool {
  static calls: number[] = [];
  execute(input: JsonValue, _context: AgentToolExecutionContext): JsonValue {
    SessionEchoTool.calls.push((input as { index: number }).index);
    return input;
  }
}

const SessionPhaseAgent = agentDefinition({ name: "session-phase-agent", tools: [SessionEchoTool] });

class ScriptedProvider implements AgentModelProvider {
  calls = 0;
  complete(request: AgentModelRequest): AgentModelResponse {
    this.calls += 1;
    if (this.calls === 1) {
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [
        agentToolCall({ id: "session-call-1", name: "session.echo", input: { index: 1 } }),
        agentToolCall({ id: "session-call-2", name: "session.echo", input: { index: 2 } }),
        agentToolCall({ id: "session-call-3", name: "session.echo", input: { index: 3 } }),
      ] });
    }
    return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") });
  }
}

function boundary(onControl: (phase: string) => "continue" | "suspend" = () => "continue"): AgentExecutionBoundary {
  return {
    async checkControl(_current, candidate) {
      return onControl(candidate.phase) === "suspend" ? { kind: "suspend", reason: "test-suspend" } : { kind: "continue" };
    },
    async beforeModelDispatch() {}, async afterModelSettlement() {},
    async beforeToolDispatch() {}, async afterToolSettlement() {},
  };
}

async function prepared(driver: AgentExecutionDriver) {
  const outcome = await driver.prepareSessionCheckpoint({
    invocationId: "session-phase-invocation", agentName: "session-phase-agent", input: { request: "go" },
    requested: { maxSteps: null, maxToolCallsPerStep: null, runTimeoutMs: null, modelProfile: null },
    module: { maxSessionSteps: 8, maxToolCallsPerStep: 8, runTimeoutMs: 300_000, providerCallTimeoutMs: 60_000, toolDefaultTimeoutMs: 30_000, scopeDisposeTimeoutMs: 5_000 },
  });
  if (outcome.kind !== "prepared") throw new Error("expected preparation");
  return outcome.checkpoint;
}

const desiredLimits = Object.freeze({ maxSessionSteps: 8, maxToolCallsPerStep: 8, runTimeoutMs: 200, providerCallTimeoutMs: 25, toolDefaultTimeoutMs: 5, scopeDisposeTimeoutMs: 20 });
function desiredRequest(agentName: string, input: JsonValue = { value: "x" }): AgentSessionPreparationV1 {
  return { invocationId: `desired-${agentName}`, agentName, input,
    requested: { maxSteps: null, maxToolCallsPerStep: null, runTimeoutMs: null, modelProfile: null }, module: desiredLimits };
}
function desiredBoundary(): AgentExecutionBoundary {
  return { async checkControl() { return { kind: "continue" }; }, async beforeModelDispatch() {}, async afterModelSettlement() {}, async beforeToolDispatch() {}, async afterToolSettlement() {} };
}

const DesiredLegacyAgent = agentDefinition({ name: "desired-legacy" });
let desiredKeyEffects = 0;
@Tool({ name: "desired.key", description: "Key failure probe.", sideEffect: "read" }) class DesiredKeyTool { execute(): JsonValue { desiredKeyEffects += 1; return { ok: true }; } }
const DesiredKeyAgent = agentDefinition({ name: "desired-key-agent", tools: [DesiredKeyTool] });

const desiredPhaseEffects: number[] = [];
@Tool({ name: "desired.phase", description: "Phase probe.", sideEffect: "read" }) class DesiredPhaseTool { execute(input: JsonValue): JsonValue { desiredPhaseEffects.push((input as { index: number }).index); return input; } }
const DesiredPhaseAgent = agentDefinition({ name: "desired-phase-agent", tools: [DesiredPhaseTool] });
class DesiredPhaseProvider implements AgentModelProvider {
  calls = 0;
  complete(r: AgentModelRequest): AgentModelResponse {
    this.calls += 1;
    if (this.calls === 1) return agentModelResponse({ invocationId: r.invocationId, finishReason: "tool-calls", toolCalls: [
      agentToolCall({ id: "phase-1", name: "desired.phase", input: { index: 1 } }), agentToolCall({ id: "phase-2", name: "desired.phase", input: { index: 2 } }), agentToolCall({ id: "phase-3", name: "desired.phase", input: { index: 3 } }),
    ] });
    return agentModelResponse({ invocationId: r.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") });
  }
}

describe("agent execution driver Session phase continuation", () => {
  test("commits three Tools, suspends after the second and resumes only the third", async () => {
    @Module({ tools: [SessionEchoTool], providers: [scoped(SessionEchoTool)] }) class AppModule {}
    const provider = new ScriptedProvider();
    const container = createContainer(AppModule);
    try {
      SessionEchoTool.calls = [];
      const registry = agentRegistry(container, SessionPhaseAgent);
      const first = new AgentExecutionDriver(container, registry, provider);
      let committed: AgentExecutionCheckpointV1 | undefined;
      const gate = boundary();
      gate.afterToolSettlement = async (_previous, candidate, _step, index) => { if (index === 1) committed = candidate; };
      gate.checkControl = async (_current, candidate) => candidate === committed ? { kind: "suspend", reason: "after-tool-2" } : { kind: "continue" };
      const suspended = await first.driveCheckpoint({
        checkpoint: await prepared(first),
        boundary: gate,
        signal: new AbortController().signal,
      });
      expect(suspended.kind).toBe("suspended");
      if (suspended.kind !== "suspended") throw new Error("expected suspension");
      if (committed === undefined) throw new Error("expected committed second Tool state");
      expect(suspended.checkpoint.phase).toBe("pending-tools");
      expect(suspended.checkpoint.pendingToolBatch?.nextToolIndex).toBe(2);
      expect(suspended.checkpoint).toBe(committed);
      expect(SessionEchoTool.calls).toEqual([1, 2]);
      expect(provider.calls).toBe(1);

      const resumed = new AgentExecutionDriver(container, registry, provider);
      const resumedOutcome = await resumed.driveCheckpoint({ checkpoint: suspended.checkpoint, boundary: boundary(), signal: new AbortController().signal });
      expect(resumedOutcome.kind).toBe("terminal");
      expect(provider.calls).toBe(2);
      expect(SessionEchoTool.calls).toEqual([1, 2, 3]);
      expect(resumedOutcome.kind === "terminal" && resumedOutcome.result.status).toBe("completed");
    } finally {
      await container.dispose();
    }
  });

  test("after model settlement rejection retains the initial checkpoint and executes no Tool", async () => {
    @Module({ tools: [SessionEchoTool], providers: [scoped(SessionEchoTool)] }) class AppModule {}
    const provider = new ScriptedProvider();
    const container = createContainer(AppModule);
    try {
      SessionEchoTool.calls = [];
      const driver = new AgentExecutionDriver(container, agentRegistry(container, SessionPhaseAgent), provider);
      const initial = await prepared(driver);
      const rejecting = boundary();
      rejecting.afterModelSettlement = async () => { throw new Error("store rejected"); };
      await expect(driver.driveCheckpoint({ checkpoint: initial, boundary: rejecting, signal: new AbortController().signal })).rejects.toMatchObject({
        name: "AgentExecutionBoundaryError", checkpoint: initial,
      } satisfies Partial<AgentExecutionBoundaryError>);
      expect(SessionEchoTool.calls).toEqual([]);
    } finally { await container.dispose(); }
  });

  test("after Tool settlement rejection retains the previous pending checkpoint", async () => {
    @Module({ tools: [SessionEchoTool], providers: [scoped(SessionEchoTool)] }) class AppModule {}
    const provider = new ScriptedProvider();
    const container = createContainer(AppModule);
    try {
      SessionEchoTool.calls = [];
      const driver = new AgentExecutionDriver(container, agentRegistry(container, SessionPhaseAgent), provider);
      let firstCommitted: unknown;
      const rejecting = boundary();
      rejecting.afterToolSettlement = async (previous) => { firstCommitted = previous; throw new Error("store rejected"); };
      let thrown: unknown;
      try {
        await driver.driveCheckpoint({ checkpoint: await prepared(driver), boundary: rejecting, signal: new AbortController().signal });
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ name: "AgentExecutionBoundaryError", checkpoint: firstCommitted });
      expect(SessionEchoTool.calls).toEqual([1]);
      expect(provider.calls).toBe(1);
    } finally { await container.dispose(); }
  });
});

test("desired legacy pre-abort resolves AGENT_ABORTED at attempted step one without provider dispatch", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredLegacyAgent), { complete(): AgentModelResponse { calls += 1; throw new Error("must not run"); } });
    const result = await driver.invoke("desired-legacy", { input: "x", signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", steps: 1, error: { code: "AGENT_ABORTED" } });
    expect(calls).toBe(0);
  } finally { await container.dispose(); }
});

test("desired legacy custom idempotency failure is a failed result and no Tool executes", async () => {
  @Module({ tools: [DesiredKeyTool], providers: [scoped(DesiredKeyTool)] }) class AppModule {}
  const container = createContainer(AppModule);
  try {
    desiredKeyEffects = 0;
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredKeyAgent), { complete(r) { return agentModelResponse({ invocationId: r.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "key-1", name: "desired.key", input: {} })] }); } });
    const result = await driver.invoke("desired-key-agent", { input: "x", toolExecution: { idempotencyKeyForCall() { throw new Error("key fault"); } } });
    expect(result).toMatchObject({ status: "failed", error: { code: "AGENT_TOOL_OPTIONS_INVALID" } });
    expect(desiredKeyEffects).toBe(0);
  } finally { await container.dispose(); }
});

test("desired suspension after committed model returns exact committed candidate identity", async () => {
  @Module({ tools: [DesiredPhaseTool], providers: [scoped(DesiredPhaseTool)] }) class AppModule {}
  const container = createContainer(AppModule);
  try {
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredPhaseAgent), new DesiredPhaseProvider());
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-phase-agent")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    let committed: AgentExecutionCheckpointV1 | undefined; const gate = desiredBoundary();
    gate.afterModelSettlement = async (_previous, candidate) => { committed = candidate; };
    gate.checkControl = async (_current, candidate) => candidate === committed ? { kind: "suspend", reason: "committed-model" } : { kind: "continue" };
    const result = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: gate, signal: new AbortController().signal });
    expect(result.kind).toBe("suspended"); if (result.kind !== "suspended" || committed === undefined) throw new Error("no committed suspension");
    expect(result.checkpoint).toBe(committed); expect(result.checkpoint.phase).toBe("pending-tools");
  } finally { await container.dispose(); }
});

test("desired suspension after committed second Tool returns exact settled candidate identity", async () => {
  @Module({ tools: [DesiredPhaseTool], providers: [scoped(DesiredPhaseTool)] }) class AppModule {}
  const container = createContainer(AppModule);
  try {
    desiredPhaseEffects.length = 0;
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredPhaseAgent), new DesiredPhaseProvider());
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-phase-agent")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    let committed: AgentExecutionCheckpointV1 | undefined; const gate = desiredBoundary();
    gate.afterToolSettlement = async (_previous, candidate, _step, index) => { if (index === 1) committed = candidate; };
    gate.checkControl = async (_current, candidate) => candidate === committed ? { kind: "suspend", reason: "committed-tool-2" } : { kind: "continue" };
    const result = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: gate, signal: new AbortController().signal });
    expect(result.kind).toBe("suspended"); if (result.kind !== "suspended" || committed === undefined) throw new Error("no committed suspension");
    expect(desiredPhaseEffects).toEqual([1, 2]); expect(result.checkpoint).toBe(committed); expect(result.checkpoint.pendingToolBatch?.nextToolIndex).toBe(2);
  } finally { await container.dispose(); }
});

let desiredUnknownEffects = 0; let desiredSuffixEffects = 0;
@Tool({ name: "desired.unknown", description: "Write unknown probe.", sideEffect: "write", timeoutMs: 5 }) class DesiredUnknownTool { execute(): Promise<JsonValue> { desiredUnknownEffects += 1; return new Promise(() => undefined); } }
@Tool({ name: "desired.suffix", description: "Must not run.", sideEffect: "read" }) class DesiredSuffixTool { execute(): JsonValue { desiredSuffixEffects += 1; return { bad: true }; } }
const DesiredUnknownAgent = agentDefinition({ name: "desired-unknown-agent", tools: [DesiredUnknownTool, DesiredSuffixTool] });

test("desired unknown middle write records canonical audit and afterTool terminal prefix before stopping suffix", async () => {
  @Module({ tools: [DesiredUnknownTool, DesiredSuffixTool], providers: [scoped(DesiredUnknownTool), scoped(DesiredSuffixTool)] }) class AppModule {}
  const container = createContainer(AppModule);
  try {
    desiredUnknownEffects = 0; desiredSuffixEffects = 0; const audits: string[] = [];
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredUnknownAgent), { complete(r) { return agentModelResponse({ invocationId: r.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "unknown", name: "desired.unknown", input: {} }), agentToolCall({ id: "suffix", name: "desired.suffix", input: {} })] }); } }, { toolExecutorOptions: { approvalPolicy: () => true, auditSink(entry) { audits.push(entry.phase); } } });
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-unknown-agent")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    let settled: AgentExecutionCheckpointV1 | undefined; const gate = desiredBoundary(); gate.afterToolSettlement = async (_previous, candidate) => { settled = candidate; };
    const result = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: gate, signal: new AbortController().signal });
    expect(result.kind).toBe("terminal"); if (result.kind !== "terminal" || settled === undefined) throw new Error("missing unknown settlement");
    expect(result.checkpoint).toBe(settled); expect(settled.phase).toBe("terminal"); expect(settled.pendingToolBatch?.nextToolIndex).toBe(1);
    expect(settled.toolResults[0]?.error?.code).toContain("OUTCOME_UNKNOWN"); expect(desiredUnknownEffects).toBe(1); expect(desiredSuffixEffects).toBe(0); expect(audits.length).toBeGreaterThan(0);
  } finally { await container.dispose(); }
});

const DesiredInputAgent = agentDefinition({ name: "desired-input-agent" });
test("desired Session preparation saves null context limits", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredInputAgent), { complete(): AgentModelResponse { throw new Error("must not dispatch"); } }, { contextLimits: { maxMessages: 2, maxChars: 20, maxTokens: 4 } });
    const saved = await driver.prepareSessionCheckpoint(desiredRequest("desired-input-agent", { value: "x" }));
    expect(saved.kind).toBe("prepared"); if (saved.kind !== "prepared") throw new Error("not prepared");
    expect(saved.checkpoint.invocation.options.context).toEqual({ maxMessages: null, maxChars: null, maxTokens: null });
    expect(saved.checkpoint.invocation).not.toHaveProperty("taskName");
  } finally { await container.dispose(); }
});

const DesiredMismatchAgent = agentDefinition({ name: "desired-mismatch" });
test("desired invocation mismatch publishes failed terminal without retaining foreign response and invokes after callback", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredMismatchAgent), { complete() { return agentModelResponse({ invocationId: "foreign", finishReason: "stop", message: agentMessage("assistant", "foreign") }); } });
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-mismatch")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    let settled = false; const gate = desiredBoundary(); gate.afterModelSettlement = async () => { settled = true; };
    const outcome = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: gate, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ kind: "terminal", result: { status: "failed", error: { code: "AGENT_PROVIDER_RESPONSE_INVALID" } } }); expect(settled).toBe(true); expect(outcome.checkpoint.responses).toEqual([]);
  } finally { await container.dispose(); }
});

const DesiredControlAgent = agentDefinition({ name: "desired-control" });
test("desired no-effect terminal controls publish candidate only on continue and never dispatch", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    let dispatches = 0; const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredControlAgent), { complete(): AgentModelResponse { dispatches += 1; throw new Error("must not dispatch"); } });
    const prepared = await driver.prepareSessionCheckpoint({ ...desiredRequest("desired-control"), requested: { maxSteps: 1, maxToolCallsPerStep: null, runTimeoutMs: null, modelProfile: null } }); if (prepared.kind !== "prepared") throw new Error("not prepared");
    const exhausted = evolveAgentExecutionCheckpointV1(prepared.checkpoint, { phase: "ready-model", steps: 1, messages: prepared.checkpoint.messages, responses: [], toolResults: [], seenToolCallIds: [], pendingToolBatch: undefined, terminal: undefined });
    expect(await driver.driveCheckpoint({ checkpoint: exhausted, boundary: desiredBoundary(), signal: new AbortController().signal })).toMatchObject({ kind: "terminal", result: { error: { code: "AGENT_MAX_STEPS_EXCEEDED" } } });
    const suspendedGate = desiredBoundary(); suspendedGate.checkControl = async () => ({ kind: "suspend", reason: "hold" });
    expect(await driver.driveCheckpoint({ checkpoint: exhausted, boundary: suspendedGate, signal: new AbortController().signal })).toMatchObject({ kind: "suspended", checkpoint: exhausted });
    const rejected = desiredBoundary(); rejected.checkControl = async () => { throw new Error("reject"); };
    await expect(driver.driveCheckpoint({ checkpoint: exhausted, boundary: rejected, signal: new AbortController().signal })).rejects.toMatchObject({ name: "AgentExecutionBoundaryError", checkpoint: exhausted }); expect(dispatches).toBe(0);
  } finally { await container.dispose(); }
});

test("desired State issued canonical round trip is stable and unissued terminal cannot resume", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredControlAgent), { complete(r) { return agentModelResponse({ invocationId: r.invocationId, finishReason: "stop", message: agentMessage("assistant", "done") }); } });
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-control")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    const wire = canonicalAgentExecutionCheckpointV1(prepared.checkpoint); const parsed = parseAgentExecutionCheckpointV1(wire); expect(canonicalAgentExecutionCheckpointV1(parsed)).toBe(wire);
    await expect(driver.driveCheckpoint({ checkpoint: { ...parsed }, boundary: desiredBoundary(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "AGENT_EXECUTION_STATE_INVALID" });
    const terminal = await driver.driveCheckpoint({ checkpoint: parsed, boundary: desiredBoundary(), signal: new AbortController().signal });
    await expect(driver.driveCheckpoint({ checkpoint: terminal.checkpoint, boundary: desiredBoundary(), signal: new AbortController().signal })).rejects.toThrow("terminal Agent Session checkpoints cannot be resumed");
  } finally { await container.dispose(); }
});

test("desired context failure proposes no-effect terminal only after control continue", async () => {
  @Module({}) class AppModule {}
  const container = createContainer(AppModule);
  try {
    let dispatches = 0;
    const driver = new AgentExecutionDriver(container, agentRegistry(container, DesiredControlAgent), { complete(): AgentModelResponse { dispatches += 1; throw new Error("must not dispatch"); } }, { contextBuilder: { build() { throw new Error("context failed"); } } });
    const prepared = await driver.prepareSessionCheckpoint(desiredRequest("desired-control")); if (prepared.kind !== "prepared") throw new Error("not prepared");
    const continued = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: desiredBoundary(), signal: new AbortController().signal });
    expect(continued).toMatchObject({ kind: "terminal", result: { status: "failed", error: { code: "AGENT_CONTEXT_INVALID" } } });
    const suspendedGate = desiredBoundary();
    suspendedGate.checkControl = async (current, candidate) => current === candidate ? { kind: "continue" } : { kind: "suspend", reason: "context-hold" };
    const suspended = await driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: suspendedGate, signal: new AbortController().signal });
    expect(suspended).toMatchObject({ kind: "suspended", checkpoint: prepared.checkpoint });
    const rejected = desiredBoundary(); rejected.checkControl = async (current, candidate) => { if (current === candidate) return { kind: "continue" }; throw new Error("context reject"); };
    await expect(driver.driveCheckpoint({ checkpoint: prepared.checkpoint, boundary: rejected, signal: new AbortController().signal })).rejects.toMatchObject({ name: "AgentExecutionBoundaryError", checkpoint: prepared.checkpoint });
    expect(dispatches).toBe(0);
  } finally { await container.dispose(); }
});
