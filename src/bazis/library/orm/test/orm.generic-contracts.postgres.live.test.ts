import { afterAll, describe, expect, test } from "bun:test";
import {
  DbContext,
  DbContextOptions,
  DatabaseFacade,
  Column,
  Entity,
  EntityNotFoundError,
  PostCommitError,
  Repository,
  buildDynamicModel,
  isCommittedOutcome,
  Key,
  OrmModel,
  postgres,
  withRetry,
  type Migration,
  type PostgresProvider,
} from "../index";
import { compileDynamicModelGraph } from "../Metadata/DynamicModelBuilder";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const prefix = `ormgc_${run}_`;
const ownedTables = new Set<string>();
const ownedMigrationIds = new Set<string>();
const ownedName = /^ormgc_[a-f0-9]{16}_[a-z0-9_]+$/;
const canonicalExactFive = Object.freeze([
  "orm.tx-batch.test.ts",
  "orm.migrations.test.ts",
  "orm.improvements.test.ts",
  "orm.postgres.live.test.ts",
  "orm.generic-contracts.postgres.live.test.ts",
] as const);
const exactFivePaths = Object.freeze([...canonicalExactFive]);

function registerTable(name: string): string {
  if (!ownedName.test(name) || ownedTables.has(name)) throw new Error("Invalid or duplicate owned table.");
  ownedTables.add(name);
  return name;
}
function registerMigration(id: string): string {
  if (!ownedName.test(id) || ownedMigrationIds.has(id)) throw new Error("Invalid or duplicate owned migration.");
  ownedMigrationIds.add(id);
  return id;
}
function quotedOwnedTable(name: string): string {
  if (!ownedTables.has(name) || !ownedName.test(name)) throw new Error("Unregistered table cleanup rejected.");
  return `"${name}"`;
}
function physical(name: string): string { return registerTable(`${prefix}${name}`); }

