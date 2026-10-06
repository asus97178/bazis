import { describe, expect, test } from "bun:test";
import {
  AgentExecutionStateError,
  evolveAgentExecutionCheckpointV1,
  requireIssuedAgentExecutionCheckpointV1,
  canonicalAgentExecutionCheckpointV1,
  parseAgentExecutionCheckpointV1,
} from "../internal/AgentExecutionState";

const version = "osnv.agent-execution-state/v1";

function message(role: string, content: unknown[], options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role,
    content,
    id: null,
    name: null,
    toolCallId: null,
    createdAtUnixMs: null,
    metadata: {},
    ...options,
  };
}

function call(id: string, name = "catalog.read", input: unknown = { productId: id }): Record<string, unknown> {
  return { id, name, input, metadata: {} };
}

function result(callId: string, name = "catalog.read"): Record<string, unknown> {
  return {
    callId,
    name,
    status: "success",
    output: { found: true },
    error: null,
    durationMs: 1,
    metadata: {},
  };
}

function unknownResult(callId: string, name = "catalog.read"): Record<string, unknown> {
  return { callId, name, status: "error", output: null, error: { code: "TOOL_TIMEOUT_OUTCOME_UNKNOWN", message: "unknown", details: null }, durationMs: 1, metadata: {} };
}

function toolMessage(item: Record<string, unknown>): Record<string, unknown> {
  return message("tool", [{ kind: "tool-result", result: item }], { toolCallId: item.callId });
}

function base(phase: "ready-model" | "pending-tools" | "terminal"): Record<string, unknown> {
  return {
    version,
    invocation: {
      kind: "task",
      invocationId: "inv-1",
      agentName: "catalog-agent",
      taskName: "answer",
      input: null,
      metadata: { source: "session" },
      options: resolvedOptions(),
    },
    phase,
    steps: 0,
    messages: [message("user", [{ kind: "text", text: "Hello" }])],
    responses: [],
    toolResults: [],
    seenToolCallIds: [],
    pendingToolBatch: null,
    terminal: null,
  };
}

function resolvedOptions(): Record<string, unknown> {
  return {
    maxSteps: 8,
    maxToolCallsPerStep: 3,
    runTimeoutMs: 60_000,
    modelProfile: null,
    provider: { timeoutMs: 60_000 },
    context: { maxMessages: null, maxChars: null, maxTokens: null },
    output: { maxOutputTokens: null, temperature: null },
    tool: {
      defaultTimeoutMs: 30_000,
      scopeDisposeTimeoutMs: 5_000,
      maxAttempts: 1,
      timeouts: [{ name: "catalog.read", timeoutMs: 30_000 }],
    },
  };
}

function pending(): Record<string, unknown> {
  const checkpoint = base("pending-tools");
  const calls = [call("call-1"), call("call-2"), call("call-3")];
  const first = result("call-1");
  const second = result("call-2");
  const assistant = message("assistant", calls.map((item) => ({ kind: "tool-call", call: item })));
  checkpoint.steps = 1;
  checkpoint.responses = [{
    invocationId: "inv-1",
    finishReason: "tool-calls",
    message: null,
    toolCalls: calls,
    usage: null,
    metadata: {},
  }];
  checkpoint.messages = [...checkpoint.messages as unknown[], assistant, toolMessage(first), toolMessage(second)];
  checkpoint.toolResults = [first, second];
  checkpoint.seenToolCallIds = calls.map((item) => item.id);
  checkpoint.pendingToolBatch = { step: 1, responseIndex: 0, assistantMessageIndex: 1, nextToolIndex: 2 };
  return checkpoint;
}

function terminal(): Record<string, unknown> {
  const checkpoint = base("terminal");
  const final = message("assistant", [{ kind: "data", value: { answer: "done" }, name: "answer" }]);
  checkpoint.steps = 1;
  checkpoint.messages = [...checkpoint.messages as unknown[], final];
  checkpoint.responses = [{
    invocationId: "inv-1",
    finishReason: "stop",
    message: final,
    toolCalls: [],
    usage: null,
    metadata: {},
  }];
  checkpoint.terminal = { status: "completed", finalMessage: final, hasOutput: true, output: null, error: null };
  return checkpoint;
}

function failedTerminal(errorCode: string): Record<string, unknown> {
  const checkpoint = pending();
  checkpoint.phase = "terminal";
  checkpoint.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: errorCode, message: "failed", details: null } };
  return checkpoint;
}

function completedBatch(): Record<string, any> {
  const checkpoint = pending() as Record<string, any>;
  const third = result("call-3");
  checkpoint.messages.push(toolMessage(third));
  checkpoint.toolResults.push(third);
  checkpoint.phase = "ready-model";
  checkpoint.pendingToolBatch = null;
  return checkpoint;
}

