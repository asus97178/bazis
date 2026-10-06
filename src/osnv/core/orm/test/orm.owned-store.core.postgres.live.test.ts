import { expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { createContainer, Global, HOSTED_SERVICE, Module, singletonValue } from "@/core/di";
import { HEALTH_CHECK, LifecycleCoordinator } from "@/core/kernel";
import { Infra } from "@/core/infra";
import { Column, DATABASE_PROVIDER, DbContext, Entity, Index, Key, ormOsnvConnect } from "@/core/orm";
import { Configuration, defineConfig, secret } from "@/core/kernel";
import { OrmModel, postgres, type DatabaseProvider } from "@/library/orm";
import { compileExpectedSchema } from "../../../library/orm/Schema/ExpectedSchema";
import { defineOrmOwnedStoreV1 } from "../../../library/orm/Schema/OrmOwnedStore";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreScopeHashV1 } from "../../../library/orm/Schema/OwnedStoreCanonical";

const registry = "__osnv_orm_owned_stores_v1";
const run = process.env.OSNV_OWNED_STORE_E_RUN;
const enabled = exactGate(process.env);
const compact = typeof run === "string" ? run.replaceAll("-", "") : "";
const short = compact.slice(0, 12);
const prefixA = `oe327_${short}_a_`, prefixB = `oe327_${short}_b_`;
const names = Object.freeze({ a: `${prefixA}item`, aPk: `${prefixA}item_pkey`, b: `${prefixB}item`, bPk: `${prefixB}item_pkey`, support: `oe327_${short}_support`, collision: `oe327_${short}_collision_ix` });
const safe = /^oe327_[a-f0-9]{12}_(?:a_|b_)?[a-z0-9_]+$/u;
let infraDefinitions = 0, observers = 0, containers = 0;
let cachedRoot: { readonly url: string; readonly Root: new () => object } | undefined;
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

@Entity({ table: names.a }) class StoreAItem { @Key({ generated: false, name: names.aPk }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) value = ""; }
@Entity({ table: names.b }) class StoreBItem { @Key({ generated: false, name: names.bPk }) @Column({ type: "integer" }) id = 0; @Index({ name: names.collision }) @Column({ type: "text" }) value = ""; }
class StoreAContext extends DbContext { readonly items = this.set(StoreAItem); }
class StoreBContext extends DbContext { readonly items = this.set(StoreBItem); }

