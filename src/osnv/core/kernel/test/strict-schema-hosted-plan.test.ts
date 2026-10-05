import { ormHostedPlanValidator } from "../../orm/OrmHostedPlan.validator";
import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, type HostedService } from "../../di";
import { LifecycleCoordinator } from "../index";

const provider = { planValidator: ormHostedPlanValidator, phase: -110, __osnvOrmProviderReady: true, start() {}, stop() {} } as HostedService;
const exact = (tables: readonly string[], foreignKeys: readonly { source: string; target: string }[] = []): HostedService => ({
  planValidator: ormHostedPlanValidator, phase: -105, start() {}, stop() {},
  __osnvSchemaAdmission: Object.freeze({ unit: tables, tables, foreignKeys }),
} as HostedService);

function coordinator(services: readonly HostedService[]): LifecycleCoordinator {
  return new LifecycleCoordinator({ resolveAll: <T>(token: unknown): readonly T[] => token === HOSTED_SERVICE ? services as unknown as readonly T[] : [] });
}

describe("strict schema hosted plan", () => {
  test("accepts the separate owned-store marker at the reserved phase without enabling legacy strict admission", async () => {
    const owned = { phase: -105, __osnvOrmOwnedStoreAdmission: true, planValidator: ormHostedPlanValidator, start() {}, stop() {} } as HostedService;
    await expect(coordinator([provider, owned]).start()).resolves.toBeUndefined();
  });
  test("rejects an owned-store marker without its provider prerequisite before starts", async () => {
    let starts = 0;
    const owned = { phase: -105, __osnvOrmOwnedStoreAdmission: true, planValidator: ormHostedPlanValidator, start() { starts++; }, stop() {} } as HostedService;
    await expect(coordinator([owned]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    expect(starts).toBe(0);
  });
  test("rejects a malformed owned-store phase before any service starts", async () => {
    let starts = 0;
    const malformed = { phase: -104, __osnvOrmOwnedStoreAdmission: true, planValidator: ormHostedPlanValidator, start() { starts++; }, stop() {} } as HostedService;
    await expect(coordinator([provider, malformed]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    expect(starts).toBe(0);
  });
  test("rejects an application negative phase in an owned-only graph", async () => {
    let starts = 0;
    const owned = { phase: -105, __osnvOrmOwnedStoreAdmission: true, planValidator: ormHostedPlanValidator, start() {}, stop() {} } as HostedService;
    const app = { phase: -1, start() { starts++; }, stop() {} } as HostedService;
    await expect(coordinator([provider, owned, app]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    expect(starts).toBe(0);
  });
  test("rejects duplicate ownership before any hosted service starts", async () => {
    const first = exact(["public.items"]);
    const second = exact(["public.items"]);
    await expect(coordinator([provider, first, second]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_OWNERSHIP_CONFLICT" });
  });

  test("rejects cross-unit foreign-key target before startup", async () => {
    const admission = exact(["public.children"], [{ source: "public.children", target: "public.parents" }]);
    await expect(coordinator([provider, admission]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_OWNERSHIP_CONFLICT" });
  });
  test("rejects missing/wrong provider, mixed legacy authority and negative application phases before starts", async () => {
    let starts = 0;
    const app = { phase: -1, start() { starts++; }, stop() {} } as HostedService;
    await expect(coordinator([exact(["public.a"]), app]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    const wrongProvider = { ...provider, phase: -109 } as HostedService;
    await expect(coordinator([wrongProvider, exact(["public.a"])]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    const legacy = { phase: -100, __osnvLegacySchemaAuthority: true, start() { starts++; }, stop() {} } as HostedService;
    await expect(coordinator([provider, exact(["public.a"]), legacy]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    expect(starts).toBe(0);
  });
  test("rejects an exact descriptor at a phase other than -105 before start", async () => {
    let starts = 0;
    const malformed = { ...exact(["public.bad"]), phase: -104, start() { starts++; } } as HostedService;
    await expect(coordinator([provider, malformed]).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
    expect(starts).toBe(0);
  });

});
