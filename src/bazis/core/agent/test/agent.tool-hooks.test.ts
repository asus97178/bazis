import { describe, expect, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import {
  Agent,
  AgentRegistry,
  AgentSetupError,
  AgentToolExecutor,
  Tool,
  agentToolCall,
  type AgentToolAuditEntry,
  type AgentToolEnforcementDecisionV1,
  type AgentToolExecutionContext,
  type AgentToolObserverEventV1,
  type AgentToolSettlementEventV1,
} from "../index";

const AGENT = "hook-matrix-agent";
const SECRET = "hook-matrix-raw-secret";

type EnforcementAction = (tier: "platform" | "application", context: { readonly signal: AbortSignal }) => unknown;
type HookContext = { readonly signal: AbortSignal; readonly deadlineUnixMs: number };

const state = {
  toolConstructed: 0,
  toolExecuted: 0,
  policyConstructed: 0,
  settlements: [] as AgentToolSettlementEventV1[],
  observerCalls: 0,
  order: [] as string[],
  evidence: [] as AgentToolAuditEntry[],
  enforcementSignals: [] as AbortSignal[],
  settlementContexts: [] as HookContext[],
  observerContexts: [] as HookContext[],
  policyConstruct: (_tier: "platform" | "application"): void => undefined,
  policyDispose: (_tier: "platform" | "application"): void => undefined,
  settlementDispose: (): void => undefined,
  observerDispose: (): void => undefined,
  constructorAudit: (entry: AgentToolAuditEntry): void => { state.evidence.push(entry); },
  enforcement: (_tier: "platform" | "application", _context: { readonly signal: AbortSignal }): unknown => ({ decision: "allow" }),
  settle: (_event: AgentToolSettlementEventV1, _context: HookContext): unknown => ({ status: "recorded" }),
  observe: (_event: AgentToolObserverEventV1, _context: HookContext): unknown => undefined,
  tool: (_context: AgentToolExecutionContext): unknown => ({ ok: true }),
};

function reset(): void {
  state.toolConstructed = 0;
  state.toolExecuted = 0;
  state.policyConstructed = 0;
  state.settlements.length = 0;
  state.observerCalls = 0;
  state.order.length = 0;
  state.evidence.length = 0;
  state.enforcementSignals.length = 0;
  state.settlementContexts.length = 0;
  state.observerContexts.length = 0;
  state.policyConstruct = () => undefined;
  state.policyDispose = () => undefined;
  state.settlementDispose = () => undefined;
  state.observerDispose = () => undefined;
  state.constructorAudit = (entry) => { state.evidence.push(entry); };
  state.enforcement = () => ({ decision: "allow" });
  state.settle = () => ({ status: "recorded" });
  state.observe = () => undefined;
  state.tool = () => ({ ok: true });
}

function never<T>(): Promise<T> { return new Promise<T>(() => undefined); }

@Tool({ name: "hook.matrix", description: "Focused Agent Tool Hook dispatcher fixture.", sideEffect: "read" })
class HookMatrixTool {
  public constructor() { state.toolConstructed += 1; }
  public execute(_input: unknown, context: AgentToolExecutionContext): unknown {
    state.toolExecuted += 1;
    return state.tool(context);
  }
}

@Tool({ name: "hook.matrix.write", description: "Focused committed-write fixture.", sideEffect: "write" })
class HookMatrixWriteTool {
  public constructor() { state.toolConstructed += 1; }
  public execute(_input: unknown, context: AgentToolExecutionContext): unknown {
    state.toolExecuted += 1;
    return state.tool(context);
  }
}

class HookMatrixInput { public value = ""; }

@Tool({ name: "hook.matrix.schema", description: "Focused schema gate fixture.", input: HookMatrixInput, sideEffect: "read" })
class HookMatrixSchemaTool {
  public constructor() { state.toolConstructed += 1; }
  public execute(_input: unknown, context: AgentToolExecutionContext): unknown {
    state.toolExecuted += 1;
    return state.tool(context);
  }
}

@Agent({ name: AGENT, tools: [HookMatrixTool, HookMatrixWriteTool, HookMatrixSchemaTool] })
class HookMatrixAgent {}

class PlatformHook {
  public constructor() { state.policyConstructed += 1; state.policyConstruct("platform"); }
  public dispose(): void { state.policyDispose("platform"); }
  public enforce(_event: unknown, context: { readonly signal: AbortSignal }): AgentToolEnforcementDecisionV1 {
    state.order.push("platform");
    state.enforcementSignals.push(context.signal);
    return state.enforcement("platform", context) as AgentToolEnforcementDecisionV1;
  }
}

class ApplicationHook {
  public constructor() { state.policyConstructed += 1; state.policyConstruct("application"); }
  public dispose(): void { state.policyDispose("application"); }
  public enforce(_event: unknown, context: { readonly signal: AbortSignal }): AgentToolEnforcementDecisionV1 {
    state.order.push("application");
    state.enforcementSignals.push(context.signal);
    return state.enforcement("application", context) as AgentToolEnforcementDecisionV1;
  }
}

class SettlementHook {
  public dispose(): void { state.settlementDispose(); }
  public settle(event: AgentToolSettlementEventV1, context: HookContext): { readonly status: "recorded" } {
    state.settlements.push(event);
    state.settlementContexts.push(context);
    return state.settle(event, context) as { readonly status: "recorded" };
  }
}

class ObserverHook {
  public dispose(): void { state.observerDispose(); }
  public observe(event: AgentToolObserverEventV1, context: HookContext): void | Promise<void> { state.observerCalls += 1; state.observerContexts.push(context); return state.observe(event, context) as void | Promise<void>; }
}

function createHarness(options: ConstructorParameters<typeof AgentToolExecutor>[2] = {}) {
  @Module({
    agents: [HookMatrixAgent],
    tools: [HookMatrixTool, HookMatrixWriteTool, HookMatrixSchemaTool],
    providers: [scoped(HookMatrixTool), scoped(HookMatrixWriteTool), scoped(HookMatrixSchemaTool)],
    agentToolHooks: [
      { kind: "enforcement", id: "operator.platform", version: 1, order: 1, timeoutMs: 25, handler: PlatformHook },
      { kind: "enforcement", id: "application.policy", version: 1, order: 1, timeoutMs: 25, handler: ApplicationHook },
      { kind: "settlement", id: "operator.settlement", version: 1, timeoutMs: 25, handler: SettlementHook },
      { kind: "observer", id: "application.observer", version: 1, timeoutMs: 25, handler: ObserverHook },
    ],
  })
  class HookMatrixModule {}

  const container = createContainer(HookMatrixModule);
  const executor = new AgentToolExecutor(container, AgentRegistry.fromModules([HookMatrixModule]), {
    auditSink: (entry) => state.constructorAudit(entry),
    requiredPlatformHooks: [{ owner: HookMatrixModule, kind: "enforcement", id: "operator.platform", version: 1 }],
    ...options,
  });
  return { container, executor };
}

async function execute(
  options: Parameters<AgentToolExecutor["execute"]>[1] = { agentName: AGENT },
  executorOptions: ConstructorParameters<typeof AgentToolExecutor>[2] = {},
  name = "hook.matrix",
) {
  const harness = createHarness(executorOptions);
  const result = await harness.executor.execute(agentToolCall({
    id: "hook-matrix-call",
    name,
    input: { password: SECRET, nested: { apiKey: SECRET } },
    metadata: { authorization: SECRET },
  }), options);
  return { ...harness, result };
}

function expectNoTool(): void {
  expect(state.toolConstructed).toBe(0);
  expect(state.toolExecuted).toBe(0);
}

describe("Agent Tool Hooks dispatcher", () => {
  test("runs the platform ceiling before application and a deny cannot be overridden", async () => {
    reset();
    state.enforcement = (tier) => tier === "platform"
      ? { decision: "deny", reasonCode: "OPERATOR_DENY", evidence: { token: SECRET } }
      : { decision: "allow" };
    const { container, result } = await execute();
    try {
      expect(result.error?.code).toBe("TOOL_HOOK_DENIED");
      expect(state.order).toEqual(["platform"]);
      expect(state.policyConstructed).toBe(1);
      expectNoTool();
      expect(state.settlements).toHaveLength(1);
      expect(state.evidence.filter((entry) => entry.phase === "enforcement" || entry.phase === "settlement")).toHaveLength(2);
    } finally { await container.dispose(); }
  });

  test("settles exactly once without Tool activation for every admitted pre-effect hook terminal", async () => {
    const cases: ReadonlyArray<readonly [string, EnforcementAction, string]> = [
      ["deny", () => ({ decision: "deny" }), "TOOL_HOOK_DENIED"],
      ["throw", () => { throw new Error(SECRET); }, "TOOL_HOOK_FAILED"],
      ["reject", () => Promise.reject(new Error(SECRET)), "TOOL_HOOK_FAILED"],
      ["timeout", () => never(), "TOOL_HOOK_TIMEOUT"],
      ["invalid", () => ({ decision: "rewrite" }), "TOOL_HOOK_DECISION_INVALID"],
    ];
    for (const [name, action, code] of cases) {
      reset();
      state.enforcement = (tier, context) => tier === "platform" ? action(tier, context) : { decision: "allow" };
      const { container, result } = await execute({ agentName: AGENT });
      try {
        expect(result.error?.code, name).toBe(code);
        expectNoTool();
        expect(state.settlements, name).toHaveLength(1);
        expect(state.observerCalls, name).toBe(1);
      } finally { await container.dispose(); }
    }
  });

  test("propagates caller cancellation to enforcement, while timeoutMs: 0 cannot disable its positive hook deadline", async () => {
    reset();
    let entered: (() => void) | undefined;
    const enteredPolicy = new Promise<void>((resolve) => { entered = resolve; });
    state.enforcement = (tier) => {
      if (tier === "platform") entered?.();
      return never();
    };
    const controller = new AbortController();
    const harness = createHarness();
    try {
      const pending = harness.executor.execute(agentToolCall({ id: "cancel", name: "hook.matrix" }), { agentName: AGENT, signal: controller.signal });
      await enteredPolicy;
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.error?.code).toBe("TOOL_HOOK_CANCELLED");
      expectNoTool();
      expect(state.settlements).toHaveLength(1);
    } finally { await harness.container.dispose(); }

    reset();
    state.enforcement = (tier) => tier === "platform" ? never() : { decision: "allow" };
    const zero = await execute({ agentName: AGENT, timeoutMs: 0 });
    try {
      expect(zero.result.error?.code).toBe("TOOL_HOOK_TIMEOUT");
      expectNoTool();
      expect(state.settlements).toHaveLength(1);
    } finally { await zero.container.dispose(); }
  });

  test("fails closed for non-JSON, unsafe and malformed decisions, with a single settlement", async () => {
    const cycle: Record<string, unknown> = { decision: "allow" };
    cycle.self = cycle;
    const throwingEvidence = { decision: "allow", get evidence(): unknown { throw new Error(SECRET); } };
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["unknown-key", { decision: "allow", unexpected: true }],
      ["function", () => undefined],
      ["promise", { decision: "allow", evidence: { value: Promise.resolve("nope") } }],
      ["cycle", cycle],
      ["throwing-getter", throwingEvidence],
      ["oversize", { decision: "allow", evidence: { value: "x".repeat(100_001) } }],
      ["forbidden-key", JSON.parse('{"decision":"allow","evidence":{"__proto__":"x"}}')],
    ];
    for (const [name, decision] of cases) {
      reset();
      state.enforcement = (tier) => tier === "platform" ? decision : { decision: "allow" };
      const { container, result } = await execute();
      try {
        expect(result.error?.code, name).toBe("TOOL_HOOK_DECISION_INVALID");
        expectNoTool();
        expect(state.settlements, name).toHaveLength(1);
      } finally { await container.dispose(); }
    }
  });

  test("does not permit constructor or per-call mandatory-evidence bypass and never leaks raw hook secrets", async () => {
    reset();
    expect(() => createHarness({ auditSink: undefined })).toThrow(AgentSetupError);
    const { container, result } = await execute({
      agentName: AGENT,
      allowUnauditedSideEffects: true,
      auditFailureMode: "best-effort",
      auditRedaction: false,
      auditSink: () => { throw new Error("per-call replacement must not run"); },
    }, { auditRedaction: false });
    try {
      expect(result.status).toBe("success");
      const mandatory = state.evidence.filter((entry) => entry.phase === "enforcement" || entry.phase === "settlement");
      expect(mandatory).toHaveLength(3);
      expect(JSON.stringify(mandatory)).not.toContain(SECRET);
      expect(state.toolExecuted).toBe(1);
    } finally { await container.dispose(); }
  });

  test("does not accept a same-name module lookalike as the pinned platform owner", () => {
    reset();
    @Module({ agentToolHooks: [{ kind: "enforcement", id: "operator.platform", version: 1, handler: PlatformHook }] })
    class ActualOwner {}
    @Module({})
    class LookalikeOwner {}
    Object.defineProperty(LookalikeOwner, "name", { value: ActualOwner.name });
    @Module({ imports: [ActualOwner, LookalikeOwner] })
    class Root {}
    const container = createContainer(Root);
    try {
      expect(() => new AgentToolExecutor(container, AgentRegistry.fromModules([Root]), {
        auditSink: () => undefined,
        requiredPlatformHooks: [{ owner: LookalikeOwner, kind: "enforcement", id: "operator.platform", version: 1 }],
      })).toThrow(AgentSetupError);
    } finally { void container.dispose(); }
  });

  test("keeps settlement failure known before effect, unknown after effect, observer best-effort, and re-enforces permitted retry", async () => {
    reset();
    state.settle = () => { throw new Error("settlement down"); };
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    const known = await execute();
    try {
      expect(known.result.error?.code).toBe("TOOL_HOOK_SETTLEMENT_FAILED");
      expectNoTool();
    } finally { await known.container.dispose(); }

    reset();
    state.settle = () => { throw new Error("settlement down"); };
    const unknown = await execute({ agentName: AGENT }, { approvalPolicy: () => true }, "hook.matrix.write");
    try {
      expect(unknown.result.error?.code).toBe("TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN");
      expect(state.toolExecuted).toBe(1);
    } finally { await unknown.container.dispose(); }

    reset();
    let attempts = 0;
    state.tool = () => { attempts += 1; if (attempts === 1) throw new Error("retry"); return { ok: true }; };
    state.observe = () => { throw new Error("observer unavailable"); };
    const retried = await execute({ agentName: AGENT, retryPolicy: { maxAttempts: 2, retryOnErrorCodes: ["TOOL_EXECUTION_FAILED"] } });
    try {
      expect(retried.result.status).toBe("success");
      expect(state.toolExecuted).toBe(2);
      expect(state.order).toEqual(["platform", "application", "platform", "application"]);
      expect(state.settlements).toHaveLength(2);
      expect(state.observerCalls).toBe(2);
    } finally { await retried.container.dispose(); }
  });

  test("settles and records mandatory terminal evidence exactly once for admitted terminals before policy", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cases: ReadonlyArray<readonly [string, string, Parameters<AgentToolExecutor["execute"]>[1], ConstructorParameters<typeof AgentToolExecutor>[2], unknown]> = [
      ["agent-required", "hook.matrix", {}, {}, {}],
      ["schema-validator-missing", "hook.matrix.schema", { agentName: AGENT }, {}, { value: "ok" }],
      ["input-invalid", "hook.matrix.schema", { agentName: AGENT, schemaValidator: { validate: () => ({ isValid: false, errors: [] }) } }, {}, { value: "bad" }],
      ["approval-required", "hook.matrix.write", { agentName: AGENT }, {}, {}],
      ["approval-denied", "hook.matrix.write", { agentName: AGENT, approvalPolicy: () => false }, {}, {}],
      ["approval-fault", "hook.matrix.write", { agentName: AGENT, approvalPolicy: () => { throw new Error("approval offline"); } }, {}, {}],
      ["retry-idempotency", "hook.matrix.write", { agentName: AGENT, approvalPolicy: () => true, retryPolicy: { maxAttempts: 2 } }, {}, {}],
      ["already-aborted", "hook.matrix", { agentName: AGENT, signal: aborted.signal }, {}, {}],
      ["pre-policy-deadline", "hook.matrix.schema", { agentName: AGENT, schemaValidator: { validate: () => never() } }, { defaultTimeoutMs: 1 }, { value: "slow" }],
    ];
    for (const [name, toolName, options, executorOptions, input] of cases) {
      reset();
      const harness = createHarness(executorOptions);
      try {
        const result = await harness.executor.execute(agentToolCall({ id: `pre-${name}`, name: toolName, input }), options);
        expect(result.status, name).not.toBe("success");
        expectNoTool();
        expect(state.policyConstructed, name).toBe(0);
        expect(state.settlements, name).toHaveLength(1);
        expect(state.evidence.filter((entry) => entry.phase === "settlement"), name).toHaveLength(1);
      } finally { await harness.container.dispose(); }
    }
  });

  test("rejects invalid settlement evidence and never lets a caller retry a post-write settlement-unknown outcome", async () => {
    reset();
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    state.settle = () => ({ status: "recorded", evidence: { value: Promise.resolve("not-json") } });
    const invalid = await execute();
    try {
      expect(invalid.result.error?.code).toBe("TOOL_HOOK_SETTLEMENT_FAILED");
      expectNoTool();
      expect(state.settlements).toHaveLength(1);
    } finally { await invalid.container.dispose(); }

    reset();
    state.settle = () => { throw new Error("settlement unavailable"); };
    const unknown = await execute({
      agentName: AGENT,
      retryPolicy: { maxAttempts: 2, retryOnErrorCodes: ["TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN"] },
    }, { approvalPolicy: () => true }, "hook.matrix.write");
    try {
      expect(unknown.result.error?.code).toBe("TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN");
      expect(state.toolExecuted).toBe(1);
      expect(state.settlements).toHaveLength(1);
    } finally { await unknown.container.dispose(); }
  });

  test("gives observers only redacted terminal output while legacy audit redaction is disabled", async () => {
    reset();
    let observed: AgentToolObserverEventV1 | undefined;
    state.tool = () => ({ outputSecret: SECRET });
    state.observe = (event) => { observed = event; };
    const result = await execute({ agentName: AGENT, auditRedaction: false }, { auditRedaction: false });
    try {
      expect(result.result.status).toBe("success");
      expect(observed).toBeDefined();
      expect(JSON.stringify(observed)).not.toContain(SECRET);
      expect(JSON.stringify(state.evidence.filter((entry) => entry.phase === "enforcement" || entry.phase === "settlement"))).not.toContain(SECRET);
    } finally { await result.container.dispose(); }
  });

  test("excludes malformed and unregistered calls, and gives agentName and allowUnboundTools equivalent hook traces", async () => {
    reset();
    const { container, executor } = createHarness();
    try {
      const malformed = await executor.execute({ id: "x", name: "hook.matrix", input: { get value(): unknown { throw new Error(SECRET); } } } as never);
      const unregistered = await executor.execute(agentToolCall({ id: "x", name: "missing.tool" }), { agentName: AGENT });
      expect(malformed.error?.code).toBe("TOOL_CALL_INVALID");
      expect(unregistered.error?.code).toBe("TOOL_NOT_REGISTERED");
      expect(state.settlements).toHaveLength(0);

      reset();
      const named = await executor.execute(agentToolCall({ id: "named", name: "hook.matrix" }), { agentName: AGENT });
      const namedTrace = [...state.order];
      reset();
      const unbound = await executor.execute(agentToolCall({ id: "unbound", name: "hook.matrix" }), { allowUnboundTools: true });
      expect(named.status).toBe("success");
      expect(unbound.status).toBe("success");
      expect(state.order).toEqual(namedTrace);
      expect(state.settlements).toHaveLength(1);
    } finally { await container.dispose(); }
  });

  test("records exactly one mandatory enforcement outcome after every failed enforcement terminal", async () => {
    const cases: ReadonlyArray<readonly [string, () => void, string, NonNullable<AgentToolAuditEntry["hook"]>["outcome"]]> = [
      ["activation", () => { state.policyConstruct = (tier) => { if (tier === "platform") throw new Error("activation unavailable"); }; }, "TOOL_HOOK_UNAVAILABLE", "failed"],
      ["fault", () => { state.enforcement = (tier) => tier === "platform" ? (() => { throw new Error(SECRET); })() : { decision: "allow" }; }, "TOOL_HOOK_FAILED", "failed"],
      ["timeout", () => { state.enforcement = (tier) => tier === "platform" ? never() : { decision: "allow" }; }, "TOOL_HOOK_TIMEOUT", "timed-out"],
      ["invalid", () => { state.enforcement = (tier) => tier === "platform" ? { decision: "rewrite" } : { decision: "allow" }; }, "TOOL_HOOK_DECISION_INVALID", "invalid-result"],
      ["disposal", () => { state.policyDispose = (tier) => { if (tier === "platform") throw new Error("dispose unavailable"); }; }, "TOOL_HOOK_FAILED", "failed"],
    ];
    for (const [name, arrange, code, outcome] of cases) {
      reset();
      arrange();
      const { container, result } = await execute({ agentName: AGENT });
      try {
        expect(result.error?.code, name).toBe(code);
        expectNoTool();
        const enforcement = state.evidence.filter((entry) => entry.phase === "enforcement");
        expect(enforcement, name).toHaveLength(1);
        expect(enforcement[0]?.hook?.outcome, name).toBe(outcome);
        expect(state.evidence.filter((entry) => entry.phase === "settlement"), name).toHaveLength(1);
      } finally { await container.dispose(); }
    }

    reset();
    let entered: (() => void) | undefined;
    const enteredPolicy = new Promise<void>((resolve) => { entered = resolve; });
    state.enforcement = (tier) => tier === "platform" ? (entered?.(), never()) : { decision: "allow" };
    const controller = new AbortController();
    const harness = createHarness();
    try {
      const pending = harness.executor.execute(agentToolCall({ id: "enforcement-cancel", name: "hook.matrix" }), { agentName: AGENT, signal: controller.signal });
      await enteredPolicy;
      controller.abort();
      const result = await pending;
      expect(result.error?.code).toBe("TOOL_HOOK_CANCELLED");
      expect(state.enforcementSignals[0]?.aborted).toBe(true);
      expectNoTool();
      const enforcement = state.evidence.filter((entry) => entry.phase === "enforcement");
      expect(enforcement).toHaveLength(1);
      expect(enforcement[0]?.hook?.outcome).toBe("cancelled");
      expect(state.evidence.filter((entry) => entry.phase === "settlement")).toHaveLength(1);
    } finally { await harness.container.dispose(); }
  });

  test("fails closed with a canonical result when mandatory enforcement evidence sink fails", async () => {
    reset();
    const harness = createHarness({ auditSink: () => { throw new Error("mandatory sink unavailable"); } });
    try {
      const result = await harness.executor.execute(agentToolCall({ id: "mandatory-sink", name: "hook.matrix" }), {
        agentName: AGENT,
        auditSink: () => undefined,
        auditFailureMode: "best-effort",
      });
      expect(result.error?.code).toBe("TOOL_HOOK_AUDIT_FAILED");
      expectNoTool();
    } finally { await harness.container.dispose(); }
  });

  test("records settlement terminals, evidence, deadlines and cancellation without changing observer input", async () => {
    const cases: ReadonlyArray<readonly [string, () => void, NonNullable<AgentToolAuditEntry["hook"]>["outcome"]]> = [
      ["fault", () => { state.settle = () => { throw new Error(SECRET); }; }, "failed"],
      ["timeout", () => { state.settle = () => never(); }, "timed-out"],
      ["invalid", () => { state.settle = () => ({ status: "not-recorded" }); }, "invalid-result"],
      ["disposal", () => { state.settlementDispose = () => { throw new Error("dispose unavailable"); }; }, "failed"],
    ];
    for (const [name, arrange, outcome] of cases) {
      reset();
      state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
      arrange();
      const { container, result } = await execute({ agentName: AGENT });
      try {
        expect(result.error?.code, name).toBe("TOOL_HOOK_SETTLEMENT_FAILED");
        expectNoTool();
        const settlement = state.evidence.filter((entry) => entry.phase === "settlement");
        expect(settlement, name).toHaveLength(1);
        expect(settlement[0]?.hook?.outcome, name).toBe(outcome);
        if (name === "timeout") expect(state.settlementContexts[0]?.signal.aborted).toBe(true);
      } finally { await container.dispose(); }
    }

    reset();
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    state.settle = () => ({ status: "recorded", evidence: { revision: "r1", token: SECRET } });
    const recorded = await execute({ agentName: AGENT, auditRedaction: false }, { auditRedaction: false });
    try {
      const settlement = state.evidence.filter((entry) => entry.phase === "settlement");
      expect(settlement).toHaveLength(1);
      expect(settlement[0]?.hook?.outcome).toBe("recorded");
      expect(settlement[0]?.hook?.evidence).toEqual({ revision: "r1", token: "***" });
      expect(JSON.stringify(settlement)).not.toContain(SECRET);
    } finally { await recorded.container.dispose(); }
  });

  test("forwards caller cancellation into pre-effect settlement", async () => {
    reset();
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    let preEffectEntered: (() => void) | undefined;
    const preEffectReady = new Promise<void>((resolve) => { preEffectEntered = resolve; });
    state.settle = (_event, context) => { preEffectEntered?.(); return never<never>(); };
    const preController = new AbortController();
    const preHarness = createHarness();
    try {
      const pending = preHarness.executor.execute(agentToolCall({ id: "pre-effect-cancel", name: "hook.matrix" }), { agentName: AGENT, signal: preController.signal });
      await preEffectReady;
      preController.abort();
      const result = await pending;
      expect(result.status).not.toBe("success");
      expect(state.settlementContexts[0]?.signal.aborted).toBe(true);
      const settlement = state.evidence.filter((entry) => entry.phase === "settlement");
      expect(settlement).toHaveLength(1);
      expect(settlement[0]?.hook?.outcome).toBe("cancelled");
    } finally { await preHarness.container.dispose(); }

  });

  test("uses the remaining deadline before effect", async () => {
    reset();
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    state.settle = () => ({ status: "recorded" });
    const deadline = createHarness();
    try {
      const deadlineStart = Date.now();
      const result = await deadline.executor.execute(agentToolCall({ id: "remaining-deadline", name: "hook.matrix" }), { agentName: AGENT, timeoutMs: 20 });
      expect(result.error?.code).toBe("TOOL_HOOK_DENIED");
      expect(state.settlementContexts[0]?.deadlineUnixMs).toBeLessThanOrEqual(deadlineStart + 24);
    } finally { await deadline.container.dispose(); }
  });

  test("uses an independent bounded settlement signal after effect start", async () => {
    reset();
    let postEffectEntered: (() => void) | undefined;
    let releaseSettlement: (() => void) | undefined;
    const postEffectReady = new Promise<void>((resolve) => { postEffectEntered = resolve; });
    state.settle = (_event, context) => {
      postEffectEntered?.();
      return new Promise((resolve) => { releaseSettlement = () => resolve({ status: "recorded", evidence: { phase: "post-effect" } }); });
    };
    const postController = new AbortController();
    const postHarness = createHarness();
    try {
      const pending = postHarness.executor.execute(agentToolCall({ id: "post-effect-cancel", name: "hook.matrix.write" }), { agentName: AGENT, approvalPolicy: () => true, signal: postController.signal });
      await postEffectReady;
      postController.abort();
      expect(state.settlementContexts[0]?.signal.aborted).toBe(false);
      releaseSettlement?.();
      const result = await pending;
      expect(result.status).toBe("success");
      expect(state.settlements).toHaveLength(1);
    } finally { await postHarness.container.dispose(); }
  });

  test("records exactly one redacted constructor-owned observer outcome without changing the Tool result", async () => {
    const cases: ReadonlyArray<readonly [string, () => void, NonNullable<AgentToolAuditEntry["hook"]>["outcome"]]> = [
      ["recorded", () => undefined, "recorded"],
      ["fault", () => { state.observe = () => { throw new Error(SECRET); }; }, "failed"],
      ["timeout", () => { state.observe = () => never(); }, "timed-out"],
      ["disposal", () => { state.observerDispose = () => { throw new Error("observer dispose failed"); }; }, "failed"],
    ];
    for (const [name, arrange, outcome] of cases) {
      reset();
      arrange();
      const perCall: AgentToolAuditEntry[] = [];
      const { container, result } = await execute({ agentName: AGENT, auditSink: (entry) => { perCall.push(entry); }, auditRedaction: false }, { auditRedaction: false });
      try {
        expect(result.status, name).toBe("success");
        expect(state.toolExecuted, name).toBe(1);
        expect(state.settlements, name).toHaveLength(1);
        const observer = state.evidence.filter((entry) => entry.phase === "observer");
        expect(observer, name).toHaveLength(1);
        expect(observer[0]?.hook?.outcome, name).toBe(outcome);
        expect(perCall.some((entry) => entry.phase === "observer"), name).toBe(false);
        expect(JSON.stringify(observer), name).not.toContain(SECRET);
        if (name === "timeout") expect(state.observerContexts[0]?.signal.aborted).toBe(true);
      } finally { await container.dispose(); }
    }

    reset();
    let observerEntered: (() => void) | undefined;
    const observerReady = new Promise<void>((resolve) => { observerEntered = resolve; });
    state.observe = () => { observerEntered?.(); return never(); };
    const controller = new AbortController();
    const harness = createHarness();
    try {
      const pending = harness.executor.execute(agentToolCall({ id: "observer-cancel", name: "hook.matrix" }), { agentName: AGENT, signal: controller.signal });
      await observerReady;
      controller.abort();
      const result = await pending;
      expect(result.status).toBe("success");
      expect(state.toolExecuted).toBe(1);
      expect(state.settlements).toHaveLength(1);
      const observer = state.evidence.filter((entry) => entry.phase === "observer");
      expect(observer).toHaveLength(1);
      expect(observer[0]?.hook?.outcome).toBe("cancelled");
      expect(state.observerContexts[0]?.signal.aborted).toBe(true);
    } finally { await harness.container.dispose(); }
  });

  test("keeps observer evidence sink failure and timeout bounded and best-effort", async () => {
    for (const mode of ["fault", "timeout"] as const) {
      reset();
      let observerAuditCalls = 0;
      state.constructorAudit = (entry) => {
        if (entry.phase !== "observer") {
          state.evidence.push(entry);
          return undefined;
        }
        observerAuditCalls += 1;
        return mode === "fault" ? Promise.reject(new Error("observer audit unavailable")) : never();
      };
      const perCall: AgentToolAuditEntry[] = [];
      const { container, result } = await execute({ agentName: AGENT, auditSink: (entry) => { perCall.push(entry); } });
      try {
        expect(result.status, mode).toBe("success");
        expect(state.toolExecuted, mode).toBe(1);
        expect(state.settlements, mode).toHaveLength(1);
        expect(observerAuditCalls, mode).toBe(1);
        expect(perCall.some((entry) => entry.phase === "observer"), mode).toBe(false);
      } finally { await container.dispose(); }
    }
  });

  test("does not hang an already-aborted pre-effect settlement and records cancellation", async () => {
    reset();
    state.settle = () => never();
    const controller = new AbortController();
    controller.abort();
    const { container, executor } = createHarness();
    try {
      const terminal = await Promise.race([
        executor.execute(agentToolCall({ id: "already-aborted-settlement", name: "hook.matrix" }), { agentName: AGENT, signal: controller.signal }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
      ]);
      expect(terminal).toBeDefined();
      expect(state.evidence.filter((entry) => entry.phase === "settlement")).toHaveLength(1);
      expect(state.evidence.find((entry) => entry.phase === "settlement")?.hook?.outcome).toBe("cancelled");
    } finally { await container.dispose(); }
  });

  test("does not hang an elapsed pre-effect settlement deadline and records timeout", async () => {
    reset();
    state.enforcement = (tier) => tier === "platform" ? { decision: "deny" } : { decision: "allow" };
    state.settle = () => never();
    const { container, executor } = createHarness();
    try {
      const terminal = await Promise.race([
        executor.execute(agentToolCall({ id: "elapsed-settlement", name: "hook.matrix" }), { agentName: AGENT, timeoutMs: 1 }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
      ]);
      expect(terminal).toBeDefined();
      expect(state.evidence.filter((entry) => entry.phase === "settlement")).toHaveLength(1);
      expect(state.evidence.find((entry) => entry.phase === "settlement")?.hook?.outcome).toBe("timed-out");
    } finally { await container.dispose(); }
  });

  test("projects retryability per attempt and keeps later hook terminals non-retryable", async () => {
    reset();
    state.tool = () => { throw new Error("retry candidate"); };
    state.enforcement = (tier) => tier === "platform" && state.toolExecuted === 1
      ? { decision: "deny" }
      : { decision: "allow" };
    const { container, result } = await execute({
      agentName: AGENT,
      retryPolicy: { maxAttempts: 2, retryOnErrorCodes: ["TOOL_EXECUTION_FAILED"] },
    });
    try {
      expect(result.error?.code).toBe("TOOL_HOOK_DENIED");
      expect(state.toolExecuted).toBe(1);
      expect(state.settlements).toHaveLength(2);
      expect(state.settlements[0]?.terminal.retryable).toBe(true);
      expect(state.settlements[1]?.terminal.retryable).toBe(false);
      expect(state.order).toEqual(["platform", "application", "platform"]);
    } finally { await container.dispose(); }
  });

  test("uses one constructor-owned framework result audit for malformed calls", async () => {
    reset();
    const { container, executor } = createHarness();
    try {
      const perCall: AgentToolAuditEntry[] = [];
      const malformed = await executor.execute({ id: "x", name: "hook.matrix", input: { get password(): unknown { throw new Error(SECRET); } } } as never, {
        auditSink: (entry) => { perCall.push(entry); }, auditFailureMode: "best-effort", auditRedaction: false,
      });
      expect(malformed.error?.code).toBe("TOOL_CALL_INVALID");
      const malformedAudit = state.evidence.filter((entry) => entry.phase === "result");
      expect(malformedAudit).toHaveLength(1);
      expect(malformedAudit[0]?.callId).toBe("invalid-tool-call");
      expect(malformedAudit[0]?.result?.error?.code).toBe("TOOL_CALL_INVALID");
      expect(JSON.stringify(malformedAudit)).not.toContain(SECRET);
      expect(perCall).toHaveLength(0);
      expect(state.settlements).toHaveLength(0);

    } finally { await container.dispose(); }
  });

  test("uses one constructor-owned framework result audit for unregistered calls", async () => {
    reset();
    const { container, executor } = createHarness();
    try {
      const perCall: AgentToolAuditEntry[] = [];
      const unregistered = await executor.execute(agentToolCall({ id: "unknown", name: "missing.tool", input: { password: SECRET } }), {
        auditSink: (entry) => { perCall.push(entry); }, auditFailureMode: "best-effort", auditRedaction: false,
      });
      expect(unregistered.error?.code).toBe("TOOL_NOT_REGISTERED");
      const unregisteredAudit = state.evidence.filter((entry) => entry.phase === "result");
      expect(unregisteredAudit).toHaveLength(1);
      expect(unregisteredAudit[0]?.callId).toBe("unknown");
      expect(unregisteredAudit[0]?.result?.error?.code).toBe("TOOL_NOT_REGISTERED");
      expect(JSON.stringify(unregisteredAudit)).not.toContain(SECRET);
      expect(perCall).toHaveLength(0);
      expect(state.settlements).toHaveLength(0);
    } finally { await container.dispose(); }
  });
});
