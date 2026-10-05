import { describe, expect, test } from "bun:test";
import {
  Application, HOSTED_SERVICE, ServiceCollection, addHostedService,
  startHostedServices, stopHostedServices, type HostedService, type HostedServicePlanValidator,
} from "../index";

describe("hosted lifecycle audit regressions", () => {
  test("helpers stop the exact started transient instance and release its timer once", async () => {
    const events: string[] = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    let allocated = 0;
    const collection = new ServiceCollection();
    addHostedService(collection, () => {
      const id = ++allocated;
      let timer: ReturnType<typeof setInterval> | undefined;
      return {
        start() {
          events.push(`start:${id}`);
          timer = setInterval(() => {}, 60_000);
          timers.add(timer);
        },
        stop() {
          events.push(`stop:${id}`);
          if (timer !== undefined) {
            clearInterval(timer);
            timers.delete(timer);
          }
        },
      };
    });
    const provider = collection.buildServiceProvider();
    try {
      await startHostedServices(provider);
      expect(timers.size).toBe(1);
      await stopHostedServices(provider);
      await stopHostedServices(provider);
      expect(allocated).toBe(1);
      expect(events).toEqual(["start:1", "stop:1"]);
      expect(timers.size).toBe(0);
    } finally {
      for (const timer of timers) clearInterval(timer);
      await provider.dispose();
    }
  });

  test("a separate provider has a separate hosted lifecycle", async () => {
    const events: string[] = [];
    let allocated = 0;
    const collection = new ServiceCollection();
    addHostedService(collection, () => {
      const id = ++allocated;
      return { start() { events.push(`start:${id}`); }, stop() { events.push(`stop:${id}`); } };
    });
    const first = collection.buildServiceProvider();
    const second = collection.buildServiceProvider();
    try {
      await startHostedServices(first);
      await startHostedServices(second);
      await stopHostedServices(first);
      await stopHostedServices(second);
      expect(events).toEqual(["start:1", "start:2", "stop:1", "stop:2"]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  test("concurrent starts share one run and a completed stop permits a fresh run", async () => {
    const events: string[] = [];
    let allocated = 0;
    const resolver = { resolveAll: () => {
      const id = ++allocated;
      return [{ start() { events.push(`start:${id}`); }, stop() { events.push(`stop:${id}`); } }];
    } };
    await Promise.all([startHostedServices(resolver), startHostedServices(resolver)]);
    await stopHostedServices(resolver);
    await startHostedServices(resolver);
    await stopHostedServices(resolver);
    expect(events).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
    expect(allocated).toBe(2);
  });

  test.each([0, 1, 2])("stop continues after failure at reverse index %i", async (failureIndex) => {
    const events: number[] = [];
    const failure = new Error(`stop failed:${failureIndex}`);
    const hosted: HostedService[] = [0, 1, 2].map((id) => ({
      start() {},
      stop() {
        events.push(id);
        if (id === 2 - failureIndex) throw failure;
      },
    }));
    const resolver = { resolveAll: () => hosted };
    await expect(stopHostedServices(resolver)).rejects.toBe(failure);
    await expect(stopHostedServices(resolver)).rejects.toBe(failure);
    expect(events).toEqual([2, 1, 0]);
  });

  test("stop exposes all failures after trying every service", async () => {
    const failures = [new Error("first"), new Error("second")];
    const events: number[] = [];
    const resolver = { resolveAll: () => failures.map((failure, id) => ({
      start() {}, stop() { events.push(id); throw failure; },
    })) };
    const error = await stopHostedServices(resolver).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([...failures].reverse());
    expect(events).toEqual([1, 0]);
  });

  test("concurrent stop waits for startup and stops each started service once", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const resolver = { resolveAll: () => [{
      async start() { events.push("start"); entered.resolve(); await release.promise; },
      stop() { events.push("stop"); },
    }] };
    const starting = startHostedServices(resolver);
    await entered.promise;
    const first = stopHostedServices(resolver);
    const second = stopHostedServices(resolver);
    try {
      await Bun.sleep(0);
      expect(events).toEqual(["start"]);
    } finally {
      release.resolve();
      await Promise.all([starting, first, second]);
    }
    expect(events).toEqual(["start", "stop"]);
  });

  test.each([
    ["sync start failure", "sync", false],
    ["sync start and stop failures", "sync", true],
    ["async start failure", "async", false],
    ["async start and stop failures", "async", true],
  ] as const)("helpers clean partial resources after %s", async (_scenario, startMode, stopThrows) => {
    const events: string[] = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    const startFailure = new Error("startup failed after acquiring a timer");
    const stopFailure = new Error("partial startup cleanup failed after releasing its timer");
    let allocated = 0;
    const collection = new ServiceCollection();
    for (const id of [0, 1, 2]) {
      addHostedService(collection, () => {
        const instance = ++allocated;
        let timer: ReturnType<typeof setInterval> | undefined;
        return {
          start() {
            events.push(`start:${id}:${instance}`);
            timer = setInterval(() => {}, 60_000);
            timers.add(timer);
            if (id === 1) {
              if (startMode === "async") return Promise.resolve().then(() => { throw startFailure; });
              throw startFailure;
            }
          },
          stop() {
            events.push(`stop:${id}:${instance}`);
            if (timer !== undefined) {
              clearInterval(timer);
              timers.delete(timer);
              timer = undefined;
            }
            if (id === 1 && stopThrows) throw stopFailure;
          },
        };
      });
    }
    const provider = collection.buildServiceProvider();
    try {
      await expect(startHostedServices(provider)).rejects.toBe(startFailure);
      expect(timers.size).toBe(2);
      expect(allocated).toBe(3);
      if (stopThrows) {
        await expect(stopHostedServices(provider)).rejects.toBe(stopFailure);
        await expect(stopHostedServices(provider)).rejects.toBe(stopFailure);
      } else {
        await stopHostedServices(provider);
        await stopHostedServices(provider);
      }
      expect(timers.size).toBe(0);
      expect(events).toEqual(["start:0:1", "start:1:2", "stop:1:2", "stop:0:1"]);
      expect(allocated).toBe(3);
    } finally {
      for (const timer of timers) clearInterval(timer);
      await provider.dispose();
    }
  });

  test("Application rejects an invalid plan before start and keeps validation as the primary error", async () => {
    const failure = new Error("invalid hosted plan");
    const events: string[] = [];
    const service: HostedService = {
      planValidator: { validate() { events.push("validate"); throw failure; } },
      start() { events.push("start"); }, stop() { events.push("stop"); },
    };
    const host = {
      resolveAll<T>(token: unknown): readonly T[] { return (token === HOSTED_SERVICE ? [service] : []) as unknown as readonly T[]; },
      async dispose() { events.push("dispose"); throw new Error("dispose failed"); },
    };
    const result = await Application.start(host).then((app) => ({ app }), (error: unknown) => ({ error }));
    try {
      expect(result).toEqual({ error: failure });
      expect(events).toEqual(["validate", "dispose"]);
    } finally {
      if ("app" in result) await result.app.stop().catch(() => {});
    }
  });

  test("Application awaits each shared validator once before starting the whole plan", async () => {
    const events: string[] = [];
    const validator: HostedServicePlanValidator = { async validate(plan) {
      expect(Object.isFrozen(plan)).toBe(true);
      expect(plan).toHaveLength(2);
      await Bun.sleep(0);
      events.push("validate");
    } };
    const services: HostedService[] = [0, 1].map((id) => ({
      planValidator: validator,
      start() { events.push(`start:${id}`); }, stop() { events.push(`stop:${id}`); },
    }));
    const app = await Application.start({
      resolveAll<T>(token: unknown): readonly T[] { return (token === HOSTED_SERVICE ? services : []) as unknown as readonly T[]; },
      async dispose() { events.push("dispose"); },
    });
    await app.stop();
    expect(events).toEqual(["validate", "start:0", "start:1", "stop:1", "stop:0", "dispose"]);
  });
});
