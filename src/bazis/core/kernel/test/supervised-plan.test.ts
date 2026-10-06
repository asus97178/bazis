import { describe, expect, test } from "bun:test";
import { Application, HOSTED_SERVICE, startHostedServices, type HostedService, type HostedServicePlanValidator } from "../../di";
import { validateHostedServicePlan } from "../../di/extensions/hosted-service";
import { LifecycleCoordinator } from "../LifecycleCoordinator";
import { LIFECYCLE_HOOK } from "../lifecycleHooks";
import { SupervisedHostedService } from "../SupervisedHostedService";

function resolver(services: readonly HostedService[], events: string[]) {
  return {
    resolveAll<T>(token: unknown): readonly T[] {
      return (token === HOSTED_SERVICE ? services
        : token === LIFECYCLE_HOOK ? [{ onInit() { events.push("init"); } }] : []) as unknown as readonly T[];
    },
    async dispose() {},
  };
}

describe("supervised hosted plan admission", () => {
  test.each(["kernel", "application", "helper"] as const)("%s materializes all wrappers before validation and preserves its scheduling", async host => {
    const events: string[] = [];
    const validator: HostedServicePlanValidator = { validate(plan) {
      events.push("validate");
      expect(Object.isFrozen(plan)).toBe(true);
      expect(plan).toEqual([later, earlier]);
      expect(plan[0]).toBe(later);
      expect(plan[1]).toBe(earlier);
    } };
    const later = { phase: 5, planValidator: validator, start() { events.push("later"); }, stop() {} };
    const earlier = { phase: -5, planValidator: validator, start() { events.push("earlier"); }, stop() {} };
    const services = resolver([
      new SupervisedHostedService(() => { events.push("create later"); return later; }),
      new SupervisedHostedService(() => new SupervisedHostedService(() => { events.push("create earlier"); return earlier; })),
    ], events);
    if (host === "kernel") await new LifecycleCoordinator(services).start();
    else if (host === "application") await Application.start(services);
    else await startHostedServices(services);
    expect(events).toEqual(["create later", "create earlier", "validate",
      ...(host === "kernel" ? ["init", "earlier", "later"] : ["later", "earlier"])]);
  });

  test.each(["kernel", "application", "helper"] as const)("%s rejects a concrete plan before any service or hook", async host => {
    const events: string[] = [];
    const wrapped = new SupervisedHostedService(() => ({
      planValidator: { validate() { events.push("validate"); throw new Error("invalid plan"); } },
      start() { events.push("inner start"); }, stop() { events.push("inner stop"); },
    }));
    const services = resolver([{ phase: -10, start() { events.push("earlier start"); }, stop() {} }, wrapped], events);
    const work = host === "kernel" ? new LifecycleCoordinator(services).start()
      : host === "application" ? Application.start(services) : startHostedServices(services);
    await expect(work).rejects.toThrow("invalid plan");
    expect(events).toEqual(["validate"]);
  });

  test("preflight reuses the first instance and preserves an explicit override without validators", async () => {
    const events: string[] = [];
    let factories = 0;
    const wrapped = new SupervisedHostedService(() => {
      const id = ++factories;
      return { start() { events.push(`start:${id}`); }, stop() { events.push(`stop:${id}`); } };
    }, { phase: -5 });
    const plan = [wrapped, { start() { events.push("later start"); }, stop() { events.push("later stop"); } }];
    await wrapped.planValidator.validate(plan);
    await wrapped.planValidator.validate(plan);
    const coordinator = new LifecycleCoordinator(resolver(plan, events));
    await coordinator.start();
    await coordinator.stopServices();
    expect(factories).toBe(1);
    expect(wrapped.phase).toBe(-5);
    expect(events).toEqual(["init", "start:1", "later start", "later stop", "stop:1"]);
  });

  test("any plan validator requires the scheduled and concrete phases to agree", async () => {
    let calls = 0;
    const validator = { validate() { calls++; } };
    const inner = Object.freeze({ phase: -105, planValidator: validator, start() { calls++; }, stop() {} });
    await expect(new SupervisedHostedService(() => inner, { phase: 0 }).start()).rejects.toThrow("phase conflicts");
    expect(calls).toBe(0);
    expect(inner.phase).toBe(-105);
    const correct = new SupervisedHostedService(() => inner, { phase: -105 });
    await correct.start();
    expect(calls).toBe(2);
    await correct.stop();
    const other = { planValidator: validator, start() {}, stop() {} };
    const wrong = new SupervisedHostedService(() => ({ start() {}, stop() {} }), { phase: -10 });
    await expect(Promise.resolve().then(() => validateHostedServicePlan([other, wrong]))).rejects.toThrow("phase conflicts");
  });

  test("retry validates the whole current plan and shares one frozen array among validators", async () => {
    const events: string[] = [];
    const snapshots: (readonly HostedService[])[] = [];
    let currentPlan: readonly HostedService[] | undefined;
    const firstValidator: HostedServicePlanValidator = { validate(plan) {
      expect(Object.isFrozen(plan)).toBe(true);
      currentPlan = plan;
      snapshots.push(plan);
      events.push("validate");
    } };
    const secondValidator: HostedServicePlanValidator = { validate(plan) { expect(plan).toBe(currentPlan!); } };
    const sibling = { phase: -1, planValidator: secondValidator, start() { events.push("sibling"); }, stop() {} };
    let factories = 0;
    const instances: HostedService[] = [];
    const wrapped = new SupervisedHostedService(() => {
      const id = ++factories;
      const service = { planValidator: firstValidator, start() { events.push(`start:${id}`); if (id === 1) throw new Error("retry"); }, stop() { events.push(`stop:${id}`); } };
      instances.push(service);
      return service;
    }, { backoffMs: 0 });
    await new LifecycleCoordinator(resolver([wrapped, sibling], events)).start();
    expect(events).toEqual(["validate", "init", "sibling", "start:1", "stop:1", "validate", "start:2"]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual([instances[0]!, sibling]);
    expect(snapshots[1]).toEqual([instances[1]!, sibling]);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    await wrapped.stop();
  });

  test("retry cannot introduce a conflicting validator or change its fixed phase", async () => {
    for (const kind of ["validator", "phase"] as const) {
      const events: string[] = [];
      let factories = 0;
      const wrapped = new SupervisedHostedService(() => ++factories === 1
        ? { start() { events.push("first start"); throw new Error("retry"); }, stop() { events.push("first stop"); } }
        : { phase: kind === "phase" ? -1 : 0,
          ...(kind === "validator" ? { planValidator: { validate() { throw new Error("conflicting candidate"); } } } : {}),
          start() { events.push("forbidden start"); }, stop() { events.push("forbidden stop"); } },
      { maxAttempts: 3, backoffMs: 0 });
      await expect(wrapped.start()).rejects.toThrow(kind === "phase" ? "cannot change" : "conflicting candidate");
      expect(factories).toBe(2);
      expect(events).toEqual(["first start", "first stop"]);
    }
  });

  test("replacement of a nested wrapper binds its descendants to the same full plan", async () => {
    const snapshots: (readonly HostedService[])[] = [];
    const validator = { validate(plan: readonly HostedService[]) { snapshots.push(plan); } };
    let outerAttempts = 0;
    let leafAttempts = 0;
    const sibling = { planValidator: validator, start() {}, stop() {} };
    const wrapped = new SupervisedHostedService(() => {
      const outerId = ++outerAttempts;
      return new SupervisedHostedService(() => {
        const id = ++leafAttempts;
        return { planValidator: validator, start() { if (outerId === 1 || id === 2) throw new Error("retry"); }, stop() {} };
      }, { maxAttempts: outerId === 1 ? 1 : 2, backoffMs: 0 });
    }, { maxAttempts: 2, backoffMs: 0 });
    await validateHostedServicePlan([wrapped, sibling]);
    await wrapped.start();
    expect(outerAttempts).toBe(2);
    expect(leafAttempts).toBe(3);
    expect(snapshots).toHaveLength(3);
    for (const plan of snapshots) { expect(plan).toHaveLength(2); expect(plan[1]).toBe(sibling); }
    expect(new Set(snapshots.map(plan => plan[0])).size).toBe(3);
    await wrapped.stop();
  });

  test("failed cleanup preserves both errors and forbids another factory attempt", async () => {
    let factories = 0;
    const startError = new Error("start failed");
    const stopError = new Error("cleanup failed");
    const wrapped = new SupervisedHostedService(() => { factories++; return { start() { throw startError; }, stop() { throw stopError; } }; });
    const error = await wrapped.start().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([startError, stopError]);
    expect(factories).toBe(1);
  });

  test("cancelled initial and replacement admission never start their candidates", async () => {
    let factories = 0;
    const cancelled = new SupervisedHostedService(() => { factories++; return { start() {}, stop() {} }; });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(cancelled.start(controller.signal)).rejects.toThrow("cancelled");
    expect(factories).toBe(0);
    const retryController = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let starts = 0;
    const wrapped = new SupervisedHostedService(() => ++factories === 1
      ? { start() { starts++; throw new Error("retry"); }, stop() {} }
      : { planValidator: { async validate(_plan: readonly HostedService[], signal?: AbortSignal) {
        expect(signal).toBe(retryController.signal); entered.resolve(); await gate.promise;
      } }, start() { starts++; }, stop() {} }, { backoffMs: 0 });
    const starting = wrapped.start(retryController.signal);
    await entered.promise;
    retryController.abort(new Error("cancelled replacement"));
    await expect(starting).rejects.toThrow("cancelled replacement");
    gate.resolve();
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(factories).toBe(2);
  });

  test("cycles and shared concrete identities fail before validators or starts", async () => {
    let effects = 0;
    const leaf = { planValidator: { validate() { effects++; } }, start() { effects++; }, stop() {} };
    const shared = [new SupervisedHostedService(() => leaf), new SupervisedHostedService(() => leaf)];
    await expect(Promise.resolve().then(() => validateHostedServicePlan(shared))).rejects.toThrow("duplicate service identity");
    let cycle: SupervisedHostedService;
    cycle = new SupervisedHostedService(() => new SupervisedHostedService(() => cycle));
    await expect(cycle.start()).rejects.toThrow("factory cycle");
    expect(effects).toBe(0);
  });

  test("a successfully stopped instance may be returned again and is revalidated", async () => {
    let starts = 0;
    let stops = 0;
    let checks = 0;
    const leaf = { planValidator: { validate(plan: readonly HostedService[]) { checks++; expect(plan[0]).toBe(leaf); } },
      start() { if (++starts === 1) throw new Error("retry"); }, stop() { stops++; } };
    const wrapped = new SupervisedHostedService(() => leaf, { backoffMs: 0 });
    await wrapped.start();
    await wrapped.stop();
    expect([starts, stops, checks]).toEqual([2, 2, 2]);
  });

  test("concurrent replacements validate and commit against the latest complete plan", async () => {
    type Named = HostedService & { label: string };
    const plans: string[][] = [];
    const started: string[] = [];
    let validating = 0;
    let peak = 0;
    const validator: HostedServicePlanValidator = { async validate(plan) {
      peak = Math.max(peak, ++validating);
      await Promise.resolve();
      const labels = plan.map(service => (service as Named).label);
      plans.push(labels);
      validating--;
      if (new Set(labels).size !== labels.length) throw new Error("duplicate capability");
    } };
    const make = (name: string) => {
      let attempts = 0;
      return new SupervisedHostedService(() => {
        const id = ++attempts;
        return { label: id === 1 ? name : "shared", planValidator: validator,
          start() { if (id === 1) throw new Error("retry"); started.push(name); }, stop() {} } as Named;
      }, { maxAttempts: 2, backoffMs: 0 });
    };
    const first = make("first");
    const second = make("second");
    await validateHostedServicePlan([first, second]);
    const results = await Promise.allSettled([first.start(), second.start()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(peak).toBe(1);
    expect(plans).toHaveLength(3);
    expect(plans[0]).toEqual(["first", "second"]);
    expect(plans[2]).toEqual(["shared", "shared"]);
    await Promise.all([first.stop(), second.stop()]);
  });

  test.each(["success", "failure"] as const)("concurrent stops share one %s cleanup and its outcome", async outcome => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("stop failed");
    let stops = 0;
    const service = new SupervisedHostedService(() => ({ start() {}, async stop() {
      stops++; entered.resolve(); await gate.promise;
      if (outcome === "failure") throw failure;
    } }));
    await service.start();
    const first = service.stop();
    const second = service.stop();
    expect(first).toBe(second);
    await entered.promise;
    expect(stops).toBe(1);
    gate.resolve();
    if (outcome === "success") {
      await Promise.all([first, second]);
      await service.start();
      await service.stop();
      expect(stops).toBe(2);
    } else {
      const results = await Promise.allSettled([first, second]);
      expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
      await expect(service.start()).rejects.toBe(failure);
      expect(stops).toBe(1);
    }
  });

  test("factory failure aborts preflight before earlier services start", async () => {
    const events: string[] = [];
    let factories = 0;
    const wrapped = new SupervisedHostedService(() => { factories++; throw new Error("construction failed"); });
    await expect(new LifecycleCoordinator(resolver([
      { phase: -10, start() { events.push("earlier start"); }, stop() {} }, wrapped,
    ], events)).start()).rejects.toThrow("construction failed");
    expect(factories).toBe(1);
    expect(events).toEqual([]);
  });
});