function rejectedBatch(calls: Record<string, unknown>[], errorCode: string): Record<string, any> {
  const checkpoint = base("terminal") as Record<string, any>;
  checkpoint.invocation.options = { ...resolvedOptions(), maxToolCallsPerStep: 2 };
  checkpoint.steps = 1;
  checkpoint.responses = [{ invocationId: "inv-1", finishReason: "tool-calls", message: null, toolCalls: calls, usage: null, metadata: {} }];
  checkpoint.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: errorCode, message: "rejected", details: null } };
  return checkpoint;
}

function canonical(value: Record<string, unknown>): string {
  return canonicalAgentExecutionCheckpointV1(value);
}

function clone(value: Record<string, unknown>): Record<string, any> {
  return JSON.parse(canonical(value)) as Record<string, any>;
}

describe("agent execution checkpoint state", () => {
  test("round-trips immutable ready, partial pending and terminal checkpoints", () => {
    const ready = parseAgentExecutionCheckpointV1(canonical(base("ready-model")));
    const partial = parseAgentExecutionCheckpointV1(canonical(pending()));
    const done = parseAgentExecutionCheckpointV1(canonical(terminal()));

    expect(ready.phase).toBe("ready-model");
    expect(Object.isFrozen(ready)).toBe(true);
    expect(partial.pendingToolBatch).toEqual({ step: 1, responseIndex: 0, assistantMessageIndex: 1, nextToolIndex: 2 });
    expect(partial.toolResults).toHaveLength(2);
    expect(partial.responses[0]?.toolCalls.map((item) => item.id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(done.terminal?.output).toBeNull();
    expect(done.terminal?.finalMessage?.content[0]).toMatchObject({ kind: "data", value: { answer: "done" } });
  });

  test("admits only State-issued semantic checkpoints without traversing spoofed roots", () => {
    const issued = parseAgentExecutionCheckpointV1(canonical(base("ready-model")));
    expect(requireIssuedAgentExecutionCheckpointV1(issued)).toBe(issued);
    const evolved = evolveAgentExecutionCheckpointV1(issued, {
      phase: issued.phase, steps: issued.steps, messages: issued.messages, responses: issued.responses,
      toolResults: issued.toolResults, seenToolCallIds: issued.seenToolCallIds, pendingToolBatch: undefined, terminal: undefined,
    });
    expect(requireIssuedAgentExecutionCheckpointV1(evolved)).toBe(evolved);
    expect(() => requireIssuedAgentExecutionCheckpointV1({ ...issued })).toThrow(AgentExecutionStateError);
    const spoof = Object.defineProperty({}, "version", { get() { throw new Error("must not read getter"); } });
    expect(() => requireIssuedAgentExecutionCheckpointV1(spoof)).toThrow(AgentExecutionStateError);
  });

  test("rejects corrupted pending indices, call identity, ordering and exact seen/result prefixes", () => {
    const cases: Array<(value: Record<string, any>) => void> = [
      (value) => { value.pendingToolBatch.nextToolIndex = 3; },
      (value) => { value.pendingToolBatch.step = 2; },
      (value) => { value.pendingToolBatch.responseIndex = 1; },
      (value) => { value.messages[1].content[1].call.id = "other"; },
      (value) => { value.messages[2].toolCallId = "call-3"; },
      (value) => { value.responses[0].toolCalls[1].name = "catalog.write"; },
      (value) => { value.responses[0].toolCalls[2].input = { productId: "changed" }; },
      (value) => { value.messages.splice(3, 1); value.toolResults.splice(1, 1); },
      (value) => { value.seenToolCallIds = ["call-2", "call-1", "call-3"]; },
      (value) => { value.seenToolCallIds[2] = "call-1"; },
    ];

    for (const mutate of cases) {
      const value = clone(pending());
      mutate(value);
      expect(() => canonicalAgentExecutionCheckpointV1(value)).toThrow(AgentExecutionStateError);
    }
  });

  test("rejects unsupported parts, unknown fields, wrong version and invalid terminal shape", () => {
    const cases: Array<(value: Record<string, any>) => void> = [
      (value) => { value.messages[0].content = [{ kind: "image", uri: "https://example.test/a", detail: "auto" }]; },
      (value) => { value.messages[0].content = [{ kind: "file", uri: "https://example.test/a" }]; },
      (value) => { value.extra = true; },
      (value) => { value.version = "osnv.agent-execution-state/v2"; },
      (value) => { value.phase = "ready-model"; value.pendingToolBatch = { step: 1, responseIndex: 0, assistantMessageIndex: 1, nextToolIndex: 2 }; },
      (value) => { value.phase = "terminal"; value.pendingToolBatch = null; value.terminal = { status: "completed", finalMessage: null, hasOutput: false, output: { leaked: true }, error: null }; },
    ];

    for (const mutate of cases) {
      const value = clone(pending());
      mutate(value);
      expect(() => canonicalAgentExecutionCheckpointV1(value)).toThrow(AgentExecutionStateError);
    }
  });

  test("rejects resolved checkpoint temperature above the Agent contract maximum", () => {
    const value = clone(base("ready-model"));
    value.invocation.options.output.temperature = 3;
    expect(() => parseAgentExecutionCheckpointV1(canonical(value))).toThrow(AgentExecutionStateError);
  });

  test("retains only proven unknown Tool prefixes in failed terminal checkpoints", () => {
    const prefix = failedTerminal("AGENT_TOOL_OUTCOME_UNKNOWN") as Record<string, any>;
    const unknown = unknownResult("call-2");
    prefix.messages[3] = toolMessage(unknown);
    prefix.toolResults[1] = unknown;
    expect(() => parseAgentExecutionCheckpointV1(canonical(prefix))).not.toThrow();

    const last = completedBatch();
    last.phase = "terminal";
    last.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: "AGENT_TOOL_OUTCOME_UNKNOWN", message: "failed", details: null } };
    const lastUnknown = unknownResult("call-3");
    last.messages[4] = toolMessage(lastUnknown);
    last.toolResults[2] = lastUnknown;
    expect(() => parseAgentExecutionCheckpointV1(canonical(last))).not.toThrow();
  });

  test("retains classifier-proven rejected provider batches without admitting their IDs", () => {
    const overLimit = rejectedBatch([call("new-1"), call("new-2"), call("new-3")], "AGENT_TOOL_CALL_LIMIT_EXCEEDED");
    expect(() => parseAgentExecutionCheckpointV1(canonical(overLimit))).not.toThrow();

    const duplicate = rejectedBatch([call("same"), call("same")], "AGENT_PROVIDER_RESPONSE_INVALID");
    expect(() => parseAgentExecutionCheckpointV1(canonical(duplicate))).not.toThrow();

    const reused = completedBatch();
    reused.phase = "terminal";
    reused.invocation.options = { ...resolvedOptions(), maxToolCallsPerStep: 3 };
    reused.responses.push({ invocationId: "inv-1", finishReason: "tool-calls", message: null, toolCalls: [call("call-1")], usage: null, metadata: {} });
    reused.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: "AGENT_PROVIDER_RESPONSE_INVALID", message: "reused", details: null } };
    expect(() => parseAgentExecutionCheckpointV1(canonical(reused))).not.toThrow();

    const nonAssistant = rejectedBatch([call("new")], "AGENT_PROVIDER_RESPONSE_INVALID");
    nonAssistant.responses[0].message = message("user", [{ kind: "text", text: "bad role" }]);
    expect(() => parseAgentExecutionCheckpointV1(canonical(nonAssistant))).not.toThrow();
  });

  test("rejects unproven terminal prefixes and rejected provider batches", () => {
    const cases: Array<(value: Record<string, any>) => void> = [
      (value) => { value.phase = "terminal"; value.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: "AGENT_TOOL_OUTCOME_UNKNOWN", message: "missing", details: null } }; },
      (value) => { value.phase = "terminal"; value.terminal = { status: "completed", finalMessage: null, hasOutput: false, output: null, error: null }; },
      (value) => { value.phase = "terminal"; value.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: "AGENT_TOOL_OUTCOME_UNKNOWN", message: "wrong", details: null } }; value.pendingToolBatch.nextToolIndex = 1; },
      (value) => { value.phase = "terminal"; value.terminal = { status: "failed", finalMessage: null, hasOutput: false, output: null, error: { code: "AGENT_TOOL_OUTCOME_UNKNOWN", message: "suffix", details: null } }; value.messages.push(toolMessage(result("call-3"))); value.toolResults.push(result("call-3")); },
    ];
    for (const mutate of cases) {
      const value = clone(pending());
      mutate(value);
      expect(() => canonicalAgentExecutionCheckpointV1(value)).toThrow(AgentExecutionStateError);
    }

    const wrongCode = rejectedBatch([call("a"), call("b"), call("c")], "AGENT_PROVIDER_RESPONSE_INVALID");
    const arbitrary = rejectedBatch([call("a")], "AGENT_PROVIDER_RESPONSE_INVALID");
    const contaminated = rejectedBatch([call("a"), call("b"), call("c")], "AGENT_TOOL_CALL_LIMIT_EXCEEDED"); contaminated.seenToolCallIds = ["a"];
    const missingLimit = rejectedBatch([call("a"), call("b"), call("c")], "AGENT_TOOL_CALL_LIMIT_EXCEEDED"); missingLimit.invocation.options = {};
    const invalidLimit = rejectedBatch([call("a"), call("b"), call("c")], "AGENT_TOOL_CALL_LIMIT_EXCEEDED"); invalidLimit.invocation.options.maxToolCallsPerStep = 0;
    for (const value of [wrongCode, arbitrary, contaminated, missingLimit, invalidLimit]) {
      expect(() => canonicalAgentExecutionCheckpointV1(value)).toThrow(AgentExecutionStateError);
    }
  });
});