function exactGate(env: NodeJS.ProcessEnv): boolean {
  const url = env.OSNV_PG_URL, database = env.OSNV_OWNED_STORE_E_DATABASE;
  const runId = env.OSNV_OWNED_STORE_E_RUN;
  let dsnDatabase: string | undefined, protocol: string | undefined;
  try { const parsed = new URL(url ?? ""); dsnDatabase = parsed.pathname.slice(1); protocol = parsed.protocol; } catch { dsnDatabase = undefined; }
  const override = Object.keys(env).some((key) => key.startsWith("OSNV_") && key.slice("OSNV_".length).toLowerCase().replaceAll("__", ".").startsWith("e327db."));
  return !override && (protocol === "postgres:" || protocol === "postgresql:") && typeof url === "string" && url.length > 0
    && env.OSNV_OWNED_STORE_E_LIVE === "wp-orm-3-e327-integrated-v1"
    && env.OSNV_OWNED_STORE_E_ROLE === "owned-store-e-child-v1"
    && typeof runId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(runId)
    && typeof database === "string" && database === `oe327_${runId.replaceAll("-", "")}` && dsnDatabase === database
    && env.OSNV_OWNED_STORE_C3_LIVE === undefined && env.OSNV_OWNED_STORE_C3_DATABASE === undefined && env.OSNV_OWNED_STORE_C3_ROLE === undefined && env.OSNV_OWNED_STORE_C3_RUN === undefined;
}
function q(name: string): string {
  if (!safe.test(name) || !Object.values(names).some(owned => owned === name)) throw new Error("E327 foreign identifier");
  return `\"${name}\"`;
}
function noE327Overrides(): void {
  for (const key of Object.keys(process.env)) {
    const normalized = key.startsWith("OSNV_") ? key.slice("OSNV_".length).toLowerCase().replaceAll("__", ".") : "";
    if (normalized.startsWith("e327db.")) throw new Error("E327 config override rejected");
  }
}
function definition(storeKey: string, prefix: string) { return defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: prefix } }); }
const definitionA = definition("e327.store.a", prefixA), definitionB = definition("e327.store.b", prefixB);
const identityA = Object.freeze({ store_key: definitionA.storeKey, contract: definitionA.contract, format_version: "1", owned_schema: "public", table_prefix: prefixA, owned_scope_hash: canonicalOwnedStoreScopeHashV1(definitionA), model_hash: canonicalOwnedStoreModelHashV1(definitionA, compileExpectedSchema(new OrmModel([StoreAItem])) ) });
const identityB = Object.freeze({ store_key: definitionB.storeKey, contract: definitionB.contract, format_version: "1", owned_schema: "public", table_prefix: prefixB, owned_scope_hash: canonicalOwnedStoreScopeHashV1(definitionB), model_hash: canonicalOwnedStoreModelHashV1(definitionB, compileExpectedSchema(new OrmModel([StoreBItem])) ) });
function root(url: string) {
  check(exactGate(process.env), "E327_GATE_REJECTED");
  if (cachedRoot?.url === url) { containers++; return createContainer(cachedRoot.Root); }
  noE327Overrides();
  const parsed = new URL(url);
  infraDefinitions++;
  const dbConfig = defineConfig("e327db", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Global() @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] }) class ConfigModule {}
  @Infra({ db: ormOsnvConnect(dbConfig) }) class TestInfra {}
  @Module({ ormOsnv: [
    { context: StoreAContext, entities: [StoreAItem], ownedStore: definitionA, registerRepositories: false },
    { context: StoreBContext, entities: [StoreBItem], ownedStore: definitionB, registerRepositories: false },
  ] }) class StoresModule {}
  @Module({ imports: [ConfigModule, TestInfra, StoresModule] }) class Root {}
  cachedRoot = { url, Root }; containers++; return createContainer(Root);
}
function observer(url: string): DatabaseProvider { observers++; return postgres({ url }); }
type Rows = readonly Readonly<Record<string, unknown>>[];
const immutableRows = (rows: readonly Record<string, unknown>[]): Rows => Object.freeze(rows.map(row => Object.freeze({ ...row })));
async function relationState(p: DatabaseProvider) {
  const relations = await p.query("SELECT c.relname AS name,c.oid::pg_catalog.text AS oid,c.relkind::pg_catalog.text AS kind,pg_catalog.pg_get_userbyid(c.relowner)::pg_catalog.text AS owner,c.relpersistence::pg_catalog.text AS persistence,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,c.reloptions::pg_catalog.text AS options FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname", []);
  const columns = await p.query("SELECT c.relname AS relation,a.attname AS name,a.attnum::pg_catalog.text AS position,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity::pg_catalog.text AS identity,a.attgenerated::pg_catalog.text AS generated,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum", []);
  const constraints = await p.query("SELECT c.relname AS relation,x.oid::pg_catalog.text AS oid,x.conname AS name,x.contype::pg_catalog.text AS kind,x.conrelid::pg_catalog.text AS table_oid,x.conindid::pg_catalog.text AS index_oid,x.condeferrable AS deferrable,x.condeferred AS deferred,x.convalidated AS validated,pg_catalog.pg_get_constraintdef(x.oid,true) AS definition FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_constraint x ON x.conrelid=c.oid WHERE n.nspname='public' ORDER BY c.relname,x.conname", []);
  const indexes = await p.query("SELECT t.relname AS relation,i.relname AS name,i.oid::pg_catalog.text AS oid,t.oid::pg_catalog.text AS table_oid,x.indisunique AS is_unique,x.indisprimary AS is_primary,x.indisvalid AS is_valid,x.indisready AS is_ready,x.indislive AS is_live,pg_catalog.pg_get_indexdef(i.oid) AS definition FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_index x ON x.indrelid=t.oid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE n.nspname='public' ORDER BY t.relname,i.relname", []);
  return Object.freeze({ relations: immutableRows(relations), columns: immutableRows(columns), constraints: immutableRows(constraints), indexes: immutableRows(indexes) });
}
type Catalog = Awaited<ReturnType<typeof relationState>>;
async function registrySnapshot(p: DatabaseProvider): Promise<Rows> {
  const state = await p.query("SELECT to_regclass('public.__osnv_orm_owned_stores_v1')::pg_catalog.text AS registry", []);
  check(state.length === 1, "E327_REGISTRY_OBSERVATION_INVALID");
  if (state[0]?.registry === null) return Object.freeze([]);
  check(state[0]?.registry === registry || state[0]?.registry === `public.${registry}`, "E327_REGISTRY_OBSERVATION_INVALID");
  return immutableRows(await p.query(`SELECT store_key,contract,format_version::pg_catalog.text AS format_version,owned_schema,table_prefix,owned_scope_hash,model_hash,created_at::pg_catalog.text AS created_at FROM "public"."${registry}" ORDER BY store_key`, []));
}
function same(actual: unknown, expected: unknown, code: string): void { check(isDeepStrictEqual(actual, expected), code); }
function relationNames(catalog: Catalog, expected: readonly (readonly [string, string])[]): void {
  same(catalog.relations.map(row => [row.name, row.kind]), [...expected].sort((a, b) => a[0].localeCompare(b[0])), "E327_RELATION_CLOSURE");
  check(catalog.relations.every(row => typeof row.oid === "string" && /^[1-9][0-9]*$/u.test(row.oid) && row.owner === "osnv" && row.persistence === "p" && row.row_security === false && row.force_row_security === false && row.options === null), "E327_RELATION_IDENTITY");
}
function tableColumns(catalog: Catalog, table: string, expected: readonly (readonly [string, string, boolean])[]): void {
  same(catalog.columns.filter(row => row.relation === table), expected.map(([name, type, notNull], index) => ({ relation: table, name, position: String(index + 1), type, not_null: notNull, identity: "", generated: "", default_value: null })), "E327_COLUMN_SHAPE");
}
function indexShape(catalog: Catalog, table: string, index: string, column: string, primary: boolean): void {
  const found = catalog.indexes.filter(row => row.name === index), tableRow = catalog.relations.find(row => row.name === table), indexRow = catalog.relations.find(row => row.name === index);
  same(found, [{ relation: table, name: index, oid: indexRow?.oid, table_oid: tableRow?.oid, is_unique: primary, is_primary: primary, is_valid: true, is_ready: true, is_live: true, definition: `CREATE ${primary ? "UNIQUE " : ""}INDEX ${index} ON public.${table} USING btree (${column})` }], "E327_INDEX_SHAPE");
  if (primary) {
    const constraint = catalog.constraints.filter(row => row.name === index);
    check(constraint.length === 1 && typeof constraint[0]?.oid === "string", "E327_PK_IDENTITY");
    same(constraint, [{ relation: table, oid: constraint[0]!.oid, name: index, kind: "p", table_oid: tableRow?.oid, index_oid: indexRow?.oid, deferrable: false, deferred: false, validated: true, definition: `PRIMARY KEY (${column})` }], "E327_PK_SHAPE");
  }
}
function validateOwned(catalog: Catalog, tuples: Rows): void {
  relationNames(catalog, [[registry, "r"], [`${registry}_pkey`, "i"], [names.a, "r"], [names.aPk, "i"], [names.b, "r"], [names.bPk, "i"], [names.collision, "i"]]);
  for (const model of [new OrmModel([StoreAItem]), new OrmModel([StoreBItem])]) {
    const table = compileExpectedSchema(model).tables[0]!;
    tableColumns(catalog, table.table, table.columns.map(column => [column.column, column.physicalType === "integer" ? "bigint" : column.physicalType, !column.nullable] as const));
  }
  tableColumns(catalog, registry, [["store_key", "text", true], ["contract", "text", true], ["format_version", "bigint", true], ["owned_schema", "text", true], ["table_prefix", "text", true], ["owned_scope_hash", "text", true], ["model_hash", "text", true], ["created_at", "timestamp with time zone", true]]);
  indexShape(catalog, names.a, names.aPk, "id", true); indexShape(catalog, names.b, names.bPk, "id", true);
  indexShape(catalog, registry, `${registry}_pkey`, "store_key", true); indexShape(catalog, names.b, names.collision, "value", false);
  check(catalog.constraints.length === 3 && catalog.indexes.length === 4, "E327_OWNED_CLOSURE");
  same(tuples.map(({ created_at, ...identity }) => identity), [identityA, identityB], "E327_EXACT_IDENTITIES");
  check(tuples.every(row => typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at))), "E327_CREATED_AT_INVALID");
}
async function health(container: ReturnType<typeof createContainer>) { return container.resolveAll(HEALTH_CHECK).filter(check => check.name.startsWith("orm-owned-store:")).sort((a, b) => a.name.localeCompare(b.name)); }

