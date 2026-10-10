import { expect, test } from "bun:test";
import { PostgresDialect } from "../Providers/PostgresDialect";
import { SqlTranslator } from "../Query/SqlTranslator";
import { EntityQuery } from "../Query/EntityQuery";
import type { EntityModel } from "../Metadata/types";
import type { QueryPlan } from "../Query/QueryPlan";
import type { DbContextRuntime } from "../runtime";
import type { PredicateFn } from "../Query/conditions";

interface Claim { readonly id: number; readonly tenant: number; readonly children: readonly Claim[]; }

const id = { propertyName: "id", columnName: "id", type: "integer", isKey: true };
const model = { name: "Claim", tableName: "claims", properties: [id], key: [id], propertyByName: (name: string) => name === "id" ? id : undefined, queryFilters: [], indexes: [], foreignKeys: [], checks: [] } as unknown as EntityModel;

test("PostgreSQL renders skip locked only as its private terminal lock suffix", () => {
  const plan: QueryPlan = { conditions: [{ kind: "null", property: "id", negated: false }], orders: [{ property: "id", descending: false }], limit: 1, noTracking: false, includes: [], ignoreQueryFilters: false, projections: [], rowLock: "update", skipLocked: true };
  expect(new SqlTranslator(model, new PostgresDialect()).selectAll(plan).sql).toEndWith("FOR UPDATE SKIP LOCKED");
});

test("skipLocked admission rejects projected terminal before dispatch and admits the complete composite-key case", async () => {
  const tenant = { propertyName: "tenant", columnName: "tenant", type: "integer", isKey: true };
  const composite = { ...model, properties: [tenant, id], key: [tenant, id], propertyByName: (name: string) => name === "tenant" ? tenant : name === "id" ? id : undefined } as unknown as EntityModel;
  let dispatches = 0; let active = true;
  const runtime = { provider: { dialect: new PostgresDialect(), isTransactionActive: () => active, query: async () => { dispatches += 1; return []; } }, tracker: {} } as unknown as DbContextRuntime;
  const base = new EntityQuery<Claim>(composite, runtime);
  await expect(base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1).select(x => ({ id: x.id })).forUpdate({ skipLocked: true }).toList()).rejects.toThrow("terminal materialization");
  expect(dispatches).toBe(0);
  await base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1).asNoTracking().ignoreQueryFilters().forUpdate({ skipLocked: true }).toList();
  expect(dispatches).toBe(1);
  for (const invalid of [base.orderBy(x => x.tenant).orderBy(x => x.id).take(1), base.where(x => x.id.eq(1)).orderBy(x => x.tenant).take(1), base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(0), base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1).skip(1)] as const) {
    await expect(invalid.forUpdate({ skipLocked: true }).toList()).rejects.toThrow();
  }
  active = false;
  await expect(base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1).forUpdate({ skipLocked: true }).firstOrDefault()).rejects.toThrow();
  expect(dispatches).toBe(1);
  active = true;
  const valid = base.where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1);
  for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) await expect(valid.take(count).forUpdate({ skipLocked: true }).toList()).rejects.toThrow();
  await expect(valid.forUpdate({ skipLocked: true }).count()).rejects.toThrow();
  await expect(valid.forUpdate({ skipLocked: true }).any()).rejects.toThrow();
  await expect(valid.include(x => x.children).forUpdate({ skipLocked: true }).toList()).rejects.toThrow();
  await expect(valid.forUpdate({ skipLocked: false }).count()).resolves.toBe(0);
  expect(dispatches).toBe(2);
  await valid.forUpdate({ skipLocked: true }).firstOrDefault();
  expect(dispatches).toBe(3);
  const idEqualsOne: PredicateFn<Claim> = (x) => x.id.eq(1);
  for (const count of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) for (const predicate of [undefined, idEqualsOne] as const) {
    const invalid = valid.take(count).forUpdate({ skipLocked: true });
    await expect(invalid.firstOrDefault(predicate)).rejects.toThrow();
    await expect(invalid.first(predicate)).rejects.toThrow();
  }
  expect(dispatches).toBe(3);
  const postgres = runtime.provider.dialect; const unsupportedDialect = { name: "other", quoteId: postgres.quoteId.bind(postgres), qualifyTable: postgres.qualifyTable.bind(postgres), parameter: postgres.parameter.bind(postgres), encode: postgres.encode.bind(postgres), decode: postgres.decode.bind(postgres), rowLockClause: postgres.rowLockClause.bind(postgres) };
  const unsupportedRuntime = { ...runtime, provider: { ...runtime.provider, dialect: unsupportedDialect } };
  await expect(new EntityQuery<Claim>(composite, unsupportedRuntime as unknown as DbContextRuntime).where(x => x.id.eq(1)).orderBy(x => x.tenant).orderBy(x => x.id).take(1).forUpdate({ skipLocked: true }).toList()).rejects.toThrow("PostgreSQL");
  expect(dispatches).toBe(3);
});

test("forUpdate outside a transaction fails before dispatch with a transactionScope hint", async () => {
  let dispatches = 0; let active = false;
  const runtime = { provider: { dialect: new PostgresDialect(), isTransactionActive: () => active, query: async () => { dispatches += 1; return []; } }, tracker: { trackReloaded: (entity: unknown) => entity } } as unknown as DbContextRuntime;
  const query = new EntityQuery<Claim>(model, runtime).where(x => x.id.eq(1));
  await expect(query.forUpdate().toList()).rejects.toThrow("forUpdate() locks rows only until the surrounding transaction ends");
  await expect(query.forUpdate().firstOrDefault()).rejects.toThrow("db.transactionScope(");
  await expect(query.forUpdate().count()).rejects.toThrow("forUpdate()");
  expect(dispatches).toBe(0);
  active = true;
  await query.forUpdate().toList();
  expect(dispatches).toBe(1);
});
