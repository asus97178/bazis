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
  expect(() => ormHostedPlanValidator.validate(services)).toThrow("Schema admission and legacy ORM schema authority cannot be composed together: CatalogDbContext uses ensureCreated, OrdersDbContext uses migrateOnStart. Use one schema mode in the application: ensureCreated in every module, or migrateOnStart/migrations in every module.");
});

test("a table created by two contexts names the table and both contexts", () => {
  const services = [new OrmProviderReadyLifecycle(), lifecycle(PlanProduct, "CatalogDbContext", { ensureCreated: true }), lifecycle(PlanProduct, "OrdersDbContext", { ensureCreated: true })];
  expect(() => ormHostedPlanValidator.validate(services)).toThrow("Schema admission table ownership conflicts: table public.plan_products is created by both CatalogDbContext and OrdersDbContext with ensureCreated. One context must own the table: remove the entity from the other context and refer to it by a plain id column.");
});
