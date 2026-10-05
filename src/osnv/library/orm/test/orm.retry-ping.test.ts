import { expect, test } from "bun:test";
import { PostgresProvider, withRetry } from "../index";

function fixture(held = false) {
  const calls: string[] = [];
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { value: {
    async reserve() {
      calls.push("reserve");
      entered.resolve();
      if (held) await gate.promise;
      return {
        async unsafe(sql: string) { calls.push(sql); return []; },
        async release() { calls.push("release"); released.resolve(); },
        async close() { calls.push("close"); released.resolve(); },
      };
    },
    async close() { calls.push("pool close"); },
  } });
  return { provider, calls, entered, released, gate };
}

test("retry wrappers preserve an already cancelled ping without acquiring a connection", async () => {
  const f = fixture();
  try {
    const wrapped = withRetry(withRetry(f.provider));
    expect(await wrapped.ping(AbortSignal.abort())).toBe(false);
    expect(f.calls).toEqual([]);
  } finally { await f.provider.close(); }
});

test("retry ping cancels a pending reservation and closes its late connection without SQL", async () => {
  const f = fixture(true);
  const controller = new AbortController();
  try {
    const ping = withRetry(f.provider).ping(controller.signal);
    await f.entered.promise;
    controller.abort();
    f.gate.resolve();
    expect(await ping).toBe(false);
    await f.released.promise;
    expect(f.calls).toContain("close");
    expect(f.calls).not.toContain("SELECT 1");
  } finally {
    f.gate.resolve();
    await f.provider.close();
  }
});

test("retry ping keeps the healthy result and performs exactly one check", async () => {
  const f = fixture();
  try {
    expect(await withRetry(f.provider).ping()).toBe(true);
    expect(f.calls).toEqual(["reserve", "SELECT 1", "release"]);
  } finally { await f.provider.close(); }
});
