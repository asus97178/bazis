import { expect, test } from "bun:test";
import { Column, DbContextOptions, Entity, Key, type DatabaseProvider } from "@/library/orm";
import { OrmLifecycle, OrmProviderReadyLifecycle } from "../OrmLifecycle";
import { ormHostedPlanValidator } from "../OrmHostedPlan.validator";

@Entity({ table: "plan_products" }) class PlanProduct { @Key() @Column({ type: "integer" }) id = 0; }
@Entity({ table: "plan_orders" }) class PlanOrder { @Key() @Column({ type: "integer" }) id = 0; }
const postgres = { name: "postgres", dialect: { name: "postgres" } } as unknown as DatabaseProvider;
const lifecycle = (entity: new () => object, context: string, mode: { ensureCreated?: boolean; migrateOnStart?: boolean }) =>
  new OrmLifecycle(new DbContextOptions({ provider: postgres, entities: [entity] }), mode.ensureCreated === true, mode.migrateOnStart === true, [], false, false, context);

test("mixed schema modes name each context and its mode", () => {
  const services = [new OrmProviderReadyLifecycle(), lifecycle(PlanProduct, "CatalogDbContext", { ensureCreated: true }), lifecycle(PlanOrder, "OrdersDbContext", { migrateOnStart: true })];
  expect(() => ormHostedPlanValidator.validate(services)).toThrow("Schema admission and legacy ORM schema authority cannot be composed together: CatalogDbContext uses ensureCreated, OrdersDbContext uses migrateOnStart. Use one schema mode in the application: ensureCreated (with or without migrations) in every module, or migrateOnStart/migrations without ensureCreated in every module.");
});

test("a table created by two contexts names the table and both contexts", () => {
  const services = [new OrmProviderReadyLifecycle(), lifecycle(PlanProduct, "CatalogDbContext", { ensureCreated: true }), lifecycle(PlanProduct, "OrdersDbContext", { ensureCreated: true })];
  expect(() => ormHostedPlanValidator.validate(services)).toThrow("Schema admission table ownership conflicts: table public.plan_products is created by both CatalogDbContext and OrdersDbContext with ensureCreated. One context must own the table: remove the entity from the other context and refer to it by a plain id column.");
});

test("ensureCreated accepts versioned migrations but not migrateOnStart", async () => {
  const { ormModule } = await import("../ormModule");
  class PlanContext extends (await import("@/library/orm")).DbContext {}
  const migrations = [{ id: "01_price_real", up: async () => {} }];
  expect(() => ormModule({ context: PlanContext, entities: [PlanProduct], ensureCreated: true, migrations, runMigrationsOnStart: true })).not.toThrow();
  expect(() => ormModule({ context: PlanContext, entities: [PlanProduct], ensureCreated: true, migrateOnStart: true })).toThrow("ensureCreated and migrateOnStart are mutually exclusive: ensureCreated already adds the safe changes. Put other changes into migrations with runMigrationsOnStart: true.");
  const strict = new OrmLifecycle(new DbContextOptions({ provider: postgres, entities: [PlanProduct] }), true, false, migrations, true, false, "CatalogDbContext");
  expect(strict.phase).toBe(-105);
  expect(strict.__bazisLegacySchemaAuthority).toBe(false);
  expect(strict.__bazisSchemaOwner).toEqual({ context: "CatalogDbContext", mode: "ensureCreated + migrations" });
  expect(() => ormHostedPlanValidator.validate([new OrmProviderReadyLifecycle(), strict, lifecycle(PlanOrder, "OrdersDbContext", { ensureCreated: true })])).not.toThrow();
});
