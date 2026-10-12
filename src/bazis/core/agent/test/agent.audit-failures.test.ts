import { expect, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import type { LogFields, Logger } from "@/core/kernel/logging/Logger";
import {
  AgentRuntime,
  Tool,
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelRequest,
  type AgentToolExecutorOptions,
} from "../index";

class MemoryLogger implements Logger {
  readonly errors: { message: string; fields?: LogFields }[] = [];
  debug() {}
  info() {}
  warn() {}
  error(message: string, fields?: LogFields) { this.errors.push({ message, fields }); }
}

let charges = 0;
@Tool({ name: "pay.charge", description: "Charges a card.", sideEffect: "external" })
class ChargeTool { execute() { charges++; return { charged: true }; } }

class AllowHook { enforce() { return { decision: "allow" as const }; } }

function callOnce(requests: AgentModelRequest[]): AgentModelProvider {
  return {
    complete(request) {
      requests.push(request);
      return requests.length === 1
        ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "c1", name: "pay.charge", input: { amount: 10 } })] })
        : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "ok") });
    },
  };
}

const brokenSink = () => { throw new Error("audit db 10.0.0.7 down, password=hunter2"); };

async function charge(toolExecutorOptions: AgentToolExecutorOptions, hooks = false) {
  @Module({
    tools: [ChargeTool], providers: [scoped(ChargeTool)],
    ...(hooks ? { agentToolHooks: [{ kind: "enforcement" as const, id: "guard", version: 1, handler: AllowHook }] } : {}),
  })
  class PayModule {}
  const container = createContainer(PayModule);
  const logger = new MemoryLogger();
  charges = 0;
  try {
    const runtime = new AgentRuntime(container, callOnce([]), { logger, toolExecutorOptions: { approvalPolicy: () => true, ...toolExecutorOptions } });
    const result = await runtime.run({ name: "cashier", instructions: "", toolNames: ["pay.charge"] }, { input: "pay" });
    return { result, logger, charges };
  } finally {
    await container.dispose();
  }
}

test("fail-closed: the model gets no audit internals and the failure is logged", async () => {
  const { result, logger, charges } = await charge({ auditSink: brokenSink });
  expect(charges).toBe(0);
  expect(result.toolResults[0]?.error).toMatchObject({ code: "TOOL_AUDIT_FAILED", message: "Tool audit failed." });
  expect(JSON.stringify(result)).not.toContain("10.0.0.7");
  expect(logger.errors[0]).toMatchObject({
    message: "Agent tool audit failed",
    fields: { phase: "attempt", mode: "fail-closed", agent: "cashier", tool: "pay.charge", callId: "c1" },
  });
  const error = logger.errors[0]?.fields?.error as { message: string; stack: string };
  expect(error.message).toBe("audit db 10.0.0.7 down, password=***");
  expect(error.stack).toContain("agent.audit-failures.test.ts");
});

test("best-effort: the call goes on and every lost entry is logged", async () => {
  const { result, logger, charges } = await charge({ auditSink: brokenSink, auditFailureMode: "best-effort" });
  expect(charges).toBe(1);
  expect(result.toolResults[0]?.status).toBe("success");
  expect(logger.errors.map((entry) => [entry.message, entry.fields?.phase, entry.fields?.mode])).toEqual([
    ["Agent tool audit failed", "attempt", "best-effort"],
    ["Agent tool audit failed", "result", "best-effort"],
  ]);
});

test("hook evidence that cannot be recorded is logged", async () => {
  const { result, logger, charges } = await charge({ auditSink: brokenSink, auditFailureMode: "best-effort" }, true);
  expect(charges).toBe(0);
  expect(result.toolResults[0]?.error?.code).toBe("TOOL_HOOK_AUDIT_FAILED");
  expect(logger.errors.some((entry) => entry.message === "Agent tool audit failed" && entry.fields?.phase === "enforcement" && entry.fields?.mode === "required")).toBe(true);
});
