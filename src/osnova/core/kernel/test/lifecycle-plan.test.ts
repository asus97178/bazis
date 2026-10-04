import { expect, test } from "bun:test";
import { HOSTED_SERVICE, startHostedServices, type HostedService, type HostedServicePlanValidator } from "../../di";
import { LifecycleCoordinator } from "../LifecycleCoordinator";
import { LIFECYCLE_HOOK } from "../lifecycleHooks";

test("capability validates the whole immutable plan once before hooks and starts", async () => {
  const events: string[] = [];
  const validator: HostedServicePlanValidator = { async validate(plan) {
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan).toHaveLength(2);
    events.push("validate");
  } };
  const services: HostedService[] = [1, 0].map(phase => ({ phase, planValidator: validator, start() { events.push(`start:${phase}`); }, stop() {} }));
  const resolver = { resolveAll<T>(token: unknown): readonly T[] {
    return (token === HOSTED_SERVICE ? services : token === LIFECYCLE_HOOK ? [{ onInit() { events.push("init"); } }] : []) as unknown as readonly T[];
  } };
  await new LifecycleCoordinator(resolver).start();
  expect(events).toEqual(["validate", "init", "start:0", "start:1"]);
});

test("invalid capability plan fails before lifecycle side effects", async () => {
  let starts = 0;
  const service: HostedService = { planValidator: { validate() { throw new Error("invalid plan"); } }, start() { starts++; }, stop() { starts++; } };
  const resolver = { resolveAll<T>(token: unknown): readonly T[] { return (token === HOSTED_SERVICE ? [service] : []) as unknown as readonly T[]; } };
  await expect(new LifecycleCoordinator(resolver).start()).rejects.toThrow("invalid plan");
  await expect(startHostedServices(resolver)).rejects.toThrow("invalid plan");
  expect(starts).toBe(0);
});

test("plan validation observes host cancellation before any service starts", async () => {
  const controller = new AbortController();
  let starts = 0;
  const service: HostedService = { planValidator: { validate(_plan, signal) {
    expect(signal).toBe(controller.signal);
    controller.abort(new Error("cancelled plan"));
    return new Promise<void>(() => {});
  } }, start() { starts++; }, stop() {} };
  const resolver = { resolveAll<T>(token: unknown): readonly T[] { return (token === HOSTED_SERVICE ? [service] : []) as unknown as readonly T[]; } };
  await expect(new LifecycleCoordinator(resolver).start(controller.signal)).rejects.toThrow("cancelled plan");
  expect(starts).toBe(0);
});
