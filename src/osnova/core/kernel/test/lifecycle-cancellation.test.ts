import { expect, test } from "bun:test";
import { HOSTED_SERVICE, type HostedService } from "../../di";
import { LifecycleCoordinator } from "../LifecycleCoordinator";
import { LIFECYCLE_HOOK } from "../lifecycleHooks";
import type { LifecycleHook } from "../types";

function coordinator(services: HostedService[], hooks: LifecycleHook[] = []) {
  return new LifecycleCoordinator({ resolveAll<T>(token: unknown): readonly T[] {
    return (token === HOSTED_SERVICE ? services : token === LIFECYCLE_HOOK ? hooks : []) as unknown as readonly T[];
  } });
}

for (const withHook of [false, true]) {
  for (const timing of ["before-start", "before-microtask"] as const) {
    test(`cancelled startup does not call init/start (${timing}, hook=${withHook})`, async () => {
      const signal = new AbortController();
      const reason = new Error("cancelled startup");
      const events: string[] = [];
      const lifecycle = coordinator([
        { start() { events.push("start"); }, stop() { events.push("stop"); } },
      ], withHook ? [{ onInit() { events.push("init"); }, onBootstrap() { events.push("bootstrap"); } }] : []);
      if (timing === "before-start") signal.abort(reason);
      const starting = lifecycle.start(signal.signal);
      if (timing === "before-microtask") signal.abort(reason);
      await expect(starting).rejects.toBe(reason);
      await Bun.sleep(0);
      expect(events).toEqual([]);
      expect(lifecycle.startedHostedCount).toBe(0);
    });
  }
}

test("startup cancelled while resolving the plan does not invoke its first callback", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const reason = new Error("cancelled before callback");
  const lifecycle = new LifecycleCoordinator({ resolveAll<T>(token: unknown): readonly T[] {
    if (token === HOSTED_SERVICE) {
      queueMicrotask(() => controller.abort(reason));
      return [{ start() { events.push("start"); }, stop() { events.push("stop"); } }] as unknown as readonly T[];
    }
    return [];
  } });
  await expect(lifecycle.start(controller.signal)).rejects.toBe(reason);
  await Bun.sleep(0);
  expect(events).toEqual([]);
});

test("cancellation between init and bootstrap prevents the planned bootstrap callback", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before bootstrap");
  const events: string[] = [];
  const lifecycle = coordinator([], [{
    onInit() {
      events.push("init");
      queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
    },
    onBootstrap() { events.push("bootstrap"); },
  }]);
  await expect(lifecycle.start(controller.signal)).rejects.toBe(reason);
  await Bun.sleep(0);
  expect(events).toEqual(["init"]);
});

test("late successful startup is still stopped exactly once after cancellation", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const lifecycle = coordinator([
    { start() { events.push("start:0"); }, stop() { events.push("stop:0"); } },
    { async start() { events.push("start:1"); entered.resolve(); await release.promise; }, stop() { events.push("stop:1"); } },
  ]);
  const starting = lifecycle.start(controller.signal);
  await entered.promise;
  const reason = new Error("cancelled running startup");
  controller.abort(reason);
  try {
    await expect(starting).rejects.toBe(reason);
    expect(events).toEqual(["start:0", "start:1", "stop:0"]);
  } finally {
    release.resolve();
    await Bun.sleep(0);
  }
  expect(events).toEqual(["start:0", "start:1", "stop:0", "stop:1"]);
  await lifecycle.stopServices();
  expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(2);
});
