import { expect, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import {
  Agent,
  AgentRegistry,
  AgentToolExecutor,
  Tool,
  agentToolCall,
  type AgentToolExecutionContext,
  type AgentToolSettlementEventV1,
} from "../index";

@Tool({ name: "audit.lifecycle.read", description: "Audit lifecycle fixture.", sideEffect: "read" })
class AuditLifecycleReadTool {
  execute(_input: unknown, _context: AgentToolExecutionContext): unknown { return { ok: true }; }
}

@Agent({ name: "audit-lifecycle-agent", tools: [AuditLifecycleReadTool] })
class AuditLifecycleAgent {}

class AuditLifecycleSettlementHook {
  settle(_event: AgentToolSettlementEventV1): { readonly status: "recorded" } { return { status: "recorded" }; }
}

@Module({
  agents: [AuditLifecycleAgent],
  tools: [AuditLifecycleReadTool],
  providers: [scoped(AuditLifecycleReadTool)],
  agentToolHooks: [{ kind: "settlement", id: "audit.lifecycle.settlement", version: 1, timeoutMs: 10, handler: AuditLifecycleSettlementHook }],
})
class AuditLifecycleModule {}

async function settles<T>(pending: Promise<T>, timeoutMs = 80): Promise<T | undefined> {
  return Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))]);
}

test("bounds approval and attempt audit before mandatory settlement", async () => {
  const approvalContainer = createContainer(AuditLifecycleModule);
  const approvalExecutor = new AgentToolExecutor(approvalContainer, AgentRegistry.fromModules([AuditLifecycleModule]), {
    defaultTimeoutMs: 5,
    auditSink: () => undefined,
    approvalPolicy: () => new Promise<boolean>(() => undefined),
  });
  try {
    expect(await settles(approvalExecutor.execute(agentToolCall({ id: "approval-timeout", name: "audit.lifecycle.read" }), { agentName: "audit-lifecycle-agent" }))).toBeDefined();
  } finally { await approvalContainer.dispose(); }

  const attemptContainer = createContainer(AuditLifecycleModule);
  const attemptExecutor = new AgentToolExecutor(attemptContainer, AgentRegistry.fromModules([AuditLifecycleModule]), {
    defaultTimeoutMs: 5,
    auditSink: (entry) => entry.phase === "attempt" ? new Promise<void>(() => undefined) : undefined,
  });
  try {
    expect(await settles(attemptExecutor.execute(agentToolCall({ id: "attempt-timeout", name: "audit.lifecycle.read" }), { agentName: "audit-lifecycle-agent" }))).toBeDefined();
  } finally { await attemptContainer.dispose(); }
});

test("bounds mandatory settlement evidence for deadline and caller cancellation", async () => {
  const deadlineContainer = createContainer(AuditLifecycleModule);
  const deadlineExecutor = new AgentToolExecutor(deadlineContainer, AgentRegistry.fromModules([AuditLifecycleModule]), {
    defaultTimeoutMs: 25,
    auditSink: (entry) => entry.phase === "settlement" ? new Promise<void>(() => undefined) : undefined,
  });
  try {
    expect(await settles(deadlineExecutor.execute(agentToolCall({ id: "settlement-timeout", name: "audit.lifecycle.read" }), { agentName: "audit-lifecycle-agent" }), 100)).toBeDefined();
  } finally { await deadlineContainer.dispose(); }

  let mark!: () => void;
  const enteredSettlement = new Promise<void>((resolve) => { mark = resolve; });
  const cancellationContainer = createContainer(AuditLifecycleModule);
  const cancellationExecutor = new AgentToolExecutor(cancellationContainer, AgentRegistry.fromModules([AuditLifecycleModule]), {
    defaultTimeoutMs: 0,
    auditSink: (entry) => {
      if (entry.phase === "settlement") {
        mark();
        return new Promise<void>(() => undefined);
      }
    },
  });
  const controller = new AbortController();
  try {
    const pending = cancellationExecutor.execute(agentToolCall({ id: "settlement-cancel", name: "audit.lifecycle.read" }), { agentName: "audit-lifecycle-agent", signal: controller.signal });
    await enteredSettlement;
    controller.abort();
    expect(await settles(pending)).toBeDefined();
  } finally { await cancellationContainer.dispose(); }
});

class FrameworkTerminalSettlementHook {
  settle(_event: AgentToolSettlementEventV1): { readonly status: "recorded" } { return { status: "recorded" }; }
}

function frameworkTerminalFixture(entered: () => void): { readonly container: ReturnType<typeof createContainer>; readonly executor: AgentToolExecutor } {
  @Module({ agentToolHooks: [{ kind: "settlement", id: "framework.lifecycle.settlement", version: 1, timeoutMs: 20, handler: FrameworkTerminalSettlementHook }] })
  class FrameworkTerminalModule {}
  const container = createContainer(FrameworkTerminalModule);
  return Object.freeze({
    container,
    executor: new AgentToolExecutor(container, AgentRegistry.fromModules([FrameworkTerminalModule]), {
      defaultTimeoutMs: 0,
      auditSink: () => { entered(); return new Promise<void>(() => undefined); },
    }),
  });
}

for (const operation of ["unknown", "malformed"] as const) {
  test(`bounds framework terminal audit timeout for ${operation} calls`, async () => {
    let mark!: () => void;
    const entered = new Promise<void>((resolve) => { mark = resolve; });
    const current = frameworkTerminalFixture(mark);
    try {
      const pending = operation === "unknown"
        ? current.executor.execute(agentToolCall({ id: "framework-timeout", name: "not.registered" }), { timeoutMs: 10 })
        : current.executor.execute({ not: "a tool call" } as never, { timeoutMs: 10 });
      await entered;
      expect(await settles(pending)).toBeDefined();
    } finally { await current.container.dispose(); }
  });

  test(`bounds framework terminal audit caller cancellation for ${operation} calls`, async () => {
    let mark!: () => void;
    const entered = new Promise<void>((resolve) => { mark = resolve; });
    const current = frameworkTerminalFixture(mark);
    const controller = new AbortController();
    try {
      const pending = operation === "unknown"
        ? current.executor.execute(agentToolCall({ id: "framework-cancel", name: "not.registered" }), { signal: controller.signal })
        : current.executor.execute({ not: "a tool call" } as never, { signal: controller.signal });
      await entered;
      controller.abort();
      expect(await settles(pending)).toBeDefined();
    } finally { await current.container.dispose(); }
  });
}
