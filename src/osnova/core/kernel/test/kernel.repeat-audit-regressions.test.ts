import { expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, createToken, type OsnovaModuleRef } from "../../di";
import { LIFECYCLE_HOOK, Osnova, ShutdownTimeoutError, StartupAbortedError, SupervisedHostedService, type LifecycleHook } from "../index";

const builder = (root: OsnovaModuleRef) => Osnova.createBuilder(root)
  .useEnvironment("test").useStartupReport(false).useSignals([])
  .useUnhandledErrorPolicy("none").useStartupTimeout(1000).useShutdownTimeout(500);

function resource(log: string[]) {
  const disposed = Promise.withResolvers<void>();
  const token = createToken<{ dispose(): void }>("Repeat audit resource");
  return {
    token, disposed,
    provider: DI.singleton(DI.factoryProvider(token, [], () => ({ dispose() { log.push("dispose"); disposed.resolve(); } }))),
  };
}

for (const hookName of ["onInit", "onBootstrap"] as const) {
  for (const mode of ["stop", "run"] as const) {
    test(`${hookName}: ${mode} joins the running hook before destroy and container disposal`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const log: string[] = [];
      const owned = resource(log);
      let live = false;
      const hook: LifecycleHook = {
        async [hookName]() { entered.resolve(); await release.promise; live = true; log.push("acquire"); },
        onDestroy() { live = false; log.push("destroy"); },
      };
      const kernel = await builder({ providers: [owned.provider,
        DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, hook)),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, { start() { log.push("service:start"); }, stop() { log.push("service:stop"); } })),
      ] }).useShutdownTimeout(mode === "run" ? 0 : 500).build();
      kernel.container.resolve(owned.token);
      const starting = mode === "stop" ? kernel.start().then(() => undefined, error => error) : undefined;
      const running = mode === "run" ? kernel.run() : undefined;
      await entered.promise;
      let completed = false;
      const stopping = mode === "stop" ? kernel.stop().then(() => { completed = true; }) : undefined;
      if (mode === "run") { kernel.lifetime.stop(7); void running!.then(() => { completed = true; }); }
      await Bun.sleep(0);
      expect(completed).toBe(false);
      expect(log).not.toContain("destroy");
      expect(log).not.toContain("dispose");
      release.resolve();
      if (mode === "stop") {
        await stopping;
        expect(await starting).toBeInstanceOf(StartupAbortedError);
      } else expect(await running).toBe(7);
      expect(live).toBe(false);
      expect(log).toEqual(hookName === "onInit" ? ["acquire", "destroy", "dispose"]
        : ["service:start", "acquire", "service:stop", "destroy", "dispose"]);
      await kernel.stop();
      expect(log.filter(value => value === "destroy")).toHaveLength(1);
    });
  }
}

for (const hookName of ["onInit", "onBootstrap"] as const) {
  test(`${hookName}: timeout is not successful cleanup; late completion still disposes in order`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const log: string[] = [];
    const owned = resource(log);
    const hook: LifecycleHook = {
      async [hookName]() { entered.resolve(); await release.promise; log.push("acquire"); },
      onDestroy() { log.push("destroy"); },
    };
    const kernel = await builder({ providers: [owned.provider, DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, hook))] })
      .useShutdownTimeout(20).build();
    kernel.container.resolve(owned.token);
    const starting = kernel.start().catch(error => error);
    await entered.promise;
    const stopped = await kernel.stop().catch(error => error);
    expect(stopped).toBeInstanceOf(ShutdownTimeoutError);
    expect(stopped.cause).toBeInstanceOf(StartupAbortedError);
    expect(await starting).toBe(stopped);
    expect(log).toEqual([]);
    release.resolve();
    await owned.disposed.promise;
    expect(log).toEqual(["acquire", "destroy", "dispose"]);
    await expect(kernel.stop()).rejects.toBe(stopped);
  });
}

test("late hook rejection and destroy failure remain visible while other cleanup runs", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const log: string[] = [];
  const owned = resource(log);
  const lateError = new Error("late init failed");
  const destroyError = new Error("destroy failed");
  const kernel = await builder({ providers: [owned.provider,
    DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, { onDestroy() { log.push("other:destroy"); } })),
    DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, {
      async onInit() { entered.resolve(); await release.promise; },
      onDestroy() { log.push("destroy"); throw destroyError; },
    })),
  ] }).build();
  kernel.container.resolve(owned.token);
  const starting = kernel.start().catch(error => error);
  await entered.promise;
  const stopping = kernel.stop().catch(error => error);
  release.reject(lateError);
  const failure = await starting;
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = flattenErrors(failure);
  expect(errors.some(error => error instanceof StartupAbortedError)).toBe(true);
  expect(errors).toContain(lateError);
  expect(errors).toContain(destroyError);
  expect(await stopping).toBe(failure);
  expect(log).toEqual(["destroy", "other:destroy", "dispose"]);
});