class DynamicContext extends DbContext {
  constructor(
    options: DbContextOptions,
    readonly fixtureModel: ReturnType<typeof buildDynamicModel>,
  ) {
    super(options);
  }
}
function context(provider: PostgresProvider, table: string): DynamicContext {
  return contextWithFields(provider, table, [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string", required: true }]);
}
function contextWithFields(provider: PostgresProvider, table: string, fields: Parameters<typeof buildDynamicModel>[0]["fields"]): DynamicContext {
  const model = buildDynamicModel({
    name: `Account${table.slice(-8)}`, tableName: table,
    fields,
  });
  const options = new DbContextOptions({ provider, entities: [], validateOnSave: false });
  options.model.registerModel(model);
  return new DynamicContext(options, model);
}
function migrationDatabase(provider: PostgresProvider): DatabaseFacade {
  return new DatabaseFacade(provider, new OrmModel([]));
}
async function withContext<T>(label: string, work: (provider: PostgresProvider, db: DynamicContext, table: string) => Promise<T>): Promise<T> {
  const provider = postgres({ url: url! });
  const table = physical(label);
  try {
    const db = context(provider, table);
    await db.database.ensureCreated();
    return await work(provider, db, table);
  } finally { await provider.close(); }
}

afterAll(async () => {
  if (!url) return;
  const observer = postgres({ url });
  try {
    await observer.withMigrationLock(async () => {
      if (ownedMigrationIds.size > 0) {
        const history = await observer.query("SELECT to_regclass('public.\"__BazisMigrations\"') AS relation", []);
        if (history[0]?.relation === null || history[0]?.relation === undefined) throw new Error("Registered migration history is unreadable during cleanup.");
        for (const id of ownedMigrationIds) await observer.execute('DELETE FROM "__BazisMigrations" WHERE "MigrationId" = $1', [id]);
      }
      for (const table of [...ownedTables].reverse()) await observer.execute(`DROP TABLE IF EXISTS ${quotedOwnedTable(table)} CASCADE`, []);
    });
  } finally { await observer.close(); }
});

test("GC ownership controls validate UUID-scoped names and source-sensitive cleanup", async () => {
  expect(run).toMatch(/^[a-f0-9]{16}$/);
  expect(prefix).toBe(`ormgc_${run}_`);
  expect(ownedName.test(`${prefix}accounts`)).toBe(true);
  for (const hostile of ["accounts", "ormgc_SHORT_x", "ormgc_ABCDEFGHIJKLMNOP_x", `${prefix}bad-name`]) expect(ownedName.test(hostile)).toBe(false);
  expect(() => quotedOwnedTable("accounts")).toThrow("Unregistered");
  const requireCanonicalManifest = (paths: readonly string[]): void => {
    if (paths.length !== canonicalExactFive.length || new Set(paths).size !== canonicalExactFive.length || paths.some((path, index) => path !== canonicalExactFive[index])) throw new Error("Exact-five manifest mismatch.");
  };
  requireCanonicalManifest(exactFivePaths);
  expect(() => requireCanonicalManifest([...exactFivePaths.slice(0, 4), "orm.schema.test.ts"])).toThrow("manifest mismatch");
  expect(() => requireCanonicalManifest(exactFivePaths.slice(1))).toThrow("manifest mismatch");
  expect(() => requireCanonicalManifest([...exactFivePaths.slice(0, 4), exactFivePaths[3]!])).toThrow("manifest mismatch");
  expect(new Set(exactFivePaths).size).toBe(5);
  expect(exactFivePaths.at(-1)).toBe("orm.generic-contracts.postgres.live.test.ts");
  expect(import.meta.file).toBe(exactFivePaths.at(-1)!);
  const sources = await Promise.all(exactFivePaths.map(async (path) => [path, await Bun.file(`${import.meta.dir}/${path}`).text()] as const));
  const forbidden = (source: string): boolean => [
    ["sql", "ite("].join(""), ["Sql", "iteProvider"].join(""), ["bun:", "sqlite"].join(""),
    ["pg_it_", "tags"].join(""), ["DROP TABLE", '"__BazisMigrations"'].join(" "),
    ["DELETE FROM", '"__BazisMigrations";'].join(" "), ["DROP TABLE IF EXISTS ${", "table}"].join(""),
  ].some((marker) => source.includes(marker));
  for (const [, source] of sources) expect(forbidden(source)).toBe(false);
  expect(forbidden(["const provider = sql", "ite();"].join(""))).toBe(true);
  expect(forbidden(["DROP TABLE", '"__BazisMigrations"'].join(" "))).toBe(true);
  expect(forbidden(["DELETE FROM", '"__BazisMigrations";'].join(" "))).toBe(true);
  expect(forbidden(["DROP TABLE IF EXISTS ${", "table}"].join(""))).toBe(true);
  expect(forbidden(["DELETE FROM", '"__BazisMigrations" WHERE "MigrationId" = $1'].join(" "))).toBe(false);
  const source = sources.find(([path]) => path === "orm.generic-contracts.postgres.live.test.ts")![1];
  expect(source).toContain("DROP TABLE IF EXISTS ${quotedOwnedTable(table)} CASCADE");
  expect(() => registerMigration("foreign_id")).toThrow("Invalid");
});

describe.skipIf(!url)("generic ORM contracts (PostgreSQL live)", () => {
  test("inserts multiple rows and returns ordered generated keys", async () => {
    await withContext("tx01_accounts", async (_provider, db) => {
      const set = db.setByName(db.fixtureModel.name);
      const rows = ["a", "b", "c"].map((name) => Object.assign(new db.fixtureModel.ctor(), { name }));
      set.addRange(rows); expect(await db.saveChanges()).toBe(3);
      const ids = rows.map((row) => Number((row as Record<string, unknown>).id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });
  });
  test("chunks a limited batch and persists every row", async () => {
    await withContext("tx02_accounts", async (provider, db) => {
      const original = provider.limits; (provider as unknown as { limits: typeof original }).limits = { ...original, maxParametersPerCommand: 2 };
      try { const set = db.setByName(db.fixtureModel.name); set.addRange(["a", "b", "c", "d", "e"].map((name) => Object.assign(new db.fixtureModel.ctor(), { name }))); await db.saveChanges(); expect(await set.count()).toBe(5); }
      finally { (provider as unknown as { limits: typeof original }).limits = original; }
    });
  });
  test("settles callbacks and committed outcomes exactly once", async () => {
    await withContext("tx03_accounts", async (provider) => {
      const events: string[] = []; await provider.transaction(async () => { provider.afterCommit(() => { events.push("commit"); }); }); expect(events).toEqual(["commit"]);
      await expect(provider.transaction(async () => { provider.afterCommit(() => { events.push("rollback-commit"); }); provider.afterRollback?.(() => { events.push("rollback"); }); throw new Error("rollback"); })).rejects.toThrow("rollback"); expect(events).toEqual(["commit", "rollback"]);
      let attempts = 0;
      const retrying = withRetry(provider, { maxRetries: 2, isTransient: () => true });
      await expect(retrying.transaction(async () => {
        attempts += 1;
        await provider.transaction(async () => { provider.afterCommit(() => { throw new Error("post-commit"); }); });
      })).rejects.toBeInstanceOf(PostCommitError);
      expect(attempts).toBe(1);
      expect(isCommittedOutcome(new PostCommitError([]))).toBe(true);
    });
  });
  test("preserves nested savepoint and callback dispositions", async () => {
    await withContext("tx04_accounts", async (provider) => {
      const scope = provider.transactionScope!.bind(provider);
      const events: string[] = []; await scope(async () => { try { await scope(async () => { provider.afterCommit(() => { events.push("inner"); }); throw new Error("inner"); }); } catch {} provider.afterCommit(() => { events.push("outer"); }); }); expect(events).toEqual(["outer"]);
      await expect(scope(async () => { await scope(async () => { provider.afterCommit(() => { events.push("released-commit"); }); provider.afterRollback?.(() => { events.push("released-rollback"); }); }); throw new Error("outer-rollback"); })).rejects.toThrow("outer-rollback");
      expect(events).toEqual(["outer", "released-rollback"]);
      await scope(async () => { await scope(async () => undefined); await scope(async () => undefined); });
      let siblingWork = 0;
      await scope(async () => {
        const first = scope(async () => { siblingWork += 1; await Bun.sleep(1); });
        const second = scope(async () => { siblingWork += 1; });
        await expect(second).rejects.toThrow(); await first;
      });
      expect(siblingWork).toBe(1);
    });
  });
  test("retries only known top-level work", async () => {
    await withContext("tx05_accounts", async (provider, db) => {
      let attempts = 0; const retrying = withRetry(provider, { maxRetries: 1, isTransient: () => true });
      await retrying.transaction(async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); }); expect(attempts).toBe(2);
      let nestedAttempts = 0;
      const set = db.setByName(db.fixtureModel.name);
      await expect(provider.transaction(async () => {
        set.add(Object.assign(new db.fixtureModel.ctor(), { name: "must-roll-back" }));
        await db.saveChanges();
        await expect(retrying.transaction(async () => { nestedAttempts += 1; throw new Error("nested"); })).rejects.toThrow("nested");
      })).rejects.toThrow("nested");
      expect(nestedAttempts).toBe(1);
      // A caught failure in a joined transaction still makes its root rollback-only.
      expect(await set.asNoTracking().count()).toBe(0);
    });
  });
  test("joins explicit transactions and restores provisional identity", async () => {
    await withContext("tx06_accounts", async (provider, db) => {
      const set = db.setByName(db.fixtureModel.name); const committed = Object.assign(new db.fixtureModel.ctor(), { name: "commit" }); set.add(committed);
      await provider.transaction(async () => { await db.saveChanges(); }); expect(await set.count()).toBe(1);
      const item = Object.assign(new db.fixtureModel.ctor(), { name: "retry" }); set.add(item);
      await expect(provider.transaction(async () => { await db.saveChanges(); throw new Error("rollback"); })).rejects.toThrow("rollback"); expect((item as Record<string, unknown>).id).toBeUndefined(); expect(await set.asNoTracking().count()).toBe(1);
      await db.saveChanges(); expect(Number((item as Record<string, unknown>).id)).toBeGreaterThan(0); expect(await set.asNoTracking().count()).toBe(2);
    });
  });

  test("restores the child savepoint baseline while retaining later tracked intent", async () => {
    await withContext("tx07_accounts", async (provider, db) => {
      const set = db.setByName(db.fixtureModel.name); const item = Object.assign(new db.fixtureModel.ctor(), { name: "A" }); set.add(item); await db.saveChanges();
      const id = Number((item as Record<string, unknown>).id); expect(id).toBeGreaterThan(0);
      await provider.transaction(async () => {
        (item as Record<string, unknown>).name = "B"; await db.saveChanges();
        try {
          await provider.transactionScope!(async () => { (item as Record<string, unknown>).name = "C"; await db.saveChanges(); throw new Error("child"); });
        } catch (error) { expect(String(error)).toContain("child"); }
        expect((await set.asNoTracking().first((row) => row.id!.eq(id))).name).toBe("B");
      });
      expect((item as Record<string, unknown>).name).toBe("C"); await db.saveChanges();
      expect((await set.asNoTracking().first((row) => row.id!.eq(id))).name).toBe("C");
    });
  });

  test("restores the outer baseline after released child saves", async () => {
    await withContext("tx08_accounts", async (provider, db) => {
      const set = db.setByName(db.fixtureModel.name); const item = Object.assign(new db.fixtureModel.ctor(), { name: "A" }); set.add(item); await db.saveChanges();
      const id = Number((item as Record<string, unknown>).id); expect(id).toBeGreaterThan(0);
      await expect(provider.transaction(async () => {
        (item as Record<string, unknown>).name = "B"; await db.saveChanges();
        await provider.transactionScope!(async () => { (item as Record<string, unknown>).name = "C"; await db.saveChanges(); });
        throw new Error("outer");
      })).rejects.toThrow("outer");
      expect((await set.asNoTracking().first((row) => row.id!.eq(id))).name).toBe("A");
      expect((item as Record<string, unknown>).name).toBe("C"); await db.saveChanges();
      expect((await set.asNoTracking().first((row) => row.id!.eq(id))).name).toBe("C");
    });
  });

  test("restores manual and composite Added plus existing Deleted after outer rollback", async () => {
    const provider = postgres({ url: url! }); const table = physical("tx09_manual");
    const manualModel = buildDynamicModel({ name: `Manual${table.slice(-8)}`, tableName: table, fields: [{ name: "id", type: "string", isKey: true }, { name: "name", type: "string", required: true }] });
    const manualOptions = new DbContextOptions({ provider, entities: [], validateOnSave: false }); manualOptions.model.registerModel(manualModel);
    const db = new DynamicContext(manualOptions, manualModel); await db.database.ensureCreated();
    try {
      const set = db.setByName(manualModel.name);
      const manual = Object.assign(new db.fixtureModel.ctor(), { id: "manual", name: "manual" }); set.add(manual);
      await expect(provider.transaction(async () => { await db.saveChanges(); throw new Error("manual-rollback"); })).rejects.toThrow("manual-rollback");
      const fresh = postgres({ url: url! });
      try { expect(await fresh.query(`SELECT "id" FROM ${quotedOwnedTable(table)} WHERE "id" = $1`, ["manual"])).toHaveLength(0); }
      finally { await fresh.close(); }
      expect(await db.saveChanges()).toBe(1);

      const existing = Object.assign(new db.fixtureModel.ctor(), { id: "existing", name: "existing" }); set.add(existing); expect(await db.saveChanges()).toBe(1);
      set.remove(existing);
      await expect(provider.transaction(async () => { await db.saveChanges(); throw new Error("delete-rollback"); })).rejects.toThrow("delete-rollback");
      const afterDeleteRollback = postgres({ url: url! });
      try { expect(await afterDeleteRollback.query(`SELECT "id" FROM ${quotedOwnedTable(table)} WHERE "id" = $1`, ["existing"])).toHaveLength(1); }
      finally { await afterDeleteRollback.close(); }
      expect(await db.saveChanges()).toBe(1);

      const compositeTable = physical("tx09_composite");
      const composite = buildDynamicModel({ name: `Composite${compositeTable.slice(-8)}`, tableName: compositeTable, primaryKey: { properties: ["tenant", "id"] }, fields: [{ name: "tenant", type: "string" }, { name: "id", type: "string" }, { name: "name", type: "string", required: true }] });
      const options = new DbContextOptions({ provider, entities: [], validateOnSave: false }); options.model.registerModel(composite);
      const compositeDb = new DynamicContext(options, composite); await compositeDb.database.ensureCreated();
      const compositeSet = compositeDb.setByName(composite.name); const compositeRow = Object.assign(new composite.ctor(), { tenant: "t", id: "one", name: "composite" }); compositeSet.add(compositeRow);
      await expect(provider.transaction(async () => { await compositeDb.saveChanges(); throw new Error("composite-rollback"); })).rejects.toThrow("composite-rollback");
      const afterCompositeRollback = postgres({ url: url! });
      try { expect(await afterCompositeRollback.query(`SELECT "id" FROM ${quotedOwnedTable(compositeTable)} WHERE "tenant" = $1 AND "id" = $2`, ["t", "one"])).toHaveLength(0); }
      finally { await afterCompositeRollback.close(); }
      expect(await compositeDb.saveChanges()).toBe(1);
    } finally { await provider.close(); }
  });

  test("explicit DbSet and Repository updates persist through fresh contexts", async () => {
    await withContext("imp07_updates", async (provider, db, table) => {
      const set = db.setByName(db.fixtureModel.name); const seed = Object.assign(new db.fixtureModel.ctor(), { name: "before" }); set.add(seed); expect(await db.saveChanges()).toBe(1);
      const id = Number((seed as Record<string, unknown>).id); expect(id).toBeGreaterThan(0);
      db.changeTracker.clear(); // Explicit detached update must not compete with a still-tracked seed.
      const detached = Object.assign(new db.fixtureModel.ctor(), { id, name: "dbset" }); set.update(detached); expect(await db.saveChanges()).toBe(1);
      const repository = new Repository(db, db.fixtureModel.ctor);
      const tracked = await repository.find(id); expect(tracked).not.toBeNull(); (tracked as Record<string, unknown>).name = "repository"; repository.update(tracked!); expect(await repository.saveChanges()).toBe(1);
      expect(await db.saveChanges()).toBe(0);
      const fresh = postgres({ url: url! });
      try {
        const freshDb = context(fresh, table); const freshSet = freshDb.setByName(freshDb.fixtureModel.name);
        expect((await freshSet.asNoTracking().first((row) => row.id!.eq(id))).name).toBe("repository");
      } finally { await fresh.close(); }
    });
  });

  test("retry wrapper retains schema admission capability", async () => {
    const provider = postgres({ url: url! }); const table = physical("imp08_retry_admission");
    try {
      const retrying = withRetry(provider, { maxRetries: 1, isTransient: () => false });
      const db = context(retrying as PostgresProvider, table);
      await db.database.ensureCreated();
      expect(await db.setByName(db.fixtureModel.name).count()).toBe(0);
    } finally { await provider.close(); }
  });

  test("applies additive migration once without data loss", async () => {
    const provider = postgres({ url: url! }); const table = physical("mig01_vectors");
    try {
      const v1 = contextWithFields(provider, table, [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string", required: true }]);
      await v1.database.migrate(); const set = v1.setByName(v1.fixtureModel.name);
      const row = Object.assign(new v1.fixtureModel.ctor(), { name: "preserved" }) as unknown as Record<string, unknown> & { id: number }; set.add(row); await v1.saveChanges();
      const v2 = contextWithFields(provider, table, [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string", required: true }, { name: "note", type: "string" }]);
      expect((await v2.database.migrate()).applied).toBeGreaterThan(0);
      expect((await provider.query(`SELECT "name", "note" FROM ${quotedOwnedTable(table)} WHERE "id"=$1`, [row.id]))[0]).toMatchObject({ name: "preserved", note: null });
      expect((await v2.database.migrate()).applied).toBe(0);
    } finally { await provider.close(); }
  });
  test("reports extra columns non-destructively", async () => {
    const provider = postgres({ url: url! }); const table = physical("mig02_vectors");
    try {
      const model = buildDynamicModel({ name: `Migrated${run}`, tableName: table, fields: [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string" }] });
      const options = new DbContextOptions({ provider, entities: [], validateOnSave: false }); options.model.registerModel(model); const db = new DynamicContext(options, model);
      await db.database.migrate();
      await provider.execute(`ALTER TABLE ${quotedOwnedTable(table)} ADD COLUMN "extra" text`, []);
      const result = await db.database.migrate();
      expect(result.warnings.some((warning) => warning.includes("extra"))).toBe(true);
      expect((await provider.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='extra'", [table])).length).toBe(1);
    } finally { await provider.close(); }
  });
  test("serializes concurrent migration with two providers", async () => {
    const table = physical("mig03_race"); const id = registerMigration(`${prefix}mig03_race`);
    const migration: Migration = { id, up: async (ctx) => { await ctx.execute(`CREATE TABLE ${quotedOwnedTable(table)} ("id" bigint PRIMARY KEY)`); }, down: async (ctx) => { await ctx.execute(`DROP TABLE IF EXISTS ${quotedOwnedTable(table)}`); } };
    const first = postgres({ url: url! }); const second = postgres({ url: url! });
    try {
      const [left, right] = await Promise.all([migrationDatabase(first).migrateVersioned([migration]), migrationDatabase(second).migrateVersioned([migration])]);
      expect([left.applied.length, right.applied.length].sort()).toEqual([0, 1]);
      expect((await first.query("SELECT \"MigrationId\" FROM \"__BazisMigrations\" WHERE \"MigrationId\"=$1", [id]))).toHaveLength(1);
    } finally { await first.close(); await second.close(); }
  });
  test("isolates versioned migrate replay and one-step rollback", async () => {
    const table = physical("mig04_versioned"); const id = registerMigration(`${prefix}mig04_versioned`);
    const migration: Migration = { id, up: async (ctx) => { await ctx.execute(`CREATE TABLE ${quotedOwnedTable(table)} ("id" bigint PRIMARY KEY)`); }, down: async (ctx) => { await ctx.execute(`DROP TABLE IF EXISTS ${quotedOwnedTable(table)}`); } };
    const provider = postgres({ url: url! });
    try {
      await provider.withMigrationLock(async () => {
        const before = await provider.query('SELECT MAX("AppliedAt") AS at FROM "__BazisMigrations"', []);
        const database = migrationDatabase(provider);
        await database.migrateVersioned([migration]);
        expect((await database.migrateVersioned([migration])).applied).toEqual([]);
        let last: Awaited<ReturnType<typeof provider.query>> = [];
        const deadline = Date.now() + 2_000;
        do { last = await provider.query('SELECT "MigrationId", "AppliedAt" FROM "__BazisMigrations" ORDER BY "AppliedAt" DESC LIMIT 1', []); if (last[0]?.MigrationId === id && (!before[0]?.at || new Date(String(last[0]?.AppliedAt)).getTime() > new Date(String(before[0].at)).getTime())) break; await Bun.sleep(20); } while (Date.now() < deadline);
        if (last[0]?.MigrationId !== id || (before[0]?.at && new Date(String(last[0]?.AppliedAt)).getTime() <= new Date(String(before[0].at)).getTime())) throw new Error("Versioned migration ownership/timestamp admission failed.");
        const requireOwnedLast = (candidate: string | undefined): void => { if (candidate !== id) throw new Error("Foreign last migration aborts before rollback."); };
        expect(() => requireOwnedLast("foreign")).toThrow("Foreign last migration");
        requireOwnedLast(String(last[0]?.MigrationId));
        await database.rollbackVersioned([migration], 1);
        expect(await provider.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [table])).toEqual([]);
      });
    } finally { await provider.close(); }
  });

  test("preserves tracking identity and no-tracking behavior", async () => {
    await withContext("imp01_tracking", async (_provider, db) => {
      const set = db.setByName(db.fixtureModel.name); const item = Object.assign(new db.fixtureModel.ctor(), { name: "tracked" }); set.add(item); await db.saveChanges();
      const first = await set.first(); const again = await set.first(); const detached = await set.asNoTracking().first();
      expect(again).toBe(first); expect(detached).not.toBe(first); first.name = "changed"; await db.saveChanges(); expect((await set.asNoTracking().first()).name).toBe("changed");
    });
  });
  test("persists escaped query and JSON change semantics", async () => {
    const provider = postgres({ url: url! }); const table = physical("imp02_json");
    try {
      const db = contextWithFields(provider, table, [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string", required: true }, { name: "meta", type: "json" }]); await db.database.ensureCreated();
      const set = db.setByName(db.fixtureModel.name); for (const [name, meta] of [["100%", { n: 1 }], ["under_score", { n: 2 }], ["plain", { n: 3 }]] as const) set.add(Object.assign(new db.fixtureModel.ctor(), { name, meta })); await db.saveChanges();
      expect(await set.where((row) => row.name!.startsWith("100%")).count()).toBe(1); expect(await set.where((row) => row.name!.contains("_")).count()).toBe(1);
      const tracked = await set.first((row) => row.name!.eq("100%")); (tracked.meta as { n: number }).n = 4; expect(await db.saveChanges()).toBe(1); expect((await set.asNoTracking().first((row) => row.name!.eq("100%"))).meta).toEqual({ n: 4 });
      expect(await db.saveChanges()).toBe(0);
    } finally { await provider.close(); }
  });
  test("reports missing entity without a substitute result", async () => {
    await withContext("imp03_missing", async (_provider, db) => {
      const set = db.setByName(db.fixtureModel.name); await expect(set.first()).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });
  test("preserves provider methods and transaction callbacks through retry", async () => {
    await withContext("imp04_retry", async (provider) => {
      const retrying = withRetry(provider, { maxRetries: 1, isTransient: () => true }); const events: string[] = [];
      const afterCommit = retrying.afterCommit;
      if (afterCommit === undefined) throw new Error("Retry provider lost afterCommit.");
      let attempts = 0; await retrying.transaction(async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); afterCommit(() => { events.push("commit"); }); });
      expect(attempts).toBe(2); expect(events).toEqual(["commit"]); expect(await retrying.ping()).toBe(true); expect(retrying.close).toBeDefined();
    });
  });
  test("chunks IN values and loads complete navigation", async () => {
    const provider = postgres({ url: url! }); const categoriesTable = physical("imp05_categories"); const productsTable = physical("imp05_products");
    try {
      const [categories, products] = compileDynamicModelGraph([{ name: `Category${run}`, tableName: categoriesTable, fields: [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string" }], relations: [{ navigationName: "products", kind: "collection", target: `Product${run}`, foreignKey: "categoryId" }] }, { name: `Product${run}`, tableName: productsTable, fields: [{ name: "id", type: "int", isKey: true }, { name: "name", type: "string" }, { name: "categoryId", type: "foreignKey", target: `Category${run}`, navigationName: "category", inverseNavigationName: "products", targetKeyType: "int" }] }]);
      if (categories === undefined || products === undefined) throw new Error("Dynamic relation fixture compilation is incomplete.");
      const options = new DbContextOptions({ provider, entities: [], validateOnSave: false }); options.model.registerModel(categories); options.model.registerModel(products); const db = new DynamicContext(options, categories); await db.database.ensureCreated();
      const categorySet = db.setByName(categories.name); const productSet = db.setByName(products.name);
      const categoryRows = ["a", "b", "c"].map((name) => Object.assign(new categories.ctor(), { name }) as Record<string, unknown> & { id: number; name: string }); categorySet.addRange(categoryRows); await db.saveChanges();
      for (const [name, categoryId] of [["a1", categoryRows[0]!.id], ["a2", categoryRows[0]!.id], ["b1", categoryRows[1]!.id], ["c1", categoryRows[2]!.id], ["c2", categoryRows[2]!.id]] as const) productSet.add(Object.assign(new products.ctor(), { name, categoryId })); await db.saveChanges();
      const original = provider.limits; (provider as unknown as { limits: typeof original }).limits = { ...original, maxParametersPerCommand: 2 };
      try { const loaded = await categorySet.include((row) => row.products).toList(); expect(loaded.map((row) => row.name).sort()).toEqual(["a", "b", "c"]); expect(loaded.flatMap((row) => (row.products as Array<Record<string, unknown>>).map((product) => product.name)).sort()).toEqual(["a1", "a2", "b1", "c1", "c2"]); expect(new Set(loaded.flatMap((row) => (row.products as Array<Record<string, unknown>>).map((product) => product.id))).size).toBe(5); }
      finally { (provider as unknown as { limits: typeof original }).limits = original; }
    } finally { await provider.close(); }
  });
  test("redacts by default and exposes raw tracing only explicitly", async () => {
    const secret = "trace-secret-value"; const redacted: unknown[][] = []; const raw: unknown[][] = [];
    const defaultProvider = postgres({ url: url!, onSql: (_sql, params) => redacted.push([...params]) }); const rawProvider = postgres({ url: url!, redactSqlParams: false, onSql: (_sql, params) => raw.push([...params]) }); const defaultTable = physical("imp06_redacted"); const rawTable = physical("imp06_raw");
    try { for (const [provider, table] of [[defaultProvider, defaultTable], [rawProvider, rawTable]] as const) { const db = context(provider, table); await db.database.ensureCreated(); const set = db.setByName(db.fixtureModel.name); set.add(Object.assign(new db.fixtureModel.ctor(), { name: secret })); await db.saveChanges(); } expect(JSON.stringify(redacted)).not.toContain(secret); expect(JSON.stringify(raw)).toContain(secret); }
    finally { await defaultProvider.close(); await rawProvider.close(); }
  });
});

test.skipIf(Boolean(url))("GC live contracts are explicitly skipped without BAZIS_PG_URL", () => expect(url).toBeUndefined());
