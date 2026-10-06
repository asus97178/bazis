import { describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, createToken, type HostedService, type BazisModuleRef } from "../../di";
import {
  APPLICATION_STARTED, Configuration, ConsoleLogger, EventBus, KernelError, Bazis,
  ShutdownTimeoutError, StartupAbortedError, StartupTimeoutError,
  SupervisedHostedService, createEventToken, defineConfig, onEvent, secret,
} from "../index";

const builder = (root: BazisModuleRef = {}) => Bazis.createBuilder(root)
  .useEnvironment("test").useStartupReport(false).useSignals([])
  .useUnhandledErrorPolicy("none").useStartupTimeout(500).useShutdownTimeout(30);
const hosted = (...services: HostedService[]) => ({
  providers: services.map(service => DI.singleton(DI.valueProvider(HOSTED_SERVICE, service))),
});

async function outcome<T>(work: Promise<T>, timeoutMs = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ kind: "resolved" as const, value }), error => ({ kind: "rejected" as const, error: error as unknown })),
      new Promise<{ kind: "pending" }>(resolve => { timer = setTimeout(() => resolve({ kind: "pending" }), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

describe("Kernel regressions", () => {
  test("startup timeout covers an uncooperative onStarted callback", async () => {
    const gate = Promise.withResolvers<void>();
    let stops = 0;
    const kernel = await builder(hosted({ start() {}, stop() { stops++; } })).useStartupTimeout(20).build();
    kernel.lifetime.onStarted(() => gate.promise);
    const starting = kernel.start();
    const result = await outcome(starting);
    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(result.error).toBeInstanceOf(StartupTimeoutError);
      expect(stops).toBe(1);
      expect(kernel.isStarted).toBe(false);
    } finally {
      gate.resolve();
      await starting.catch(() => {});
      await kernel.stop().catch(() => {});
    }
  });

  test("lifetime stop cancels onStarted and prevents late callbacks and events", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let later = 0;
    let events = 0;
    let stops = 0;
    const root = hosted({ start() {}, stop() { stops++; } });
    const kernel = await builder({ providers: [...root.providers!, onEvent(APPLICATION_STARTED, () => { events++; })] }).build();
    kernel.lifetime.onStarted(async () => { entered.resolve(); await gate.promise; });
    kernel.lifetime.onStarted(() => { later++; });
    const running = kernel.run();
    await entered.promise;
    kernel.lifetime.stop(17);
    const result = await outcome(running);
    try {
      expect(result).toEqual({ kind: "resolved", value: 17 });
      expect(stops).toBe(1);
      gate.resolve();
      await Bun.sleep(0);
      expect(later).toBe(0);
      expect(events).toBe(0);
    } finally {
      gate.resolve();
      await running.catch(() => {});
      await kernel.stop().catch(() => {});
    }
  });

  test("started event dispatch shares the startup deadline and stops later handlers", async () => {
    const gate = Promise.withResolvers<void>();
    let later = 0;
    const kernel = await builder({ providers: [
      onEvent(APPLICATION_STARTED, () => Bun.sleep(10)),
      onEvent(APPLICATION_STARTED, () => gate.promise),
      onEvent(APPLICATION_STARTED, () => { later++; }),
    ] }).useStartupTimeout(30).useShutdownTimeout(500).build();
    const starting = kernel.start();
    const result = await outcome(starting);
    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(result.error).toBeInstanceOf(StartupTimeoutError);
      gate.resolve();
      await Bun.sleep(0);
      expect(later).toBe(0);
    } finally {
      gate.resolve();
      await starting.catch(() => {});
      await kernel.stop().catch(() => {});
    }
  });

  test("onStarted may await public stop without deadlocking startup", async () => {
    let stops = 0;
    const kernel = await builder(hosted({ start() {}, stop() { stops++; } })).build();
    kernel.lifetime.onStarted(() => kernel.stop({ exitCode: 23 }));
    const running = kernel.run();
    try {
      expect(await outcome(running)).toEqual({ kind: "resolved", value: 23 });
      expect(stops).toBe(1);
    } finally { await kernel.stop().catch(() => {}); }
  });

  test("started failure preserves a shutdown timeout with the original cause", async () => {
    const gate = Promise.withResolvers<void>();
    const original = new Error("audit started failure");
    const root = hosted({ start() {}, stop() { return gate.promise; } });
    const kernel = await builder({ providers: [...root.providers!, onEvent(APPLICATION_STARTED, () => { throw original; })] }).build();
    const starting = kernel.start();
    const result = await outcome(starting);
    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error).toBeInstanceOf(ShutdownTimeoutError);
        expect((result.error as Error).cause).toBe(original);
      }
    } finally { gate.resolve(); await starting.catch(() => {}); await kernel.stop().catch(() => {}); }
  });

  test("failed coordinator startup preserves a rollback timeout", async () => {
    const gate = Promise.withResolvers<void>();
    const original = new Error("audit hosted failure");
    const kernel = await builder(hosted(
      { start() {}, stop() { return gate.promise; } },
      { start() { throw original; }, stop() {} },
    )).build();
    const starting = kernel.start();
    const result = await outcome(starting);
    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error).toBeInstanceOf(ShutdownTimeoutError);
        expect((result.error as Error).cause).toBe(original);
      }
    } finally { gate.resolve(); await starting.catch(() => {}); await kernel.stop().catch(() => {}); }
  });

  test("failed startup does not hide a container disposal timeout", async () => {
    const gate = Promise.withResolvers<void>();
    const original = new Error("audit initial failure");
    const resource = { async [Symbol.asyncDispose]() { await gate.promise; } };
    const token = createToken<typeof resource>("Audit disposal resource");
    const root = hosted({ start() { throw original; }, stop() {} });
    // Factory-created resources are owned and disposed by DI; value providers are externally owned.
    const kernel = await builder({ providers: [...root.providers!, DI.singleton(DI.factoryProvider(token, [], () => resource))] }).build();
    kernel.container.resolve(token);
    const starting = kernel.start();
    const result = await outcome(starting);
    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error).toBeInstanceOf(ShutdownTimeoutError);
        expect((result.error as Error).cause).toBe(original);
      }
    } finally { gate.resolve(); await starting.catch(() => {}); await kernel.stop().catch(() => {}); }
  });

  test("stop joins and preserves an incomplete startup rollback", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const kernel = await builder(hosted(
      { start() {}, stop() { return gate.promise; } },
      { start(signal) { entered.resolve(); return new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true })); }, stop() {} },
    )).build();
    const starting = outcome(kernel.start());
    await entered.promise;
    const stopping = kernel.stop();
    try {
      const stopped = await outcome(stopping);
      const started = await starting;
      expect(stopped.kind).toBe("rejected");
      expect(started.kind).toBe("rejected");
      if (stopped.kind === "rejected" && started.kind === "rejected") {
        expect(stopped.error).toBeInstanceOf(ShutdownTimeoutError);
        expect(stopped.error).toBe(started.error);
        expect((stopped.error as Error).cause).toBeInstanceOf(StartupAbortedError);
      }
      expect(kernel.stop()).toBe(stopping);
      expect((await outcome(kernel.stop())).kind).toBe("rejected");
    } finally { gate.resolve(); await starting; await stopping.catch(() => {}); }
  });

  for (const mode of ["started-failure", "rollback-failure", "normal-stop"]) {
    test(`K08: Bazis facade terminates a process with live handles (${mode})`, async () => {
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/kernel.shutdown-timeout.fixture.ts`, mode], { stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const exit = await outcome(child.exited, 1500);
      if (exit.kind === "pending") child.kill("SIGKILL");
      await child.exited;
      const output = await stdout;
      const errors = await stderr;
      expect(exit).toEqual({ kind: "resolved", value: 1 });
      expect(errors).toContain("Forcing exit.");
      expect(output).not.toContain("FACADE_RETURNED");
    });
  }

  test("supervisor forwards the original startup signal", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const service = new SupervisedHostedService(() => ({ start(signal) { received = signal; }, stop() {} }));
    await (service as HostedService).start(controller.signal);
    await service.stop();
    expect(received).toBe(controller.signal);
  });

  test("a pre-aborted startup never invokes the factory", async () => {
    const controller = new AbortController();
    const reason = new StartupAbortedError();
    controller.abort(reason);
    let factories = 0;
    const service = new SupervisedHostedService(() => { factories++; return { start() {}, stop() {} }; });
    const result = await outcome(Promise.resolve().then(() => (service as HostedService).start(controller.signal)));
    expect(result).toEqual({ kind: "rejected", error: reason });
    expect(factories).toBe(0);
    await service.stop();
  });

  test("cancellation during backoff prevents every subsequent factory", async () => {
    const controller = new AbortController();
    const retry = Promise.withResolvers<void>();
    let attempts = 0;
    let stops = 0;
    const service = new SupervisedHostedService(() => ({
      start() { attempts++; throw new Error("retryable failure"); }, stop() { stops++; },
    }), { maxAttempts: 3, backoffMs: 40, onRetry() { retry.resolve(); } });
    const starting = Promise.resolve().then(() => (service as HostedService).start(controller.signal));
    const resultPromise = outcome(starting);
    await retry.promise;
    controller.abort(new StartupAbortedError());
    const result = await resultPromise;
    await Bun.sleep(100);
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.error).toBeInstanceOf(StartupAbortedError);
    expect(attempts).toBe(1);
    expect(stops).toBe(1);
  });

  test("supervisor cleans a cooperative cancelled inner without retrying", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let stops = 0;
    let factories = 0;
    const service = new SupervisedHostedService(() => {
      factories++;
      return {
        start(signal) { entered.resolve(); signal?.addEventListener("abort", () => gate.resolve(), { once: true }); return gate.promise; },
        stop() { stops++; },
      };
    });
    const starting = Promise.resolve().then(() => (service as HostedService).start(controller.signal));
    const resultPromise = outcome(starting);
    await entered.promise;
    controller.abort(new StartupAbortedError());
    const result = await resultPromise;
    try {
      expect(result.kind).toBe("rejected");
      expect(factories).toBe(1);
      expect(stops).toBe(1);
    } finally { gate.resolve(); await starting.catch(() => {}); await service.stop(); }
  });

  test("no supervised attempt starts after kernel stop has returned", async () => {
    const retry = Promise.withResolvers<void>();
    let attempts = 0;
    const wrapper = new SupervisedHostedService(() => ({
      start() { attempts++; throw new Error("retryable failure"); }, stop() {},
    }), { maxAttempts: 3, backoffMs: 40, onRetry() { retry.resolve(); } });
    const kernel = await builder(hosted(wrapper)).build();
    const starting = outcome(kernel.start());
    await retry.promise;
    await kernel.stop();
    expect((await starting).kind).toBe("rejected");
    const atStop = attempts;
    await Bun.sleep(100);
    expect(atStop).toBe(1);
    expect(attempts).toBe(atStop);
  });

  test("pre-aborted publish rejects even for an empty event and isolate mode", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled event");
    const event = createEventToken<void>("audit.cancel.empty");
    const kernel = await builder().build();
    controller.abort(reason);
    try {
      await expect(kernel.container.resolve(EventBus).publish(event, undefined, { signal: controller.signal, isolate: true })).rejects.toBe(reason);
    } finally { await kernel.stop(); }
  });

  test("cancelled scoped dispatch observes late rejection and skips remaining handlers", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled event");
    const event = createEventToken<void>("audit.cancel.scoped");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let later = 0;
    let observedErrors = 0;
    const kernel = await builder({ providers: [
      onEvent(event, () => { entered.resolve(); return gate.promise; }),
      onEvent(event, () => { later++; }),
    ] }).build();
    const scope = kernel.container.createScope();
    const publishing = kernel.container.resolve(EventBus).publishScoped(scope, event, undefined, {
      signal: controller.signal, handlerTimeoutMs: 500, isolate: true, onError() { observedErrors++; },
    });
    const result = outcome(publishing);
    await entered.promise;
    controller.abort(reason);
    try {
      expect(await result).toEqual({ kind: "rejected", error: reason });
      gate.reject(new Error("late handler rejection"));
      await Bun.sleep(0);
      expect(later).toBe(0);
      expect(observedErrors).toBe(0);
    } finally { gate.resolve(); await scope.dispose(); await kernel.stop(); }
  });

  test("failed formatting never invokes a raw field toString", () => {
    const lines: string[] = [];
    const original = console.info;
    let stringifications = 0;
    console.info = value => { lines.push(String(value)); };
    try {
      const logger = new ConsoleLogger();
      logger.info("safe", { password: "SYNTHETIC_PASSWORD" });
      logger.info("broken", { password: "SYNTHETIC_PASSWORD", get bad() { throw new Error("broken getter"); }, toString() { stringifications++; return "SYNTHETIC_PASSWORD"; } });
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).not.toContain("SYNTHETIC_PASSWORD");
      expect(stringifications).toBe(0);
    } finally { console.info = original; }
  });

  test("an object that cannot enumerate fields still produces a safe log", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = value => { lines.push(String(value)); };
    try {
      const fields = new Proxy({}, { ownKeys() { throw new Error("SYNTHETIC_PASSWORD"); } });
      expect(() => new ConsoleLogger().info("broken", fields)).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("SYNTHETIC_PASSWORD");
    } finally { console.info = original; }
  });

  test("invalid timer budgets fail before loading configuration", async () => {
    let loads = 0;
    const accepted: string[] = [];
    for (const name of ["startupTimeoutMs", "shutdownTimeoutMs"] as const) {
      for (const value of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
        const candidate = builder().useOptions({ [name]: value }).addConfigSource({ description: "audit", load() { loads++; return {}; } });
        try { const kernel = await candidate.build(); accepted.push(`${name}:${value}`); await kernel.stop(); }
        catch (error) { expect(error).toBeInstanceOf(KernelError); }
      }
    }
    expect(accepted).toEqual([]);
    expect(loads).toBe(0);
  });

  test("zero and the maximum timer budget remain valid", async () => {
    for (const value of [0, 1, 2_147_483_647]) {
      const kernel = await builder().useOptions({ startupTimeoutMs: value, shutdownTimeoutMs: value }).build();
      await kernel.start();
      await kernel.stop();
    }
  });

  test("every run caller joins one operation and receives the same exit code", async () => {
    const kernel = await builder().build();
    await kernel.start();
    const first = kernel.run();
    const second = kernel.run();
    await Bun.sleep(0);
    kernel.lifetime.stop(19);
    const results = await Promise.all([outcome(first), outcome(second)]);
    expect(first).toBe(second);
    expect(results).toEqual([{ kind: "resolved", value: 19 }, { kind: "resolved", value: 19 }]);
    expect(kernel.run()).toBe(first);
    await kernel.stop();
  });

  test("repeated run installs one signal listener and removes it after stop", async () => {
    const before = process.listenerCount("SIGUSR2");
    const kernel = await builder().useSignals(["SIGUSR2"]).build();
    const first = kernel.run();
    const second = kernel.run();
    try {
      expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
      // A programmatic stop also exercises removal without broadcasting a process signal.
      kernel.lifetime.stop(0);
      expect(await first).toBe(0);
      expect(await second).toBe(0);
      expect(process.listenerCount("SIGUSR2")).toBe(before);
    } finally { await kernel.stop(); }
  });

  test("Configuration owns a snapshot of its input map", () => {
    const values = new Map([["db.host", "before"]]);
    const config = new Configuration(values);
    values.set("db.host", "after");
    values.set("new", "key");
    expect(config.get("db.host")).toBe("before");
    expect(config.keys()).toEqual(["db.host"]);
  });

  test("two kernels share a declaration and retain independent views", async () => {
    const config = defineConfig("kernel_audit", { default: { mode: "default" }, production: { mode: "prod" }, test: { mode: "test" } });
    const root = { config };
    const first = await builder(root).useEnvironment("production").build();
    const second = await builder(root).build();
    try {
      expect(first.container.resolve(config.token).get("mode")).toBe("prod");
      expect(second.container.resolve(config.token).get("mode")).toBe("test");
      const same = await builder(root).useEnvironment("production").build();
      await same.stop();
      expect(first.container.resolve(config.token).get("mode")).toBe("prod");
    } finally { await first.stop(); await second.stop(); }
  });

  test("failed validation never pins an environment", () => {
    const config = defineConfig("kernel_audit_unset", { default: { key: secret("test-only") }, production: { key: secret() } });
    expect(() => config.ensureValid("production")).toThrow(KernelError);
    expect(() => config.ensureValid("test")).not.toThrow();
    expect(config.get("key").reveal()).toBe("test-only");
  });
});