test("a late cleanup failure after the deadline is reported safely and does not skip disposal", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const log: string[] = [];
  const owned = resource(log);
  const messages: unknown[][] = [];
  const previous = console.error;
  console.error = (...args) => { messages.push(args); };
  try {
    const kernel = await builder({ providers: [owned.provider, DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, {
      async onInit() { entered.resolve(); await release.promise; },
      onDestroy() { log.push("destroy"); throw new Error("token=do-not-log"); },
    }))] }).useShutdownTimeout(20).build();
    kernel.container.resolve(owned.token);
    const starting = kernel.start().catch(error => error);
    await entered.promise;
    await expect(kernel.stop()).rejects.toBeInstanceOf(ShutdownTimeoutError);
    expect(await starting).toBeInstanceOf(ShutdownTimeoutError);
    release.resolve();
    await owned.disposed.promise;
    await Bun.sleep(0);
    expect(log).toEqual(["destroy", "dispose"]);
    expect(messages).toEqual([["[osnv] startup.cleanup failed."]]);
    expect(JSON.stringify(messages)).not.toContain("do-not-log");
  } finally { release.resolve(); console.error = previous; }
});

test("an undefined disposal rejection is preserved alongside the startup error", async () => {
  const failure = new Error("startup failed");
  const token = createToken<object>("Undefined cleanup rejection");
  const kernel = await builder({ providers: [
    DI.singleton(DI.factoryProvider(token, [], () => ({ dispose() { throw undefined; } }))),
    DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, { onInit() { throw failure; } })),
  ] }).build();
  kernel.container.resolve(token);
  const outcome = await kernel.start().catch(error => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(flattenErrors(outcome)).toContain(failure);
  expect(flattenErrors(outcome)).toContain(undefined);
  await expect(kernel.stop()).rejects.toBe(outcome);
});

test("an exhausted rollback budget cannot be reset by immediate container disposal", async () => {
  const failure = new Error("startup failed");
  const kernel = await builder({ providers: [DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, {
    onInit() { throw failure; },
    onDestroy() {
      // Synchronous work prevents timers from firing, but does not extend the deadline.
      const started = performance.now();
      while (performance.now() - started < 25) { /* bounded synchronous cleanup */ }
    },
  }))] }).useShutdownTimeout(10).build();
  const outcome = await kernel.start().catch(error => error);
  expect(outcome).toBeInstanceOf(ShutdownTimeoutError);
  expect(outcome.cause).toBe(failure);
  await expect(kernel.stop()).rejects.toBe(outcome);
});

for (const mode of ["throw", "reject", "thenable", "then-getter", "throwing-sink", "rejecting-sink"] as const) {
  test(`supervisor recovers when onRetry diagnostics fail (${mode})`, async () => {
    const messages: unknown[][] = [];
    const previous = console.error;
    console.error = (...args) => {
      messages.push(args);
      if (mode === "throwing-sink") throw new Error("sink failed");
      if (mode === "rejecting-sink") return Promise.reject(new Error("sink failed")) as unknown as void;
    };
    let starts = 0;
    let stops = 0;
    const error = new Error("token=observer-secret");
    const service = new SupervisedHostedService(() => ({
      start() { if (++starts < 3) throw new Error("transient"); }, stop() { stops++; },
    }), { maxAttempts: 3, backoffMs: 0, onRetry() {
      if (mode === "reject") return Promise.reject(error);
      if (mode === "thenable") return { then(_resolve: unknown, reject: (error: unknown) => void) { reject(error); } };
      if (mode === "then-getter") return { get then() { throw error; } };
      throw error;
    } });
    try {
      await service.start();
      await service.stop();
      await Bun.sleep(0);
      expect(starts).toBe(3);
      expect(stops).toBe(3);
      expect(messages).toEqual([["[osnv] supervised.onRetry failed."], ["[osnv] supervised.onRetry failed."]]);
      expect(JSON.stringify(messages)).not.toContain("observer-secret");
    } finally { console.error = previous; }
  });
}

test("a pending observer cannot hold recovery and the final startup error is preserved", async () => {
  const failure = new Error("original failure");
  let starts = 0;
  const service = new SupervisedHostedService(() => ({
    start() { starts++; throw failure; }, stop() {},
  }), { maxAttempts: 2, backoffMs: 0, onRetry: () => new Promise<void>(() => {}) });
  await expect(service.start()).rejects.toBe(failure);
  expect(starts).toBe(2);
  await service.stop();
});

for (const mode of ["single", "duplicate", "mutated", "second"] as const) {
  test(`signal snapshot preserves graceful shutdown and second-delivery semantics (${mode})`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/fixtures/kernel.signals.fixture.ts`, mode], { stdout: "pipe", stderr: "pipe" });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const exit = await child.exited;
    const text = await output;
    expect(await errors).toBe("");
    if (mode === "second") {
      expect(exit).toBe(130);
      expect(text).toBe("STARTED\nSTOP_ENTER\n");
    } else {
      expect(exit).toBe(0);
      expect(text).toBe("STARTED\nSTOP_ENTER\nSTOPPED\nRETURNED 0\n");
    }
  });
}

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error];
}
