import { expect, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import { Agent, AgentRegistry, AgentToolExecutor, Tool, agentToolCall, type AgentToolExecutionContext, type AgentToolSettlementEventV1 } from "../index";

@Tool({ name: "result-boundary.read", description: "read", sideEffect: "read" })
class ReadTool { execute(_input: unknown, _context: AgentToolExecutionContext) { return { ok: true }; } }
@Tool({ name: "result-boundary.write", description: "write", sideEffect: "write" })
class WriteTool { execute(_input: unknown, _context: AgentToolExecutionContext) { return { ok: true }; } }
@Agent({ name: "result-boundary-agent", tools: [ReadTool, WriteTool] }) class BoundaryAgent {}
class Settlement { settle(_event: AgentToolSettlementEventV1) { return { status: "recorded" as const }; } }

async function terminal(pending: Promise<unknown>): Promise<unknown | undefined> {
  return Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 80))]);
}

for (const sideEffect of ["read", "write"] as const) {
  test(`result audit cancellation is bounded for ${sideEffect}`, async () => {
    @Module({ agents: [BoundaryAgent], tools: [ReadTool, WriteTool], providers: [scoped(ReadTool), scoped(WriteTool)], agentToolHooks: [{ kind: "settlement", id: "result-boundary", version: 1, timeoutMs: 20, handler: Settlement }] })
    class BoundaryModule {}
    let entered!: () => void;
    const enteredResult = new Promise<void>((resolve) => { entered = resolve; });
    const container = createContainer(BoundaryModule);
    const executor = new AgentToolExecutor(container, AgentRegistry.fromModules([BoundaryModule]), { defaultTimeoutMs: 0, approvalPolicy: () => true, auditSink: (entry) => entry.phase === "result" ? (entered(), new Promise<void>(() => undefined)) : undefined });
    const controller = new AbortController();
    try {
      const pending = executor.execute(agentToolCall({ id: `result-${sideEffect}`, name: `result-boundary.${sideEffect}` }), { agentName: "result-boundary-agent", signal: controller.signal });
      await enteredResult;
      controller.abort();
      const result = await terminal(pending) as { readonly error?: { readonly code?: string } } | undefined;
      expect(result?.error?.code).toBe(sideEffect === "write" ? "TOOL_ABORTED_OUTCOME_UNKNOWN" : "TOOL_ABORTED");
    } finally { await container.dispose(); }
  });
}
