import { expect, test } from "bun:test";
import { PostgresProvider, withRetry, type PostgresOperationEvent, type Row } from "../index";
import { isConfirmedStatementRejection } from "../Providers/transactionOutcome";

function fixture(failure?: unknown, options: { admission?: boolean; synchronous?: boolean; release?: boolean; held?: boolean } = {}) {
  const calls: string[] = [], telemetry: PostgresOperationEvent[] = [];
  const provider = new PostgresProvider({ operationTimeoutMs: 30, cancellationTimeoutMs: 30, onOperation: event => telemetry.push(event) });
  let rejectHeld: ((error: unknown) => void) | undefined;
  const session = {
    unsafe(sql: string): Promise<Row[]> {
      calls.push(sql);
      if (sql === "write") {
        if (options.held) return new Promise((_resolve, reject) => { rejectHeld = reject; });
        if (options.synchronous) throw failure;
        if (failure) return Promise.reject(failure);
      }
      return Promise.resolve([{ value: 42 }]);
    },
    async close() { calls.push("close"); rejectHeld?.(new Error("closed")); },
    async release() { calls.push("release"); if (options.release) throw Object.assign(new Error("connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }); },
  };
  Object.defineProperty(provider, "sql", { value: {
    async reserve() { calls.push("reserve"); if (options.admission) throw failure; return session; },
    async close() { calls.push("pool close"); },
  } });
  return { provider, calls, telemetry };
}

for (const kind of ["query", "execute"] as const) {
  test(`${kind}: lost autocommit reply cannot replay even under an always-transient policy`, async () => {
    const cause = Object.assign(new Error("connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
    const f = fixture(cause), wrapped = withRetry(f.provider, { maxRetries: 2, baseDelayMs: 0, isTransient: () => true });
    try {
      await expect(wrapped[kind]("write", [])).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "commit", cause });
      expect(f.calls.filter(sql => sql === "write")).toHaveLength(1);
      expect(f.calls.indexOf("close")).toBeLessThan(f.calls.indexOf("release"));
      expect(f.telemetry.find(event => event.operation === kind)?.outcome).toBe("unknown");
      expect(await f.provider.query("next", [])).toEqual([{ value: 42 }]);
      expect(f.provider.statistics().pendingNativeOperations).toBe(0);
    } finally { await f.provider.close(); }
  });

  test(`${kind}: confirmed autocommit followed by release failure cannot replay`, async () => {
    const f = fixture(undefined, { release: true });
    try {
      await expect(withRetry(f.provider, { maxRetries: 2, baseDelayMs: 0, isTransient: () => true })[kind]("write", [])).rejects.toMatchObject({ committed: true });
      expect(f.calls.filter(sql => sql === "write")).toHaveLength(1);
    } finally { await f.provider.close(); }
  });
}

test("explicit statement rejection preserves the server error and safe retry", async () => {
  const cause = Object.assign(new Error("could not serialize access"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: "40001" });
  const f = fixture(cause);
  try {
    await expect(withRetry(f.provider, { maxRetries: 1, baseDelayMs: 0 }).execute("write", [])).rejects.toBe(cause);
    expect(f.calls.filter(sql => sql === "write")).toHaveLength(2);
    expect(f.calls).not.toContain("close");
  } finally { await f.provider.close(); }
});

for (const mode of ["admission", "synchronous"] as const) test(`${mode}: failure before dispatch is not an unknown outcome`, async () => {
  const cause = new TypeError("local input failure"), f = fixture(cause, { [mode]: true });
  try { await expect(f.provider.execute("write", [])).rejects.toBe(cause); expect(f.calls).not.toContain("close"); }
  finally { await f.provider.close(); }
});

test("autocommit timeout returns unknown and closes the retained owner", async () => {
  const f = fixture(undefined, { held: true });
  try {
    await expect(f.provider.execute("write", [])).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "commit" });
    expect(f.calls.indexOf("close")).toBeLessThan(f.calls.indexOf("release"));
    expect(f.provider.statistics().pendingNativeOperations).toBe(0);
  } finally { await f.provider.close(); }
});

test("explicit transaction statement failure still follows acknowledged rollback", async () => {
  const cause = new Error("statement failed"), f = fixture(cause);
  try {
    await expect(f.provider.transaction(tx => tx.execute("write", []))).rejects.toBe(cause);
    expect(f.calls).toContain("ROLLBACK"); expect(f.calls).not.toContain("close");
  } finally { await f.provider.close(); }
});

test("statement outcome classification keeps connection, shutdown and completion-unknown failures uncertain", () => {
  for (const errno of ["23505", "42601", "57014", "40001", "40P01", "22012"]) expect(isConfirmedStatementRejection({ errno })).toBe(true);
  for (const errno of ["08006", "08003", "40003", "57P01", "57P02", "57P03", "00000"]) expect(isConfirmedStatementRejection({ errno })).toBe(false);
  expect(isConfirmedStatementRejection(new Error("no reply"))).toBe(false);
  expect(isConfirmedStatementRejection({ get errno() { throw new Error("do not invoke getters"); } })).toBe(false);
});
