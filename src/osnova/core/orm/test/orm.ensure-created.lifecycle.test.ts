import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, type DatabaseProvider } from "@/library/orm";
import { ormModule } from "../ormModule";
import { OrmLifecycle, OrmProviderReadyLifecycle } from "../OrmLifecycle";
import { HOSTED_SERVICE, type HostedService } from "../../di";
import { LifecycleCoordinator } from "../../kernel";

@Entity({ table: "lifecycle_admission" }) class LifecycleEntity { @Key() @Column({ type: "integer" }) id = 0; }
class LifecycleContext extends DbContext {}
const postgresWithoutAdmission = { name: "postgres", dialect: { name: "postgres" }, query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), transaction: async <T>(work: never) => work as T, ping: async () => true, close: async () => undefined, introspect: async () => ({ tables: new Map() }) } as unknown as DatabaseProvider;

describe("ensure-created lifecycle", () => {
  test("rejects mutually exclusive migration startup and feature-local PostgreSQL", () => {
    expect(() => ormModule({ context: LifecycleContext, entities: [LifecycleEntity], ensureCreated: true, migrateOnStart: true })).toThrow();
    expect(() => ormModule({ context: LifecycleContext, entities: [LifecycleEntity], ensureCreated: true, provider: postgresWithoutAdmission })).toThrow();
  });
  test("shared named PostgreSQL without admission capability fails before any application start", async () => {
    const lifecycle = new OrmLifecycle(new DbContextOptions({ provider: postgresWithoutAdmission, entities: [LifecycleEntity] }), true, false, [], false, false);
    let starts = 0;
    const provider = { phase: -110, __osnovaOrmProviderReady: true, start() {}, stop() {} } as HostedService;
    const application = { phase: 0, start() { starts++; }, stop() {} } as HostedService;
    const resolver = { resolveAll: <T>(token: unknown): readonly T[] => token === HOSTED_SERVICE ? [provider, lifecycle, application] as unknown as readonly T[] : [] };
    await expect(new LifecycleCoordinator(resolver).start()).rejects.toMatchObject({ code: "ORM_SCHEMA_PROVIDER_UNSUPPORTED" });
    expect(starts).toBe(0);
  });
  test("kernel starts provider then exact PostgreSQL admission in numeric order", async () => {
    const order: number[] = [];
    const services = [-110, -105].map((phase) => ({ phase, start() { order.push(phase); }, stop() {} })) as HostedService[];
    const resolver = { resolveAll: <T>(token: unknown): readonly T[] => token === HOSTED_SERVICE ? services as unknown as readonly T[] : [] };
    await new LifecycleCoordinator(resolver).start();
    expect(order).toEqual([-110, -105]);
  });
  test("actual ORM lifecycle phases are provider -110 and PostgreSQL exact -105", () => {
    expect(new OrmProviderReadyLifecycle().phase).toBe(-110);
    expect(new OrmLifecycle(new DbContextOptions({ provider: postgresWithoutAdmission, entities: [LifecycleEntity] }), true, false).phase).toBe(-105);
  });
});
