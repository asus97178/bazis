import { describe, expect, spyOn, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import { Validator, modelValidatorAdapter } from "@/library/validation";
import {
  Agent,
  AgentRegistry,
  AgentToolPreCommitError,
  AgentToolExecutor,
  Tool,
  agentToolCall,
  type AgentToolAuditEntry,
  type AgentToolApprovalRequest,
  type AgentToolExecutionContext,
  type JsonObject,
  type JsonValue,
} from "../index";

const CATALOG_AGENT = "catalog-agent";

class SearchInput {
  @Validator({ required: true, minLength: 3 })
  query!: string;
}

class SearchOutput {
  @Validator({ required: true, integer: true })
  count!: number;

  query = "";
  invocationId: string | null = null;
  agentName: string | null = null;
  approval = "";
}

class DefaultedRetryInput {
  query = "default-query";
  nested = { limit: 5 };
}

const defaultedRetryObservations: Array<{
  readonly attempt: number;
  readonly query: string;
  readonly limit: number;
  readonly inputFrozen: boolean;
  readonly nestedFrozen: boolean;
  readonly mutationBlocked: boolean;
}> = [];

@Tool({
  name: "catalog.defaulted-retry",
  description: "Checks stable effective input across retries.",
  input: DefaultedRetryInput,
  sideEffect: "read",
})
class DefaultedRetryTool {
  execute(input: DefaultedRetryInput, context: AgentToolExecutionContext): JsonObject {
    let mutationBlocked = false;
    try {
      input.nested.limit = 999;
    } catch {
      mutationBlocked = true;
    }
    defaultedRetryObservations.push({
      attempt: context.attempt,
      query: input.query,
      limit: input.nested.limit,
      inputFrozen: Object.isFrozen(input),
      nestedFrozen: Object.isFrozen(input.nested),
      mutationBlocked,
    });
    if (context.attempt === 1) {
      throw new Error("retry once");
    }
    return { query: input.query, limit: input.nested.limit };
  }
}

class DelayedDisposeState {
  async dispose(): Promise<void> {
    await Bun.sleep(20);
  }
}

@Tool({ name: "catalog.delayed-dispose", description: "Checks bounded scope disposal.", sideEffect: "read" })
class DelayedDisposeTool {
  constructor(private readonly _state: DelayedDisposeState) {}

  execute(): JsonObject {
    return { ok: true };
  }
}

class ThrowingDisposeState {
  dispose(): void {
    throw new Error("dispose failed");
  }
}

let postCommitWriteCalls = 0;

@Tool({ name: "catalog.delayed-dispose-write", description: "Writes before a slow disposer.", sideEffect: "write" })
class DelayedDisposeWriteTool {
  constructor(private readonly _state: DelayedDisposeState) {}

  execute(): JsonObject {
    postCommitWriteCalls += 1;
    return { committed: true };
  }
}

@Tool({ name: "catalog.throwing-dispose-write", description: "Writes before a throwing disposer.", sideEffect: "write" })
class ThrowingDisposeWriteTool {
  constructor(private readonly _state: ThrowingDisposeState) {}

  execute(): JsonObject {
    postCommitWriteCalls += 1;
    return { committed: true };
  }
}

@Tool({
  name: "catalog.invalid-write-output",
  description: "Writes before returning an invalid output.",
  output: SearchOutput,
  sideEffect: "write",
})
class InvalidWriteOutputTool {
  execute(): JsonObject {
    postCommitWriteCalls += 1;
    return { count: "invalid" };
  }
}

@Tool({ name: "catalog.commit-then-throw", description: "Commits and then throws.", sideEffect: "write" })
class CommitThenThrowTool {
  execute(): never {
    postCommitWriteCalls += 1;
    throw new Error("response transport failed after commit");
  }
}

const disposedStateCounts: number[] = [];

class ToolState {
  public count = 0;

  public dispose(): void {
    disposedStateCounts.push(this.count);
  }
}

@Tool({
  name: "catalog.search",
  description: "Find products in the catalog.",
  input: SearchInput,
  output: SearchOutput,
  sideEffect: "read",
})
class SearchCatalogTool {
  constructor(private readonly state: ToolState) {}

  execute(input: SearchInput, context: AgentToolExecutionContext): JsonObject {
    this.state.count += 1;
    return {
      query: input.query,
      count: this.state.count,
      invocationId: context.invocationId ?? null,
      agentName: context.agentName ?? null,
      approval: context.approval,
    };
  }
}

let reindexCalls = 0;

@Tool({
  name: "catalog.reindex",
  description: "Rebuild product search index.",
  sideEffect: "write",
})
class ReindexCatalogTool {
  execute(_input: JsonValue, context: AgentToolExecutionContext): JsonObject {
    reindexCalls += 1;
    return { ok: true, approval: context.approval };
  }
}

let retryStateCreated = 0;
let flakyReadCalls = 0;
const retryStateDisposedIds: number[] = [];
const retryStateExecutedIds: number[] = [];

class RetryToolState {
  public readonly id = ++retryStateCreated;

  public dispose(): void {
    retryStateDisposedIds.push(this.id);
  }
}

@Tool({
  name: "catalog.flaky-read",
  description: "A read tool that succeeds after transient failures.",
  sideEffect: "read",
})
class FlakyReadTool {
  constructor(private readonly state: RetryToolState) {}

  execute(_input: JsonValue, context: AgentToolExecutionContext): JsonObject {
    flakyReadCalls += 1;
    retryStateExecutedIds.push(this.state.id);
    if (flakyReadCalls < 3) {
      throw new Error("catalog temporarily unavailable");
    }
    return {
      ok: true,
      calls: flakyReadCalls,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      stateId: this.state.id,
    };
  }
}

let flakyWriteCalls = 0;
const flakyWriteIdempotencyKeys: JsonValue[] = [];

@Tool({
  name: "catalog.flaky-write",
  description: "A write tool that succeeds after a transient failure.",
  sideEffect: "write",
})
class FlakyWriteTool {
  execute(_input: JsonValue, context: AgentToolExecutionContext): JsonObject {
    flakyWriteCalls += 1;
    flakyWriteIdempotencyKeys.push(context.idempotencyKey ?? null);
    if (flakyWriteCalls < 2) {
      throw new AgentToolPreCommitError("index lock before commit");
    }
    return {
      ok: true,
      calls: flakyWriteCalls,
      attempt: context.attempt,
      idempotencyKey: context.idempotencyKey ?? null,
    };
  }
}

@Tool({
  name: "catalog.missing-execute",
  description: "A broken tool without execute method.",
})
class MissingExecuteTool {}

@Tool({
  name: "catalog.invalid-result",
  description: "A broken tool returning non-JSON data.",
})
class InvalidResultTool {
  execute(): Date {
    return new Date(0);
  }
}

@Tool({
  name: "catalog.bad-output",
  description: "A broken tool returning data that fails output validation.",
  output: SearchOutput,
})
class InvalidOutputTool {
  execute(): JsonObject {
    return { count: "not-a-number" };
  }
}

let slowToolSignalAborted = false;
let slowToolDisposedDuringExecution = false;
let slowToolStateDisposed = false;

class SlowToolState {
  public disposed = false;

  dispose(): void {
    this.disposed = true;
    slowToolStateDisposed = true;
  }
}

@Tool({
  name: "catalog.slow",
  description: "A slow tool.",
  timeoutMs: 1,
})
class SlowTool {
  constructor(private readonly state: SlowToolState) {}

  async execute(_input: JsonValue, context: AgentToolExecutionContext): Promise<JsonObject> {
    context.signal.addEventListener("abort", () => {
      slowToolSignalAborted = true;
    }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    slowToolDisposedDuringExecution = this.state.disposed;
    return { ok: true };
  }
}

let hiddenToolCalls = 0;

@Tool({
  name: "catalog.hidden",
  description: "A registered tool not visible to the catalog agent.",
})
class HiddenTool {
  execute(): JsonObject {
    hiddenToolCalls += 1;
    return { ok: true };
  }
}

@Tool({
  name: "catalog.secret-echo",
  description: "Echoes input and sensitive output for audit redaction tests.",
  sideEffect: "read",
})
class SecretEchoTool {
  execute(input: JsonValue): JsonObject {
    return {
      ok: true,
      input,
      token: "result-token",
    };
  }
}

@Agent({
  name: CATALOG_AGENT,
  tools: [
    SearchCatalogTool,
    ReindexCatalogTool,
    FlakyReadTool,
    FlakyWriteTool,
    MissingExecuteTool,
    InvalidResultTool,
    InvalidOutputTool,
    SlowTool,
    SecretEchoTool,
    DefaultedRetryTool,
    DelayedDisposeTool,
    DelayedDisposeWriteTool,
    ThrowingDisposeWriteTool,
    InvalidWriteOutputTool,
    CommitThenThrowTool,
  ],
})
class CatalogAgent {}

@Module({
  agents: [CatalogAgent],
  tools: [
    SearchCatalogTool,
    ReindexCatalogTool,
    FlakyReadTool,
    FlakyWriteTool,
    MissingExecuteTool,
    InvalidResultTool,
    InvalidOutputTool,
    SlowTool,
    HiddenTool,
    SecretEchoTool,
    DefaultedRetryTool,
    DelayedDisposeTool,
    DelayedDisposeWriteTool,
    ThrowingDisposeWriteTool,
    InvalidWriteOutputTool,
    CommitThenThrowTool,
  ],
  providers: [
    scoped(ToolState),
    scoped(RetryToolState),
    scoped(SearchCatalogTool, SearchCatalogTool, [ToolState]),
    scoped(ReindexCatalogTool),
    scoped(FlakyReadTool, FlakyReadTool, [RetryToolState]),
    scoped(FlakyWriteTool),
    scoped(MissingExecuteTool),
    scoped(InvalidResultTool),
    scoped(InvalidOutputTool),
    scoped(SlowToolState),
    scoped(SlowTool, SlowTool, [SlowToolState]),
    scoped(HiddenTool),
    scoped(SecretEchoTool),
    scoped(DefaultedRetryTool),
    scoped(DelayedDisposeState),
    scoped(DelayedDisposeTool, DelayedDisposeTool, [DelayedDisposeState]),
    scoped(DelayedDisposeWriteTool, DelayedDisposeWriteTool, [DelayedDisposeState]),
    scoped(ThrowingDisposeState),
    scoped(ThrowingDisposeWriteTool, ThrowingDisposeWriteTool, [ThrowingDisposeState]),
    scoped(InvalidWriteOutputTool),
    scoped(CommitThenThrowTool),
  ],
})
class ToolExecutorTestModule {}

function createExecutor(
  options: ConstructorParameters<typeof AgentToolExecutor>[2] = {},
): {
  readonly executor: AgentToolExecutor;
  readonly container: ReturnType<typeof createContainer>;
} {
  const container = createContainer(ToolExecutorTestModule);
  const registry = AgentRegistry.fromModules([ToolExecutorTestModule]);
  return {
    executor: new AgentToolExecutor(container, registry, {
      schemaValidator: modelValidatorAdapter,
      auditSink: () => undefined,
      ...options,
    }),
    container,
  };
}

describe("agent tool executor", () => {
  test("executes registered tools through scoped DI and disposes the scope per call", async () => {
    disposedStateCounts.length = 0;
    const { executor, container } = createExecutor();
    try {
      const first = await executor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT, invocationId: "inv-1" },
      );
      const second = await executor.execute(
        agentToolCall({ id: "call-2", name: "catalog.search", input: { query: "mouse" } }),
        { agentName: CATALOG_AGENT, invocationId: "inv-2" },
      );

      expect(first.status).toBe("success");
      expect(first.output).toEqual({
        query: "keyboard",
        count: 1,
        invocationId: "inv-1",
        agentName: CATALOG_AGENT,
        approval: "not-required",
      });
      expect(second.output).toEqual({
        query: "mouse",
        count: 1,
        invocationId: "inv-2",
        agentName: CATALOG_AGENT,
        approval: "not-required",
      });
      expect(disposedStateCounts).toEqual([1, 1]);
      expect(first.metadata).toMatchObject({
        agentName: CATALOG_AGENT,
        toolSideEffect: "read",
        toolApproval: "policy",
        executionApproval: "not-required",
      });
    } finally {
      await container.dispose();
    }
  });

  test("retries read tools with a fresh DI scope for each attempt", async () => {
    retryStateCreated = 0;
    flakyReadCalls = 0;
    retryStateDisposedIds.length = 0;
    retryStateExecutedIds.length = 0;
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditSink: (entry) => {
        entries.push(entry);
      },
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.flaky-read" }), {
        agentName: CATALOG_AGENT,
        retryPolicy: { maxAttempts: 3 },
      });

      expect(result.status).toBe("success");
      expect(result.output).toMatchObject({ ok: true, calls: 3, attempt: 3, maxAttempts: 3 });
      expect(result.metadata).toMatchObject({ toolAttempt: 3, toolMaxAttempts: 3, toolRetried: true });
      expect(flakyReadCalls).toBe(3);
      expect(retryStateExecutedIds).toHaveLength(3);
      expect(new Set(retryStateExecutedIds).size).toBe(3);
      expect(retryStateDisposedIds).toEqual(retryStateExecutedIds);
      expect(entries.filter((entry) => entry.phase === "attempt").map((entry) => entry.attempt)).toEqual([1, 2, 3]);
      expect(entries.filter((entry) => entry.phase === "result")).toHaveLength(3);
    } finally {
      await container.dispose();
    }
  });

  test("rejects retries for write tools without an idempotency key before DI resolve", async () => {
    flakyWriteCalls = 0;
    flakyWriteIdempotencyKeys.length = 0;
    const { executor, container } = createExecutor({ schemaValidator: modelValidatorAdapter, approvalPolicy: () => true });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.flaky-write" }), {
        agentName: CATALOG_AGENT,
        retryPolicy: { maxAttempts: 2 },
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_RETRY_IDEMPOTENCY_REQUIRED");
      expect(flakyWriteCalls).toBe(0);
      expect(flakyWriteIdempotencyKeys).toEqual([]);
    } finally {
      await container.dispose();
    }
  });

  test("retries write tools only when approval and an idempotency key are present", async () => {
    flakyWriteCalls = 0;
    flakyWriteIdempotencyKeys.length = 0;
    const approvals: AgentToolApprovalRequest[] = [];
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      approvalPolicy: (request) => {
        approvals.push(request);
        return true;
      },
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.flaky-write" }), {
        agentName: CATALOG_AGENT,
        idempotencyKey: "catalog-reindex-1",
        retryPolicy: { maxAttempts: 2 },
      });

      expect(result.status).toBe("success");
      expect(result.output).toEqual({ ok: true, calls: 2, attempt: 2, idempotencyKey: "catalog-reindex-1" });
      expect(result.metadata).toMatchObject({ toolAttempt: 2, toolMaxAttempts: 2, toolRetried: true });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.idempotencyKey).toBe("catalog-reindex-1");
      expect(flakyWriteIdempotencyKeys).toEqual(["catalog-reindex-1", "catalog-reindex-1"]);
    } finally {
      await container.dispose();
    }
  });

  test("uses one immutable effective defaulted input for approval, audit and every retry", async () => {
    defaultedRetryObservations.length = 0;
    const approvals: AgentToolApprovalRequest[] = [];
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      approvalPolicy: (request) => {
        approvals.push(request);
        return true;
      },
      auditSink: (entry) => { entries.push(entry); },
    });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-defaults", name: "catalog.defaulted-retry", input: {} }),
        { agentName: CATALOG_AGENT, retryPolicy: { maxAttempts: 2 } },
      );

      expect(result.status).toBe("success");
      expect(result.output).toEqual({ query: "default-query", limit: 5 });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.call.input).toEqual({ query: "default-query", nested: { limit: 5 } });
      expect(Object.isFrozen(approvals[0]?.call.input as object)).toBe(true);
      expect(entries.filter((entry) => entry.phase === "attempt").map((entry) => entry.input)).toEqual([
        { query: "default-query", nested: { limit: 5 } },
        { query: "default-query", nested: { limit: 5 } },
      ]);
      expect(defaultedRetryObservations).toEqual([
        { attempt: 1, query: "default-query", limit: 5, inputFrozen: true, nestedFrozen: true, mutationBlocked: true },
        { attempt: 2, query: "default-query", limit: 5, inputFrozen: true, nestedFrozen: true, mutationBlocked: true },
      ]);
    } finally {
      await container.dispose();
    }
  });

  test("denies write tools before DI resolve when explicit approval is missing", async () => {
    reindexCalls = 0;
    const { executor, container } = createExecutor();
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.reindex" }), {
        agentName: CATALOG_AGENT,
      });

      expect(result.status).toBe("denied");
      expect(result.error?.code).toBe("TOOL_APPROVAL_REQUIRED");
      expect(reindexCalls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("executes write tools when approval policy allows the request", async () => {
    reindexCalls = 0;
    const approvals: AgentToolApprovalRequest[] = [];
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      approvalPolicy: (request) => {
        approvals.push(request);
        return true;
      },
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.reindex" }), {
        agentName: CATALOG_AGENT,
      });

      expect(result.status).toBe("success");
      expect(result.output).toEqual({ ok: true, approval: "approved" });
      expect(approvals[0]?.agentName).toBe(CATALOG_AGENT);
      expect(approvals[0]?.reason).toBe("required");
      expect(reindexCalls).toBe(1);
    } finally {
      await container.dispose();
    }
  });

  test("denies calls when approval policy rejects them", async () => {
    reindexCalls = 0;
    const { executor, container } = createExecutor({ schemaValidator: modelValidatorAdapter, approvalPolicy: () => false });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.reindex" }), {
        agentName: CATALOG_AGENT,
      });

      expect(result.status).toBe("denied");
      expect(result.error?.code).toBe("TOOL_APPROVAL_DENIED");
      expect(reindexCalls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("returns structured errors for missing tools, missing execute method and invalid result", async () => {
    const { executor, container } = createExecutor();
    try {
      const missingTool = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.unknown" }), {
        agentName: CATALOG_AGENT,
      });
      const missingMethod = await executor.execute(agentToolCall({ id: "call-2", name: "catalog.missing-execute" }), {
        agentName: CATALOG_AGENT,
      });
      const invalidResult = await executor.execute(agentToolCall({ id: "call-3", name: "catalog.invalid-result" }), {
        agentName: CATALOG_AGENT,
      });

      expect(missingTool.status).toBe("error");
      expect(missingTool.error?.code).toBe("TOOL_NOT_REGISTERED");
      expect(missingMethod.error?.code).toBe("TOOL_METHOD_MISSING");
      expect(invalidResult.error?.code).toBe("TOOL_RESULT_INVALID");
    } finally {
      await container.dispose();
    }
  });

  test("returns a timeout error and aborts the execution context signal", async () => {
    slowToolSignalAborted = false;
    slowToolDisposedDuringExecution = false;
    slowToolStateDisposed = false;
    const { executor, container } = createExecutor();
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.slow" }), {
        agentName: CATALOG_AGENT,
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(slowToolSignalAborted).toBe(true);
      expect(slowToolStateDisposed).toBe(false);
      await Bun.sleep(25);
      expect(slowToolDisposedDuringExecution).toBe(false);
      expect(slowToolStateDisposed).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  test("applies one deadline to never-settling input validation, approval and audits", async () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

    const validationCase = createExecutor({
      defaultTimeoutMs: 2,
      schemaValidator: { validate: () => never() },
    });
    try {
      const result = await validationCase.executor.execute(agentToolCall({
        id: "call-validator-timeout",
        name: "catalog.search",
        input: { query: "keyboard" },
      }), { agentName: CATALOG_AGENT });
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(result.error?.details).toMatchObject({ phase: "pre-execute" });
    } finally {
      await validationCase.container.dispose();
    }

    reindexCalls = 0;
    const approvalCase = createExecutor({
      defaultTimeoutMs: 2,
      approvalPolicy: () => never(),
    });
    try {
      const result = await approvalCase.executor.execute(
        agentToolCall({ id: "call-approval-timeout", name: "catalog.reindex" }),
        { agentName: CATALOG_AGENT },
      );
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(reindexCalls).toBe(0);
    } finally {
      await approvalCase.container.dispose();
    }

    const attemptAuditCase = createExecutor({
      defaultTimeoutMs: 2,
      auditSink: (entry) => entry.phase === "attempt" ? never() : undefined,
    });
    try {
      const result = await attemptAuditCase.executor.execute(
        agentToolCall({ id: "call-attempt-audit-timeout", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT },
      );
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(result.error?.details).toMatchObject({ phase: "pre-execute" });
    } finally {
      await attemptAuditCase.container.dispose();
    }

    reindexCalls = 0;
    const resultAuditCase = createExecutor({
      defaultTimeoutMs: 2,
      approvalPolicy: () => true,
      auditSink: (entry) => entry.phase === "result" ? never() : undefined,
    });
    try {
      const result = await resultAuditCase.executor.execute(
        agentToolCall({ id: "call-result-audit-timeout", name: "catalog.reindex" }),
        { agentName: CATALOG_AGENT },
      );
      expect(reindexCalls).toBe(1);
      expect(result.error?.code).toBe("TOOL_TIMEOUT_OUTCOME_UNKNOWN");
      expect(result.error?.details).toMatchObject({ phase: "result-audit", sideEffect: "write" });
    } finally {
      await resultAuditCase.container.dispose();
    }
  });

  test.each([{ stage: "approval" }, { stage: "attempt-audit" }])("preserves pre-execute phase when the inner $stage deadline wins", async ({ stage }) => {
    let now = Date.now();
    let validationCalls = 0, approvalCalls = 0, attemptCalls = 0;
    const { executor, container } = createExecutor({
      defaultTimeoutMs: 1000,
      schemaValidator: { validate() {
        validationCalls++;
        // Expire the absolute deadline before the outer timer is armed.
        // Native timers keep running; no real one-second wait is needed.
        now += 1000;
        return { isValid: true, errors: [] };
      } },
      ...(stage === "approval" ? { approvalPolicy() {
        approvalCalls++;
        return new Promise<boolean>(() => {});
      } } : {}),
      auditSink(entry) {
        if (entry.phase === "attempt") {
          attemptCalls++;
          return new Promise<void>(() => {});
        }
      },
    });
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const execute = spyOn(SearchCatalogTool.prototype, "execute");
    try {
      const result = await executor.execute(agentToolCall({
        id: `call-inner-${stage}-timeout`, name: "catalog.search", input: { query: "fixture" },
      }), { agentName: CATALOG_AGENT });
      expect(validationCalls).toBe(1);
      expect(approvalCalls).toBe(stage === "approval" ? 1 : 0);
      expect(attemptCalls).toBe(stage === "attempt-audit" ? 1 : 0);
      expect(execute).not.toHaveBeenCalled();
      expect(result.error?.code).toBe("TOOL_TIMEOUT");
      expect(result.error?.message).toBe(`Tool execution timed out during ${stage === "approval" ? "approval" : "attempt audit"}.`);
      expect(result.error?.details).toMatchObject({ phase: "pre-execute" });
    } finally {
      clock.mockRestore();
      execute.mockRestore();
      await container.dispose();
    }
  });

  test("uses a 30 second default deadline and accepts zero as an explicit opt-out", async () => {
    const defaultCase = createExecutor();
    const disabledCase = createExecutor({
      defaultTimeoutMs: 0,
      schemaValidator: { validate: () => new Promise(() => undefined) },
    });
    try {
      expect((defaultCase.executor as unknown as { defaultTimeoutMs?: number }).defaultTimeoutMs).toBe(30_000);
      expect((disabledCase.executor as unknown as { defaultTimeoutMs?: number }).defaultTimeoutMs).toBeUndefined();

      const controller = new AbortController();
      const pending = disabledCase.executor.execute(agentToolCall({
        id: "call-timeout-disabled",
        name: "catalog.search",
        input: { query: "keyboard" },
      }), {
        agentName: CATALOG_AGENT,
        timeoutMs: 0,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 5);
      const result = await pending;
      expect(result.error?.code).toBe("TOOL_ABORTED");
    } finally {
      await defaultCase.container.dispose();
      await disabledCase.container.dispose();
    }
  });

  test("bounds scope disposal waits and returns a structured disposal error", async () => {
    const { executor, container } = createExecutor({ scopeDisposeTimeoutMs: 1 });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-dispose", name: "catalog.delayed-dispose" }), {
        agentName: CATALOG_AGENT,
      });
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_SCOPE_DISPOSE_FAILED");
      expect(result.error?.message).toContain("timed out after 1 ms");
      await Bun.sleep(25);
    } finally {
      await container.dispose();
    }
  });

  test("marks throwing and timed-out disposers after committed writes as outcome unknown", async () => {
    postCommitWriteCalls = 0;
    const { executor, container } = createExecutor({
      approvalPolicy: () => true,
      scopeDisposeTimeoutMs: 1,
    });
    try {
      const throwing = await executor.execute(
        agentToolCall({ id: "call-throwing-dispose", name: "catalog.throwing-dispose-write" }),
        { agentName: CATALOG_AGENT },
      );
      const delayed = await executor.execute(
        agentToolCall({ id: "call-delayed-dispose", name: "catalog.delayed-dispose-write" }),
        { agentName: CATALOG_AGENT },
      );

      expect(postCommitWriteCalls).toBe(2);
      expect(throwing.error?.code).toBe("TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN");
      expect(delayed.error?.code).toBe("TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN");
      expect(delayed.error?.message).toContain("timed out after 1 ms");
      await Bun.sleep(25);
    } finally {
      await container.dispose();
    }
  });

  test("propagates caller cancellation and defers scope disposal until the tool settles", async () => {
    slowToolSignalAborted = false;
    slowToolDisposedDuringExecution = false;
    slowToolStateDisposed = false;
    const controller = new AbortController();
    const { executor, container } = createExecutor();
    try {
      const pending = executor.execute(agentToolCall({ id: "call-1", name: "catalog.slow" }), {
        agentName: CATALOG_AGENT,
        timeoutMs: 100,
        signal: controller.signal,
      });
      await Bun.sleep(0);
      controller.abort();
      const result = await pending;
      expect(result.error?.code).toBe("TOOL_ABORTED");
      expect(slowToolSignalAborted).toBe(true);
      expect(slowToolStateDisposed).toBe(false);
      await Bun.sleep(25);
      expect(slowToolDisposedDuringExecution).toBe(false);
      expect(slowToolStateDisposed).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  test("fails closed for side-effecting tools when no audit sink is configured", async () => {
    reindexCalls = 0;
    const container = createContainer(ToolExecutorTestModule);
    const executor = new AgentToolExecutor(container, AgentRegistry.fromModules([ToolExecutorTestModule]), {
      approvalPolicy: () => true,
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.reindex" }), {
        agentName: CATALOG_AGENT,
      });
      expect(result.error?.code).toBe("TOOL_AUDIT_REQUIRED");
      expect(reindexCalls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("requires an agent and denies tools that are not visible to that agent", async () => {
    hiddenToolCalls = 0;
    const { executor, container } = createExecutor();
    try {
      const withoutAgent = await executor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
      );
      const unknownAgent = await executor.execute(
        agentToolCall({ id: "call-2", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: "unknown-agent" },
      );
      const hidden = await executor.execute(agentToolCall({ id: "call-3", name: "catalog.hidden" }), {
        agentName: CATALOG_AGENT,
      });

      expect(withoutAgent.status).toBe("error");
      expect(withoutAgent.error?.code).toBe("TOOL_AGENT_REQUIRED");
      expect(unknownAgent.error?.code).toBe("AGENT_NOT_REGISTERED");
      expect(hidden.status).toBe("denied");
      expect(hidden.error?.code).toBe("TOOL_NOT_VISIBLE_TO_AGENT");
      expect(hiddenToolCalls).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("can explicitly execute tools without agent visibility checks", async () => {
    const { executor, container } = createExecutor({ allowUnboundTools: true, schemaValidator: modelValidatorAdapter });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }));

      expect(result.status).toBe("success");
      expect(result.metadata).toMatchObject({ executionApproval: "not-required" });
    } finally {
      await container.dispose();
    }
  });

  test("validates tool input before DI resolve and tool output before result normalization", async () => {
    disposedStateCounts.length = 0;
    const { executor, container } = createExecutor();
    try {
      const badInput = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "x" } }), {
        agentName: CATALOG_AGENT,
      });
      const badOutput = await executor.execute(agentToolCall({ id: "call-2", name: "catalog.bad-output" }), {
        agentName: CATALOG_AGENT,
      });

      expect(badInput.status).toBe("error");
      expect(badInput.error?.code).toBe("TOOL_INPUT_VALIDATION_FAILED");
      expect(disposedStateCounts).toEqual([]);
      expect(badOutput.status).toBe("error");
      expect(badOutput.error?.code).toBe("TOOL_OUTPUT_VALIDATION_FAILED");
    } finally {
      await container.dispose();
    }
  });

  test("rejects validator-only fallback over-posting before approval, audit attempt and DI resolve", async () => {
    disposedStateCounts.length = 0;
    const approvals: AgentToolApprovalRequest[] = [];
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      approvalPolicy: (request) => { approvals.push(request); return true; },
      auditSink: (entry) => { entries.push(entry); },
    });
    try {
      const result = await executor.execute(agentToolCall({
        id: "call-overpost",
        name: "catalog.search",
        input: { query: "keyboard", isAdmin: true },
      }), { agentName: CATALOG_AGENT });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_INPUT_INVALID");
      expect(result.error?.message).toContain("isAdmin");
      expect(approvals).toHaveLength(0);
      expect(entries.filter((entry) => entry.phase === "attempt")).toHaveLength(0);
      expect(disposedStateCounts).toEqual([]);
    } finally {
      await container.dispose();
    }
  });

  test("marks invalid output after a committed write as outcome unknown", async () => {
    postCommitWriteCalls = 0;
    const { executor, container } = createExecutor({ approvalPolicy: () => true });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-invalid-write-output", name: "catalog.invalid-write-output" }),
        { agentName: CATALOG_AGENT },
      );

      expect(postCommitWriteCalls).toBe(1);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN");
      expect(result.error?.details).toMatchObject({
        originalCode: "TOOL_OUTPUT_VALIDATION_FAILED",
        sideEffect: "write",
      });
    } finally {
      await container.dispose();
    }
  });

  test("marks commit-then-throw writes as outcome unknown and never retries them", async () => {
    postCommitWriteCalls = 0;
    const { executor, container } = createExecutor({ approvalPolicy: () => true });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-commit-throw", name: "catalog.commit-then-throw" }),
        {
          agentName: CATALOG_AGENT,
          idempotencyKey: "commit-throw-key",
          retryPolicy: { maxAttempts: 3, retryOnErrorCodes: ["TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN"] },
        },
      );

      expect(postCommitWriteCalls).toBe(1);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN");
      expect(result.error?.details).toMatchObject({ sideEffect: "write", phase: "execute" });
      expect(result.metadata).toMatchObject({ toolAttempt: 1, toolMaxAttempts: 3 });
    } finally {
      await container.dispose();
    }
  });

  test("fails closed when a tool declares schema classes but no schema validator is configured", async () => {
    const { container } = createExecutor();
    const registry = AgentRegistry.fromModules([ToolExecutorTestModule]);
    const strictExecutor = new AgentToolExecutor(container, registry);
    try {
      const result = await strictExecutor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT },
      );

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_SCHEMA_VALIDATOR_MISSING");
    } finally {
      await container.dispose();
    }
  });

  test("records audit attempt and result entries for successful tool execution", async () => {
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditSink: (entry) => {
        entries.push(entry);
      },
    });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT, invocationId: "inv-1", metadata: { tenant: "acme" } },
      );

      expect(result.status).toBe("success");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        kind: "agent-tool",
        phase: "attempt",
        callId: "call-1",
        toolName: "catalog.search",
        agentName: CATALOG_AGENT,
        invocationId: "inv-1",
        input: { query: "keyboard" },
        metadata: { tenant: "acme" },
        tool: { sideEffect: "read", approval: "policy", inputSchema: "SearchInput", outputSchema: "SearchOutput" },
      });
      expect(entries[1]).toMatchObject({
        kind: "agent-tool",
        phase: "result",
        result: { status: "success", output: { count: 1 } },
      });
      expect(Object.isFrozen(entries[0])).toBe(true);
      expect(Object.isFrozen(entries[1]?.tool)).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  test("redacts sensitive audit fields by default and allows explicit raw audit", async () => {
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditSink: (entry) => {
        entries.push(entry);
      },
    });
    try {
      const input = {
        password: "p@ss",
        nested: { apiKey: "api-secret" },
        visible: "ok",
      };
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.secret-echo", input }), {
        agentName: CATALOG_AGENT,
        metadata: { tenant: "acme", authorization: "Bearer abcdefghijk" },
      });

      expect(result.status).toBe("success");
      expect(entries[0]?.input).toEqual({
        password: "***",
        nested: { apiKey: "***" },
        visible: "ok",
      });
      expect(entries[0]?.metadata).toEqual({ tenant: "acme", authorization: "***" });
      expect(entries[1]?.result?.output).toEqual({
        ok: true,
        input: {
          password: "***",
          nested: { apiKey: "***" },
          visible: "ok",
        },
        token: "***",
      });

      entries.length = 0;
      await executor.execute(agentToolCall({ id: "call-2", name: "catalog.secret-echo", input }), {
        agentName: CATALOG_AGENT,
        auditRedaction: false,
      });
      expect(entries[0]?.input).toEqual(input);
    } finally {
      await container.dispose();
    }
  });

  test("applies custom audit redaction rules to top-level id fields", async () => {
    const entries: AgentToolAuditEntry[] = [];
    const { executor, container } = createExecutor({
      auditSink: (entry) => { entries.push(entry); },
    });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-sensitive-key", name: "catalog.search", input: { query: "keyboard" } }),
        {
          agentName: CATALOG_AGENT,
          invocationId: "inv-secret-domain",
          idempotencyKey: "customer-secret-idempotency-value",
          auditRedaction: { sensitiveKeys: ["idempotencyKey", "invocationId"] },
        },
      );

      expect(result.status).toBe("success");
      expect(entries).toHaveLength(2);
      expect(entries[0]?.idempotencyKey).toBe("***");
      expect(entries[0]?.invocationId).toBe("***");
      expect(entries[1]?.idempotencyKey).toBe("***");
      expect(JSON.stringify(entries)).not.toContain("customer-secret-idempotency-value");
      expect(Object.isFrozen(entries[0])).toBe(true);
      expect(Object.isFrozen(entries[0]?.tool)).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  test("records denied results without an attempt entry when a tool is not visible", async () => {
    const entries: AgentToolAuditEntry[] = [];
    hiddenToolCalls = 0;
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditSink: (entry) => {
        entries.push(entry);
      },
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-1", name: "catalog.hidden" }), {
        agentName: CATALOG_AGENT,
      });

      expect(result.status).toBe("denied");
      expect(hiddenToolCalls).toBe(0);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        phase: "result",
        result: { status: "denied", error: { code: "TOOL_NOT_VISIBLE_TO_AGENT" } },
      });
    } finally {
      await container.dispose();
    }
  });

  test("fails closed when audit attempt cannot be recorded before DI resolve", async () => {
    disposedStateCounts.length = 0;
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditSink: () => {
        throw new Error("audit offline");
      },
    });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT },
      );

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_AUDIT_FAILED");
      expect(disposedStateCounts).toEqual([]);
    } finally {
      await container.dispose();
    }
  });

  test("marks a completed write outcome unknown when its fail-closed result audit fails", async () => {
    reindexCalls = 0;
    const phases: string[] = [];
    const { executor, container } = createExecutor({
      approvalPolicy: () => true,
      auditSink: (entry) => {
        phases.push(entry.phase);
        if (entry.phase === "result") throw new Error("audit result unavailable");
      },
    });
    try {
      const result = await executor.execute(agentToolCall({ id: "call-audit-write", name: "catalog.reindex" }), {
        agentName: CATALOG_AGENT,
      });

      expect(reindexCalls).toBe(1);
      expect(phases).toEqual(["attempt", "result"]);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN");
      expect(result.error?.details).toMatchObject({ originalStatus: "success", sideEffect: "write" });
    } finally {
      await container.dispose();
    }
  });

  test("can keep tool results when audit sink is best-effort", async () => {
    const { executor, container } = createExecutor({
      schemaValidator: modelValidatorAdapter,
      auditFailureMode: "best-effort",
      auditSink: () => {
        throw new Error("audit offline");
      },
    });
    try {
      const result = await executor.execute(
        agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } }),
        { agentName: CATALOG_AGENT },
      );

      expect(result.status).toBe("success");
      expect(result.output).toMatchObject({ query: "keyboard", count: 1 });
    } finally {
      await container.dispose();
    }
  });

  test("bounds a never-settling legacy result audit without replaying the Tool", async () => {
    const { executor, container } = createExecutor({
      defaultTimeoutMs: 5,
      auditSink: (entry) => entry.phase === "result" ? new Promise<void>(() => undefined) : undefined,
    });
    try {
      const outcome = await Promise.race([
        executor.execute(agentToolCall({ id: "result-audit-timeout", name: "catalog.search", input: { query: "keyboard" } }), { agentName: CATALOG_AGENT }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 80)),
      ]);
      expect(outcome).toBeDefined();
      expect(outcome?.error?.code).toBe("TOOL_TIMEOUT");
    } finally { await container.dispose(); }
  });
});