test.skipIf(enabled)("without the exact opt-in env, rejects incomplete or redirected opt-in before observer, Infra, or container effects", () => {
  expect(enabled).toBe(false);
  const valid: NodeJS.ProcessEnv = { OSNV_PG_URL: "postgres://unused/oe327_00000000000000000000000000000000", OSNV_OWNED_STORE_E_LIVE: "wp-orm-3-e327-integrated-v1", OSNV_OWNED_STORE_E_DATABASE: "oe327_00000000000000000000000000000000", OSNV_OWNED_STORE_E_ROLE: "owned-store-e-child-v1", OSNV_OWNED_STORE_E_RUN: "00000000-0000-0000-0000-000000000000" };
  expect(exactGate(valid)).toBe(true);
  for (const key of Object.keys(valid)) { const missing = { ...valid }; delete missing[key]; expect(exactGate(missing)).toBe(false); }
  for (const candidate of [{}, { ...valid, OSNV_OWNED_STORE_E_LIVE: "wrong" }, { ...valid, OSNV_OWNED_STORE_E_ROLE: "wrong" }, { ...valid, OSNV_OWNED_STORE_E_RUN: "unsafe" }, { ...valid, OSNV_OWNED_STORE_E_DATABASE: "unsafe" }, { ...valid, OSNV_PG_URL: "postgres://unused/other" }, { ...valid, OSNV_PG_URL: "https://unused/oe327_00000000000000000000000000000000" }, { ...valid, OSNV_E327DB__HOST: "redirected" }, { ...valid, "OSNV_e327db.host": "redirected" }]) expect(exactGate(candidate)).toBe(false);
  for (const suffix of ["LIVE", "DATABASE", "ROLE", "RUN"]) expect(exactGate({ ...valid, [`OSNV_OWNED_STORE_C3_${suffix}`]: "wrong" })).toBe(false);
  expect(() => q("other")).toThrow("E327 foreign identifier");
  expect({ infraDefinitions, observers, containers }).toEqual({ infraDefinitions: 0, observers: 0, containers: 0 });
});

