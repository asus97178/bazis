import { describe, expect, test } from "bun:test";
import { createContainer, DI } from "../../di";
import { HEALTH_CHECK, HealthService, type HealthCheck } from "../index";
import { OpenSearchClient } from "../../infra";

describe("bounded health", () => {
  function service(checks: HealthCheck[]) {
    const container = createContainer({ providers: checks.map(check => DI.singleton(DI.valueProvider(HEALTH_CHECK, check))) });
    return { container, health: new HealthService(container) };
  }
  test("a hung check times out while an independent check completes", async () => {
    let signal: AbortSignal | undefined;
    const { container, health } = service([
      { name: "hung", check(current) { signal = current; return new Promise(() => {}); } },
      { name: "fast", check() { return { healthy: true }; } },
    ]);
    const started = performance.now();
    try {
      const report = await health.check({ checkTimeoutMs: 30, timeoutMs: 300 });
      expect(report.checks.map(entry => [entry.name, entry.healthy])).toEqual([["hung", false], ["fast", true]]);
      expect(signal?.aborted).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally { await container.dispose(); }
  });
  test("overall deadline prevents queued checks from starting", async () => {
    let started = 0;
    const { container, health } = service(Array.from({ length: 3 }, (_, i) => ({ name: String(i), check() { started++; return new Promise(() => {}); } })));
    try {
      const report = await health.check({ timeoutMs: 25, checkTimeoutMs: 500, concurrency: 1 });
      expect(started).toBe(1);
      expect(report.checks).toHaveLength(3);
      expect(report.checks.every(check => !check.healthy)).toBe(true);
    } finally { await container.dispose(); }
  });
  test("repeated reports do not multiply a timed-out operation that ignores abort", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { container, health } = service([{ name: "slow", async check() {
      calls++;
      await gate;
      return { healthy: true };
    } }]);
    try {
      expect((await health.check({ checkTimeoutMs: 10 })).healthy).toBe(false);
      for (let i = 0; i < 5; i++) {
        expect((await health.check({ checkTimeoutMs: 10 })).healthy).toBe(false);
      }
      expect(calls).toBe(1);
      release();
      await Bun.sleep(0);
      expect((await health.check()).healthy).toBe(true);
      expect(calls).toBe(2);
    } finally { release(); await container.dispose(); }
  });
  test("concurrent reports share work and cancelling one observer preserves another", async () => {
    let calls = 0;
    let receivedSignal!: AbortSignal;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { container, health } = service([{ name: "shared", async check(signal) {
      calls++;
      receivedSignal = signal!;
      await gate;
      return { healthy: true };
    } }]);
    const abort = new AbortController();
    try {
      const first = health.check({ signal: abort.signal });
      const second = health.check();
      await Bun.sleep(0);
      abort.abort(new Error("observer cancelled"));
      expect((await first).healthy).toBe(false);
      expect(receivedSignal.aborted).toBe(false);
      release();
      expect((await second).healthy).toBe(true);
      expect(calls).toBe(1);
    } finally { release(); await container.dispose(); }
  });
  test("OpenSearch accepts only green and yellow cluster states", async () => {
    const original = globalThis.fetch;
    try {
      for (const [body, expected] of [[{}, false], [{ status: "unknown" }, false], [{ status: "red" }, false], [null, false], [{ status: "green" }, true], [{ status: "yellow" }, true]] as const) {
        globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
        expect(await new OpenSearchClient({ url: "https://example.invalid" }).ping()).toBe(expected);
      }
    } finally { globalThis.fetch = original; }
  });
});
