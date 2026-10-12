import { expect, test } from "bun:test";
import { DiError, Module, createContainer, scoped } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import type { LogFields, Logger } from "@/core/kernel/logging/Logger";
import { Infra, llmConnect } from "@/core/infra";
import { startTestApp } from "@/core/testing";
import {
  AgentRuntime,
  Tool,
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelRequest,
  type AgentToolAuditEntry,
  type AgentToolEnforcementDecisionV1,
} from "../index";

class MemoryLogger implements Logger {
  readonly errors: { message: string; fields?: LogFields }[] = [];
  debug() {}
  info() {}
  warn() {}
  error(message: string, fields?: LogFields) { this.errors.push({ message, fields }); }
}

@Tool({ name: "orders.cancel", description: "Cancels an order.", sideEffect: "write" })
class CancelTool { execute() { return { cancelled: true }; } }

class LimitHook {
  enforce(): AgentToolEnforcementDecisionV1 {
    return { decision: "deny", reasonCode: "ORDER_LIMIT", message: "Заказы дороже 1000 отменяет менеджер", evidence: { total: 1500 } };
  }
}
class SilentDenyHook { enforce(): AgentToolEnforcementDecisionV1 { return { decision: "deny" }; } }
class CrashingEnforcementHook { enforce(): never { throw new Error("policy store at 10.0.0.9 down, token=abc"); } }
class CrashingObserver { observe(): never { throw new Error("metrics backend down"); } }

function cancelOnce(requests: AgentModelRequest[]): AgentModelProvider {
  return {
    complete(request) {
      requests.push(request);
      return requests.length === 1
        ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "c1", name: "orders.cancel", input: {} })] })
        : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "ok") });
    },
  };
}

async function runWith(hooks: NonNullable<Parameters<typeof Module>[0]["agentToolHooks"]>) {
  @Module({ tools: [CancelTool], providers: [scoped(CancelTool)], agentToolHooks: hooks })
  class OrdersModule {}
  const container = createContainer(OrdersModule);
  const audit: AgentToolAuditEntry[] = [];
  const logger = new MemoryLogger();
  const requests: AgentModelRequest[] = [];
  try {
    const runtime = new AgentRuntime(container, cancelOnce(requests), {
      logger,
      toolExecutorOptions: { auditSink: (entry) => { audit.push(entry); }, approvalPolicy: () => true },
    });
    const result = await runtime.run({ name: "operator", instructions: "", toolNames: ["orders.cancel"] }, { input: "cancel" });
    return { result, audit, logger };
  } finally {
    await container.dispose();
  }
}

test("a hook's deny message and reason code reach the model and the audit", async () => {
  const { result, audit } = await runWith([{ kind: "enforcement", id: "orders.limit", version: 1, handler: LimitHook }]);
  expect(result.toolResults[0]).toMatchObject({
    status: "denied",
    error: { code: "TOOL_HOOK_DENIED", message: "Заказы дороже 1000 отменяет менеджер", details: { reasonCode: "ORDER_LIMIT" } },
  });
  expect(audit.find((entry) => entry.phase === "enforcement")?.hook).toMatchObject({
    outcome: "denied", reasonCode: "ORDER_LIMIT", message: "Заказы дороже 1000 отменяет менеджер", evidence: { total: 1500 },
  });
});

test("a deny without a message keeps the generic text", async () => {
  const { result } = await runWith([{ kind: "enforcement", id: "silent", version: 1, handler: SilentDenyHook }]);
  expect(result.toolResults[0]?.error).toEqual({ code: "TOOL_HOOK_DENIED", message: "Tool execution was denied by an enforcement hook.", details: {} });
});

test("hook failures go to the log with the error; the model sees no internals", async () => {
  const { result, logger } = await runWith([
    { kind: "enforcement", id: "policy", version: 2, handler: CrashingEnforcementHook },
  ]);
  expect(result.toolResults[0]?.error).toMatchObject({ code: "TOOL_HOOK_FAILED", message: "Agent Tool enforcement hook failed." });
  expect(JSON.stringify(result)).not.toContain("10.0.0.9");
  expect(logger.errors).toHaveLength(1);
  expect(logger.errors[0]).toMatchObject({
    message: "Agent tool hook failed",
    fields: { hook: "enforcement:policy@2", outcome: "failed", agent: "operator", tool: "orders.cancel", callId: "c1" },
  });
  const error = logger.errors[0]?.fields?.error as { message: string; stack: string };
  expect(error.message).toBe("policy store at 10.0.0.9 down, token=***");
  expect(error.stack).toContain("agent.hook-failures.test.ts");

  const observed = await runWith([{ kind: "observer", id: "metrics", version: 1, handler: CrashingObserver }]);
  expect(observed.result.toolResults[0]?.status).toBe("success");
  expect(observed.logger.errors[0]).toMatchObject({ message: "Agent tool hook failed", fields: { hook: "observer:metrics@1", outcome: "failed", tool: "orders.cancel" } });
  expect((observed.logger.errors[0]?.fields?.error as { message: string }).message).toBe("metrics backend down");
});

test("an AgentRuntime that cannot be built stops the application at start", async () => {
  const llmConfig = defineConfig("llm", { default: { provider: "script", model: "m", baseUrl: "https://llm.internal", apiKey: secret("k") } });
  @Infra({ llm: llmConnect(llmConfig, { create: () => cancelOnce([]) }) })
  class AppInfra {}
  // Enforcement hooks need an audit sink, and no AGENT_RUNTIME_OPTIONS gives one.
  @Module({ tools: [CancelTool], providers: [scoped(CancelTool)], agentToolHooks: [{ kind: "enforcement", id: "orders.limit", version: 1, handler: LimitHook }] })
  class AppModule {}
  const started = startTestApp(AppModule, { infra: AppInfra, http: false });
  await expect(started).rejects.toBeInstanceOf(DiError);
  await expect(started).rejects.toThrow("AgentRuntime: Agent Tool enforcement and settlement hooks require constructor auditSink.");
});