test.skipIf(!enabled)("sequential two-store PostgreSQL core lifecycle", async () => {
  const url = process.env.OSNV_PG_URL!;
  type Container = ReturnType<typeof createContainer>;
  type Entry = { container: Container; coordinator: LifecycleCoordinator; stopped: boolean; disposed: boolean };
  type Proof = Readonly<{ kind: "old" | "support" | "owned"; catalog: Catalog; tuples: Rows }>;
  const entries: Entry[] = [], openObservers = new Set<DatabaseProvider>();
  let proof: Proof | undefined, cleanupFailed = false, finalEmpty = false;
  let phase = "PREFLIGHT", failure: string | undefined;
  const fresh = async <T>(work: (p: DatabaseProvider) => Promise<T>): Promise<T> => {
    const p = observer(url); openObservers.add(p);
    try { return await work(p); }
    finally { try { await p.close(); } catch { cleanupFailed = true; } finally { openObservers.delete(p); } }
  };
  const createEntry = (): Entry => {
    const container = root(url), entry = { container, coordinator: new LifecycleCoordinator(container), stopped: false, disposed: false };
    entries.push(entry); return entry;
  };
  const stop = async (entry: Entry) => { await entry.coordinator.stopServices(); entry.stopped = true; };
  const dispose = async (entry: Entry) => { await entry.container.dispose(); entry.disposed = true; };
  const checkHealth = async (entry: Entry, healthy: boolean) => {
    const checks = await health(entry.container);
    same(checks.map(check => check.name), ["orm-owned-store:e327.store.a", "orm-owned-store:e327.store.b"], "E327_HEALTH_IDENTITY");
    for (const item of checks) same(await item.check(), healthy ? { healthy: true } : { healthy: false, details: "ORM_OWNED_STORE_NOT_READY" }, "E327_HEALTH_STATE");
  };
  const rejectStart = async (entry: Entry, code: string) => {
    let actual: unknown;
    try { await entry.coordinator.start(undefined, 10_000); } catch (error) { actual = error; }
    check(typeof actual === "object" && actual !== null && "code" in actual && actual.code === code, "E327_START_REJECTION");
    check(entry.coordinator.startedHostedCount === 0, "E327_PARTIAL_START");
    await checkHealth(entry, false);
  };
  const checkProof = async (p: DatabaseProvider, expected: Proof) => {
    same(await relationState(p), expected.catalog, "E327_CATALOG_CHANGED");
    same(await registrySnapshot(p), expected.tuples, "E327_IDENTITY_CHANGED");
  };
  const cleanupProof = async (expected: Proof) => fresh(async p => {
    // A full, fresh, exact ownership proof precedes every group of exact drops.
    await checkProof(p, expected);
    if (expected.kind === "owned") {
      validateOwned(expected.catalog, expected.tuples);
      await p.execute(`DROP TABLE "public".${q(names.b)}`, []);
      await p.execute(`DROP TABLE "public".${q(names.a)}`, []);
      await p.execute(`DROP TABLE "public"."${registry}"`, []);
    } else {
      await p.execute(`DROP TABLE "public".${q(expected.kind === "old" ? names.a : names.support)}`, []);
    }
    same((await relationState(p)).relations, [], "E327_CLEANUP_NOT_EMPTY");
  });
  const readRows = async (entry: Entry) => {
    const scope = entry.container.createScope();
    try {
      check((await scope.resolve(StoreAContext).items.find(11))?.value === "a", "E327_STORE_A_READ");
      check((await scope.resolve(StoreBContext).items.find(22))?.value === "b", "E327_STORE_B_READ");
    } finally { try { await scope.dispose(); } catch { cleanupFailed = true; } }
  };
  try {
    await fresh(async p => {
      check((await p.query("SELECT current_database() AS database", []))[0]?.database === process.env.OSNV_OWNED_STORE_E_DATABASE, "E327_DATABASE_IDENTITY");
      same((await relationState(p)).relations, [], "E327_DATABASE_NOT_EMPTY");
      same(await registrySnapshot(p), [], "E327_REGISTRY_NOT_ABSENT");
    });
    phase = "MISSING_IDENTITY";
    proof = await fresh(async p => {
      await p.execute(`CREATE TABLE "public".${q(names.a)} (id integer NOT NULL)`, []);
      const catalog = await relationState(p);
      relationNames(catalog, [[names.a, "r"]]); tableColumns(catalog, names.a, [["id", "integer", true]]);
      same(catalog.constraints, [], "E327_OLD_CONSTRAINTS"); same(catalog.indexes, [], "E327_OLD_INDEXES");
      const tuples = await registrySnapshot(p); same(tuples, [], "E327_OLD_REGISTRY");
      return Object.freeze({ kind: "old" as const, catalog, tuples });
    });
    const missing = createEntry(); await rejectStart(missing, "ORM_OWNED_STORE_IDENTITY_MISSING");
    await fresh(p => checkProof(p, proof!));
    await stop(missing); await dispose(missing);
    await cleanupProof(proof); proof = undefined;

    phase = "MULTI_STORE_ROLLBACK";
    proof = await fresh(async p => {
      await p.execute(`CREATE TABLE "public".${q(names.support)} (id integer NOT NULL)`, []);
      await p.execute(`CREATE INDEX ${q(names.collision)} ON "public".${q(names.support)} (id)`, []);
      const catalog = await relationState(p);
      relationNames(catalog, [[names.support, "r"], [names.collision, "i"]]);
      tableColumns(catalog, names.support, [["id", "integer", true]]);
      indexShape(catalog, names.support, names.collision, "id", false);
      check(catalog.constraints.length === 0 && catalog.indexes.length === 1, "E327_SUPPORT_CLOSURE");
      const tuples = await registrySnapshot(p); same(tuples, [], "E327_SUPPORT_REGISTRY");
      return Object.freeze({ kind: "support" as const, catalog, tuples });
    });
    const collision = createEntry(); await rejectStart(collision, "ORM_OWNED_STORE_CREATE_FAILED");
    await fresh(p => checkProof(p, proof!));
    await stop(collision); await dispose(collision);
    await cleanupProof(proof); proof = undefined;

    phase = "CREATE_C1";
    const c1 = createEntry();
    const hosted = c1.container.resolveAll(HOSTED_SERVICE), plan = hosted.filter(service => service.phase === -105);
    check(plan.length === 2 && plan[0] === plan[1], "E327_SINGLE_PLAN");
    check(hosted.filter(service => service.phase === -110).length === 1, "E327_PROVIDER_PHASE");
    const provider1 = c1.container.resolve(DATABASE_PROVIDER);
    check(provider1.name === "postgres", "E327_ACTUAL_PROVIDER");
    await c1.coordinator.start(undefined, 10_000); await checkHealth(c1, true);
    check(await provider1.ping(), "E327_PROVIDER_READY");
    proof = await fresh(async p => {
      const catalog = await relationState(p), tuples = await registrySnapshot(p);
      validateOwned(catalog, tuples);
      return Object.freeze({ kind: "owned" as const, catalog, tuples });
    });
    const scope = c1.container.createScope();
    try {
      const a = scope.resolve(StoreAContext), b = scope.resolve(StoreBContext);
      a.items.add(Object.assign(new StoreAItem(), { id: 11, value: "a" }));
      b.items.add(Object.assign(new StoreBItem(), { id: 22, value: "b" }));
      check(await a.saveChanges() === 1 && await b.saveChanges() === 1, "E327_WRITES");
    } finally { try { await scope.dispose(); } catch { cleanupFailed = true; } }
    await readRows(c1);

    phase = "REOPEN_C2";
    const c2 = createEntry();
    const provider2 = c2.container.resolve(DATABASE_PROVIDER);
    check(provider2 !== provider1 && provider2.name === "postgres", "E327_DISTINCT_PROVIDER");
    await c2.coordinator.start(undefined, 10_000); await checkHealth(c2, true); await readRows(c2);
    await fresh(p => checkProof(p, proof!));
    phase = "INDEPENDENT_STOP";
    await stop(c1); await checkHealth(c1, false); await checkHealth(c2, true); await readRows(c2);
    await stop(c2); await checkHealth(c2, false);
    await fresh(p => checkProof(p, proof!));
  } catch { failure = phase; }
  finally {
    // Every retained real coordinator/container gets an independent cleanup attempt.
    for (const entry of [...entries].reverse()) {
      if (!entry.stopped) { try { await stop(entry); } catch { cleanupFailed = true; } }
      if (!entry.disposed) { try { await dispose(entry); } catch { cleanupFailed = true; } }
    }
    // Unknown/partial catalog ownership forbids SQL drops. Outer fixture remains owner.
    if (proof !== undefined) { try { await cleanupProof(proof); proof = undefined; } catch { cleanupFailed = true; } }
    try { await fresh(async p => { finalEmpty = (await relationState(p)).relations.length === 0; }); } catch { cleanupFailed = true; }
    for (const p of openObservers) { try { await p.close(); } catch { cleanupFailed = true; } }
    openObservers.clear();
  }
  // Fixed phase codes preserve the initial failure; cleanup never masks it.
  check(failure === undefined, `E327_${failure ?? "UNKNOWN"}_FAILED`);
  check(!cleanupFailed && finalEmpty, "E327_CLEANUP_UNCONFIRMED");
  expect(true).toBe(true);
}, 60_000);
