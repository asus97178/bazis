import { expect, test } from "bun:test";
import {
  Column, DbContext, DbContextOptions, Entity, EntityState, ForeignKey,
  HasConversion, Key, ManyToOne, OneToMany, OrmModel, PostgresProvider, UUID,
  Schema, ExecutionStrategy, withRetry, buildDynamicModel,
  type DatabaseProvider, type Row, type SqlParam,
} from "../index";
import { PostgresDialect } from "../Providers/PostgresDialect";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";
import { compileDynamicModelGraph } from "../Metadata/DynamicModelBuilder";
import { TransactionOutcomeUnknownError } from "../Providers/transactionOutcome";
import { renderSafeAdditivePostgres } from "../Schema/SafeAdditiveSchema";

class Context extends DbContext {}
type Statement = { sql: string; params: readonly SqlParam[] };
function recording(read: (sql: string, params: readonly SqlParam[]) => Row[] = () => []) {
  const statements: Statement[] = [];
  let active = false;
  const provider: DatabaseProvider = {
    name: "postgres", dialect: new PostgresDialect(), limits: { maxParametersPerCommand: 32767 },
    async query(sql, params) { statements.push({ sql, params }); return read(sql, params); },
    async execute(sql, params) { statements.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; },
    async transaction(work) { const previous = active; active = true; try { return await work(provider); } finally { active = previous; } },
    isTransactionActive: () => active,
    async ping() { return true; }, async introspect() { return { tables: new Map() }; }, async close() {},
  };
  return { provider, statements };
}
function ctx(provider: DatabaseProvider, entities: (new () => object)[]) {
  return new Context(new DbContextOptions({ provider, entities, validateOnSave: false }));
}
function mockPostgres(read: (sql: string) => Row[] = () => []) {
  const provider = new PostgresProvider({ options: {} });
  const statements: string[] = [];
  const session = {
    async unsafe(sql: string, _params?: readonly unknown[]) {
      statements.push(sql);
      const result = read(sql);
      return Object.assign(result, { count: sql.startsWith("INSERT") ? 1 : 0 });
    },
    async release() { statements.push("RELEASE_CONNECTION"); },
  };
  // Same injection point used by the checked-in PostgresProvider unit suites.
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    async reserve() { return session; },
    async unsafe() { throw new Error("unexpected root SQL"); },
    async close() {},
  } });
  return { provider, statements };
}

@Entity({ table: "audit_items" })
class Item {
  @Key({ generated: false }) id = 1;
  @Column({ type: "text" }) name = "before";
}
@Entity({ table: "audit_broken" })
class Broken {
  @Key({ generated: false }) id = 2;
  @HasConversion({ toProvider() { throw new Error("conversion failed"); }, fromProvider(value: unknown) { return value; } })
  @Column({ type: "text" }) name = "broken";
}

test("A1: caught SaveChanges failure must not commit earlier statements of that failed save", async () => {
  const { provider, statements } = mockPostgres();
  const context = ctx(provider, [Item, Broken]);
  const item = new Item(); context.add(item); context.add(new Broken());
  let caught = false;
  await expect(context.database.transaction(async () => {
    try { await context.saveChanges(); } catch { caught = true; }
  })).rejects.toThrow("conversion failed");
  expect(caught).toBe(true);
  expect(statements.some(sql => sql.startsWith("INSERT INTO \"audit_items\""))).toBe(true);
  expect(statements).not.toContain("COMMIT");
});

test("control: uncaught top-level SaveChanges conversion failure rolls back", async () => {
  const { provider, statements } = mockPostgres();
  const context = ctx(provider, [Item, Broken]); context.add(new Item()); context.add(new Broken());
  await expect(context.saveChanges()).rejects.toThrow("conversion failed");
  expect(statements).toContain("ROLLBACK"); expect(statements).not.toContain("COMMIT");
});

test("A2: locking reload must preserve or reject pending snapshot-tracked changes", async () => {
  const { provider } = recording(() => [{ id: 1, name: "database value" }]);
  const context = ctx(provider, [Item]); const items = context.setOf(Item);
  const item = (await items.find(1))!; item.name = "unsaved edit";
  let rejected = false;
  try { await context.database.transaction(() => items.findForUpdate(1)); } catch { rejected = true; }
  const saved = await context.saveChanges();
  expect(rejected).toBe(true);
  expect(item.name).toBe("unsaved edit");
  expect(saved).toBe(1);
});

test("control: locking reload refreshes a clean tracked entity", async () => {
  let name = "before";
  const { provider } = recording(() => [{ id: 1, name }]);
  const context = ctx(provider, [Item]); const items = context.setOf(Item);
  const item = (await items.find(1))!; name = "after";
  expect(await context.database.transaction(() => items.findForUpdate(1))).toBe(item);
  expect(item.name).toBe("after");
});

@Entity({ table: "audit_uuid_parents" })
class UuidParent { @UUID() id = ""; }
@Entity({ table: "audit_uuid_children" })
@ForeignKey(() => UuidParent, { properties: ["parentId"] })
class UuidChild {
  @Key({ generated: false }) id = 1;
  @Column({ type: "uuid", nullable: false }) parentId = "00000000-0000-4000-8000-000000000001";
}
test("A3: a declared FK to UUID must compile to compatible physical column types", () => {
  const expected = compileExpectedSchema(new OrmModel([UuidParent, UuidChild]));
  const parent = expected.tables.find(t => t.table === "audit_uuid_parents")!;
  const child = expected.tables.find(t => t.table === "audit_uuid_children")!;
  expect(child.columns.find(c => c.column === "parentId")!.physicalType).toBe(parent.columns[0]!.physicalType);
});

@Entity({ table: "audit_identity" })
class Identity { @Key() id = 0; }
function identityCatalog(identityKind: "a" | "d") {
  return mockPostgres(sql => {
    if (sql.startsWith("SELECT 1 FROM pg_namespace") || sql.startsWith("SELECT 1 FROM pg_class")) return [{}];
    if (sql.includes("FROM pg_attribute a")) return [{ column_name: "id", not_null: true, type_name: "bigint", default_expr: null, identity_kind: identityKind }];
    if (sql.includes("c.contype = 'p'")) return [{ constraint_name: "pk_audit_identity", column_name: "id", ord: 1 }];
    return [];
  });
}
test("A4: ensureCreated must reject GENERATED ALWAYS drift from BY DEFAULT", async () => {
  const { provider, statements } = identityCatalog("a");
  const context = ctx(provider, [Identity]);
  let rejected = false;
  try { await context.database.ensureCreated(); } catch { rejected = true; }
  expect(rejected).toBe(true);
});
test("control: ensureCreated accepts matching BY DEFAULT identity", async () => {
  const { provider, statements } = identityCatalog("d");
  await ctx(provider, [Identity]).database.ensureCreated();
  expect(statements).toContain("COMMIT");
});

@Entity({ table: "audit_big_parents" })
class BigParent {
  @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = "a";
  @Column({ type: "integer" }) id = 9223372036854775806n;
}
@Entity({ table: "audit_big_children" })
class BigChild {
  @Key({ generated: false }) id = 1;
  @Column({ type: "text" }) tenant = "a";
  @Column({ type: "integer" }) parentId = 9223372036854775806n;
  @ManyToOne(() => BigParent, { foreignKey: ["tenant", "parentId"] }) parent?: BigParent;
}
test("A5a: include supports bigint composite keys", async () => {
  const { provider } = recording(sql => sql.includes('FROM "audit_big_children"')
    ? [{ id: 1, tenant: "a", parentId: 9223372036854775806n }]
    : [{ tenant: "a", id: 9223372036854775806n }]);
  const context = ctx(provider, [BigChild, BigParent]);
  const child = await context.setOf(BigChild).include(c => c.parent).first();
  expect(child.parent?.id).toBe(9223372036854775806n);
});

@Entity({ table: "audit_date_parents" })
class DateParent {
  @Key({ generated: false }) @Column({ type: "datetime" }) id = new Date(0);
}
@Entity({ table: "audit_date_children" })
class DateChild {
  @Key({ generated: false }) id = 1;
  @Column({ type: "datetime" }) parentId = new Date(0);
  @ManyToOne(() => DateParent, { foreignKey: "parentId" }) parent?: DateParent;
}
test("A5b: include matches equal Date keys by value", async () => {
  const { provider, statements } = recording(sql => sql.includes('FROM "audit_date_children"')
    ? [{ id: 1, parentId: new Date(0) }] : [{ id: new Date(0) }]);
  const context = ctx(provider, [DateChild, DateParent]);
  const child = await context.setOf(DateChild).include(c => c.parent).first();
  expect(child.parent).not.toBeNull();
});

test("A6: addRange supports multiple rows with only a generated key", async () => {
  let next = 1;
  const { provider } = recording(() => [{ id: next++ }]);
  const context = ctx(provider, [Identity]); const items = [new Identity(), new Identity()];
  context.setOf(Identity).addRange(items);
  expect(await context.saveChanges()).toBe(2);
  expect(items.map(x => x.id)).toEqual([1, 2]);
});
test("control: one row with only a generated key can be saved", async () => {
  const { provider } = recording(() => [{ id: 7 }]); const context = ctx(provider, [Identity]);
  const item = new Identity(); context.add(item);
  expect(await context.saveChanges()).toBe(1); expect(item.id).toBe(7);
});

@Entity({ table: "audit_dotted" })
class Dotted {
  @Key({ generated: false }) id = 1;
  @Column({ name: "external.name", type: "text" }) externalName = "x";
}
test("A7: query quotes the same literal column identifier as ensureCreated", async () => {
  const { provider, statements } = recording(); const context = ctx(provider, [Dotted]);
  const expected = compileExpectedSchema(new OrmModel([Dotted]));
  const ddl = renderSafeAdditivePostgres({ kind: "createTable", table: expected.tables[0]! });
  await context.setOf(Dotted).toList();
  expect(ddl).toContain('"external.name"');
  expect(statements[0]!.sql).toContain('"external.name"');
});

test("A8: retry must not replay an INSERT after COMMIT acknowledgement is lost", async () => {
  const provider = new PostgresProvider({ options: {} });
  const committedIds: number[] = [];
  const statements: string[] = [];
  let next = 0, loseFirstCommitAck = true;
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    async reserve() {
      let staged: number[] = [];
      return {
        async unsafe(sql: string) {
          statements.push(sql);
          if (sql.startsWith("INSERT")) { const id = ++next; staged.push(id); return [{ id }]; }
          if (sql === "COMMIT") {
            // Fault model: server commits successfully, then the connection
            // drops before the client receives acknowledgement.
            committedIds.push(...staged); staged = [];
            if (loseFirstCommitAck) { loseFirstCommitAck = false; throw new Error("ECONNRESET"); }
          }
          if (sql === "ROLLBACK") staged = [];
          return [];
        },
        async release() {},
      };
    },
    async unsafe() { throw new Error("unexpected root SQL"); }, async close() {},
  } });
  const context = new Context(new DbContextOptions({ provider, entities: [Identity], validateOnSave: false,
    executionStrategy: { maxRetries: 1, baseDelayMs: 0 } }));
  const item = new Identity(); context.add(item);
  let outcome: string;
  try { outcome = `success:${await context.saveChanges()}`; } catch { outcome = "rejected"; }
  expect(committedIds).toHaveLength(1);
  expect(outcome).toBe("rejected");
  await expect(context.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(committedIds).toHaveLength(1);
});

test("A1: a failed joined save poisons only its containing savepoint and never retries there", async () => {
  const { provider, statements } = mockPostgres();
  const context = new Context(new DbContextOptions({ provider, entities: [Item, Broken], validateOnSave: false,
    executionStrategy: { maxRetries: 2, baseDelayMs: 0, isTransient: () => true } }));
  context.add(new Item()); context.add(new Broken());
  await provider.transaction(async (tx) => {
    await expect(provider.transactionScope(async () => {
      await expect(context.saveChanges()).rejects.toThrow("conversion failed");
    })).rejects.toThrow("conversion failed");
    await tx.execute("outer work after savepoint rollback", []);
  });
  expect(statements.filter(sql => sql.startsWith('INSERT INTO "audit_items"'))).toHaveLength(1);
  expect(statements.some(sql => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
  expect(statements).toContain("COMMIT");
});

@Entity({ table: "audit_mutable" })
class Mutable {
  @Key({ generated: false }) id = 1;
  @Column({ type: "json" }) data = { nested: { value: 1 } };
  @Column({ type: "datetime" }) at = new Date(0);
}
for (const mutation of ["json", "date", "explicit", "key"] as const) {
  test(`A2: locking reload rejects ${mutation} changes before overwriting them`, async () => {
    const { provider } = recording(() => [{ id: 1, data: { nested: { value: 1 } }, at: new Date(0) }]);
    const context = ctx(provider, [Mutable]); const set = context.setOf(Mutable);
    const entity = (await set.find(1))!;
    if (mutation === "json") entity.data.nested.value = 2;
    if (mutation === "date") entity.at.setTime(1);
    if (mutation === "explicit") context.update(entity);
    if (mutation === "key") entity.id = 2;
    await expect(context.database.transaction(() => set.findForUpdate(1))).rejects.toThrow();
    if (mutation === "json") expect(entity.data.nested.value).toBe(2);
    if (mutation === "date") expect(entity.at.getTime()).toBe(1);
    if (mutation === "key") expect(entity.id).toBe(2);
    if (mutation === "explicit") expect(context.stateOf(entity)).toBe(EntityState.Modified);
  });
}

@Schema('schema.with"quote')
@Entity({ table: "uuid.parents", migrate: true })
class QualifiedUuidParent { @UUID() id = ""; }
@Entity({ table: "uuid.children", migrate: true })
class NavigationUuidChild {
  @Key({ generated: false }) id = 1;
  @Column({ type: "uuid" }) parentId: string | null = null;
  @ManyToOne(() => QualifiedUuidParent, { foreignKey: "parentId" }) parent?: QualifiedUuidParent;
}

test("A3/A7: exact and additive schema use UUID FK storage and literal qualified names", async () => {
  const models = new OrmModel([QualifiedUuidParent, NavigationUuidChild]);
  const expected = compileExpectedSchema(models);
  expect(expected.tables.find(t => t.table === "uuid.children")!.columns[1]!.physicalType).toBe("uuid");
  const { provider, statements } = recording();
  const context = ctx(provider, [QualifiedUuidParent, NavigationUuidChild]);
  await context.database.migrate();
  const childDdl = statements.find(s => s.sql.startsWith('CREATE TABLE IF NOT EXISTS "uuid.children"'))!.sql;
  expect(childDdl).toContain('"parentId" uuid');
  expect(childDdl).toContain('REFERENCES "schema.with""quote"."uuid.parents" ("id")');
  expect(statements.some(s => s.sql === 'CREATE SCHEMA IF NOT EXISTS "schema.with""quote"')).toBe(true);
});

test("A3: dynamic models propagate UUID through a primary-key/foreign-key chain", () => {
  const graph = compileDynamicModelGraph([
    { name: "ChainLeaf", tableName: "chain_leaf", fields: [{ name: "id", type: "int", isKey: true }, { name: "rootId", type: "string" }, { name: "part", type: "int" }], foreignKeys: [{ properties: ["rootId", "part"], target: "ChainMiddle" }] },
    { name: "ChainMiddle", tableName: "chain_middle", fields: [{ name: "id", type: "string" }, { name: "part", type: "int" }], primaryKey: { properties: ["id", "part"] }, foreignKeys: [{ properties: ["id"], target: "ChainRoot" }] },
    { name: "ChainRoot", tableName: "chain_roots", fields: [{ name: "id", type: "uuid", isKey: true }] },
  ]);
  const models = new OrmModel([]); graph.forEach(m => models.registerModel(m));
  const expected = compileExpectedSchema(models);
  expect(expected.tables.find(t => t.table === "chain_middle")!.columns[0]!.physicalType).toBe("uuid");
  expect(expected.tables.find(t => t.table === "chain_leaf")!.columns.map(c => c.physicalType)).toEqual(["integer", "uuid", "integer"]);
});

test("A3: additive new FK columns retain native UUID storage without inventing a backfill value", async () => {
  const { provider, statements } = recording();
  provider.introspect = async () => ({ tables: new Map([
    ["uuid.children", { name: "uuid.children", columns: new Map([["id", { name: "id", type: "integer", notNull: true, isPrimaryKey: true }]]), indexes: [] }],
  ]) });
  await ctx(provider, [QualifiedUuidParent, NavigationUuidChild]).database.migrate();
  expect(statements.find(s => s.sql.startsWith('ALTER TABLE "uuid.children"'))!.sql).toBe(
    'ALTER TABLE "uuid.children" ADD COLUMN IF NOT EXISTS "parentId" uuid REFERENCES "schema.with""quote"."uuid.parents" ("id")');
});

@Entity({ table: "audit_date_groups" })
class DateGroup {
  @Key({ generated: false }) @Column({ type: "datetime" }) id = new Date(0);
  @OneToMany(() => DateMember, { foreignKey: "groupId" }) members?: DateMember[];
}
@Entity({ table: "audit_date_members" })
class DateMember {
  @Key({ generated: false }) id = 1;
  @Column({ type: "datetime" }) groupId: Date | null = new Date(0);
}
for (const noTracking of [false, true]) {
  test(`A5: collection Date keys compare by value (noTracking=${noTracking})`, async () => {
    const { provider } = recording(sql => sql.includes('FROM "audit_date_groups"') ? [{ id: new Date(0) }]
      : [{ id: 1, groupId: new Date(0) }, { id: 2, groupId: new Date(0) }, { id: 3, groupId: null }]);
    const context = ctx(provider, [DateGroup, DateMember]);
    const query = context.setOf(DateGroup).include(x => x.members);
    const group = await (noTracking ? query.asNoTracking() : query).first();
    expect(group.members?.map(x => x.id)).toEqual([1, 2]);
  });
}

const bytesConversion = {
  toProvider: (value: unknown) => [...value as Uint8Array].join(","),
  fromProvider: (value: unknown) => new Uint8Array(String(value).split(",").map(Number)),
};
@Entity({ table: "audit_binary_groups" })
class BinaryGroup {
  @Key({ generated: false }) @Column({ type: "text" }) @HasConversion(bytesConversion) id = new Uint8Array([1, 2]);
  @OneToMany(() => BinaryMember, { foreignKey: "groupId" }) members?: BinaryMember[];
}
@Entity({ table: "audit_binary_members" })
class BinaryMember {
  @Key({ generated: false }) id = 1;
  @Column({ type: "text" }) @HasConversion(bytesConversion) groupId = new Uint8Array([1, 2]);
  @ManyToOne(() => BinaryGroup, { foreignKey: "groupId" }) group?: BinaryGroup;
}
test("A5: reference and collection use the identity map's binary key semantics", async () => {
  const { provider } = recording(sql => sql.includes('FROM "audit_binary_groups"') ? [{ id: "1,2" }] : [{ id: 1, groupId: "1,2" }]);
  const context = ctx(provider, [BinaryGroup, BinaryMember]);
  const member = await context.setOf(BinaryMember).include(x => x.group).first();
  expect(member.group?.id).toEqual(new Uint8Array([1, 2]));
  const group = await context.setOf(BinaryGroup).include(x => x.members).first();
  expect(group.members).toHaveLength(1);
  expect(group.members![0]).toBe(member);
});

test("A6: failure of a later DEFAULT VALUES row restores every generated key", async () => {
  let insert = 0;
  const { provider, statements } = mockPostgres(sql => {
    if (sql.startsWith("INSERT")) { if (++insert === 2) throw new Error("second insert failed"); return [{ id: 42 }]; }
    return [];
  });
  const context = ctx(provider, [Identity]); const items = [new Identity(), new Identity()];
  context.setOf(Identity).addRange(items);
  await expect(context.saveChanges()).rejects.toThrow("second insert failed");
  expect(items.map(x => x.id)).toEqual([0, 0]);
  expect(items.map(x => context.stateOf(x))).toEqual([EntityState.Added, EntityState.Added]);
  expect(statements).toContain("ROLLBACK"); expect(statements).not.toContain("COMMIT");
});

test("A7: dotted columns stay literal in filters, ordering, INSERT, UPDATE and DELETE", async () => {
  const { provider, statements } = recording(() => [{ id: 1, "external.name": "x" }]);
  const context = ctx(provider, [Dotted]); const set = context.setOf(Dotted);
  const entity = await set.where(x => x.externalName.eq("x")).orderBy(x => x.externalName).first();
  entity.externalName = "edited"; await context.saveChanges();
  context.remove(entity); await context.saveChanges();
  context.add(new Dotted()); await context.saveChanges();
  const sql = statements.map(s => s.sql).join("\n");
  expect(sql).toContain('WHERE "external.name" = $1');
  expect(sql).toContain('ORDER BY "external.name"');
  expect(sql).toContain('SET "external.name" = $1');
  expect(sql).toContain('("id", "external.name") VALUES');
  expect(sql).not.toContain('"external"."name"');
});

for (const mode of ["owned", "borrowed", "fallback"] as const) {
  for (const cleanupFails of [false, true]) {
    test(`A8: unknown COMMIT blocks automatic and manual retries (${mode}, cleanupFails=${cleanupFails})`, async () => {
      const actual = new PostgresProvider({ options: {} });
      const events: string[] = []; let next = 0;
      const session = {
        async unsafe(sql: string) {
          events.push(sql);
          if (sql.startsWith("INSERT")) return [{ id: ++next }];
          if (sql === "COMMIT") throw new Error("ECONNRESET");
          return [];
        },
        async close() { events.push("close reservation"); if (cleanupFails) throw new Error("close failed"); },
        async release() { events.push("release"); if (cleanupFails) throw new Error("ETIMEDOUT"); },
      };
      Object.defineProperty(actual, "sql", { configurable: true, value: {
        ...(mode === "fallback" ? {} : { reserve: async () => session }),
        async begin(work: (tx: typeof session) => Promise<unknown>) { await work(session); throw new Error("ECONNRESET"); },
        async unsafe() { throw new Error("unexpected root SQL"); }, async close() {},
      } });
      const provider = withRetry(actual, { maxRetries: 2, baseDelayMs: 0, isTransient: () => true });
      const first = ctx(provider, [Identity]); const second = ctx(provider, [Identity]);
      first.add(new Identity()); second.add(new Identity());
      const work = () => provider.transaction(async () => {
        actual.afterCommit(() => { events.push("afterCommit"); });
        actual.afterRollback(() => { events.push("afterRollback"); });
        await first.saveChanges(); await second.saveChanges();
      });
      await expect(mode === "borrowed" ? actual.withMigrationLock(work) : work()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
      expect(next).toBe(2);
      expect(events).not.toContain("afterCommit"); expect(events).not.toContain("afterRollback");
      await expect(first.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
      await expect(second.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
      expect(next).toBe(2);
      if (mode !== "fallback") {
        expect(events.filter(e => e === "close reservation")).toHaveLength(1);
        // Failed close leaves a potentially busy reservation isolated from new borrowers.
        expect(events.filter(e => e === "release")).toHaveLength(cleanupFails ? 0 : 1);
      }
    });
  }
}

for (const errno of ["40001", "40P01", "23505"]) {
  test(`A8: confirmed server COMMIT rejection ${errno} restores state and permits retry`, async () => {
    let insert = 0, commits = 0, rollbacks = 0;
    const { provider } = mockPostgres(sql => {
      if (sql.startsWith("INSERT")) return [{ id: ++insert }];
      if (sql === "COMMIT" && ++commits === 1) throw Object.assign(new Error("server rejected commit"), { errno });
      if (sql === "ROLLBACK") rollbacks++;
      return [];
    });
    const context = ctx(provider, [Identity]); const entity = new Identity(); context.add(entity);
    await expect(context.saveChanges()).rejects.toMatchObject({ errno });
    expect(entity.id).toBe(0); expect(context.stateOf(entity)).toBe(EntityState.Added);
    expect(await context.saveChanges()).toBe(1);
    expect(entity.id).toBe(2); expect(rollbacks).toBe(1);
  });
}

test("A8: custom retry classifiers cannot replay an unknown outcome hidden by cleanup aggregation", async () => {
  let attempts = 0;
  const strategy = new ExecutionStrategy({ maxRetries: 3, baseDelayMs: 0, isTransient: () => true });
  await expect(strategy.execute(async () => {
    attempts++;
    throw new AggregateError([new Error("cleanup"), new Error("wrapped", { cause: new TransactionOutcomeUnknownError() })]);
  })).rejects.toBeInstanceOf(AggregateError);
  expect(attempts).toBe(1);
});

@Entity({ table: "audit_big_groups" })
class BigGroup {
  @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = "a";
  @Column({ type: "integer" }) id = 9223372036854775806n;
  @OneToMany(() => BigMember, { foreignKey: ["tenant", "groupId"] }) members?: BigMember[];
}
@Entity({ table: "audit_big_members" })
class BigMember {
  @Key({ generated: false }) id = 1;
  @Column({ type: "text" }) tenant = "a";
  @Column({ type: "integer" }) groupId: bigint | null = 9223372036854775806n;
}
test("A5: composite bigint collection keys support chunking and ignore incomplete foreign keys", async () => {
  const { provider, statements } = recording((sql, params) => sql.includes('FROM "audit_big_groups"')
    ? [{ tenant: "a", id: 9223372036854775806n }, { tenant: "b", id: 9223372036854775806n }]
    : params[0] === "a" ? [{ id: 1, tenant: "a", groupId: 9223372036854775806n }, { id: 2, tenant: "a", groupId: null }] : []);
  Object.defineProperty(provider, "limits", { value: { maxParametersPerCommand: 32767, maxParametersPerInList: 2 } });
  const groups = await ctx(provider, [BigGroup, BigMember]).setOf(BigGroup).include(x => x.members).asNoTracking().toList();
  expect(groups[0]!.members?.map(x => x.id)).toEqual([1]);
  expect(groups[1]!.members).toEqual([]);
  expect(statements).toHaveLength(3);
});

test("A7: dynamic schema and table names containing dots retain separate physical identities", () => {
  const model = buildDynamicModel({ name: "LiteralDynamic", schema: 'schema.with"quote', tableName: "table.with.dot", fields: [{ name: "id", type: "int", isKey: true }] });
  const models = new OrmModel([]); models.registerModel(model);
  const table = compileExpectedSchema(models).tables[0]!;
  expect(table.schema).toBe('schema.with"quote'); expect(table.table).toBe("table.with.dot");
  expect(new PostgresDialect().qualifyTable(model)).toBe('"schema.with""quote"."table.with.dot"');
  expect(renderSafeAdditivePostgres({ kind: "createTable", table })).toContain('"schema.with""quote"."table.with.dot"');
});

for (const errno of ["08006", "08007", "40003"]) {
  test(`A8: SQLSTATE ${errno} does not prove rollback`, async () => {
    let inserts = 0;
    const { provider } = mockPostgres(sql => {
      if (sql.startsWith("INSERT")) { inserts++; return [{ id: 1 }]; }
      if (sql === "COMMIT") throw Object.assign(new Error("server outcome unavailable"), { errno });
      return [];
    });
    const context = new Context(new DbContextOptions({ provider, entities: [Identity], validateOnSave: false,
      executionStrategy: { maxRetries: 2, baseDelayMs: 0, isTransient: () => true } }));
    context.add(new Identity());
    await expect(context.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
    expect(inserts).toBe(1);
  });
}

test("A8: a known owner commit takes precedence over an uncertain transaction in an afterCommit callback", async () => {
  const { provider, statements } = mockPostgres(sql => sql.startsWith("INSERT") ? [{ id: 7 }] : []);
  const transaction = provider.transaction.bind(provider);
  provider.transaction = work => transaction(async tx => {
    provider.afterCommit(() => { throw new TransactionOutcomeUnknownError(); });
    return work(tx);
  });
  const context = ctx(provider, [Identity]); const entity = new Identity(); context.add(entity);
  await expect(context.saveChanges()).rejects.toMatchObject({ committed: true });
  expect(entity.id).toBe(7); expect(context.stateOf(entity)).toBe(EntityState.Unchanged);
  expect(await context.saveChanges()).toBe(0);
  expect(statements.filter(sql => sql.startsWith("INSERT"))).toHaveLength(1);
});

test("A8: an uncertain external transaction does not suppress the owner's confirmed rollback hooks", async () => {
  const { provider, statements } = mockPostgres(sql => sql.startsWith("INSERT") ? [{ id: 7 }] : []);
  const context = ctx(provider, [Identity]); const entity = new Identity(); context.add(entity);
  let rolledBack = 0;
  await expect(provider.transaction(async () => {
    await context.saveChanges();
    provider.afterRollback(() => { rolledBack++; });
    throw new TransactionOutcomeUnknownError();
  })).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(rolledBack).toBe(1); expect(entity.id).toBe(0);
  expect(context.stateOf(entity)).toBe(EntityState.Added);
  expect(statements).toContain("ROLLBACK"); expect(statements).not.toContain("COMMIT");
  expect(await context.saveChanges()).toBe(1);
});

@Entity({ table: "audit_text_parent", migrate: true })
class TextParent { @Key({ generated: false }) @Column({ type: "text" }) id = ""; }
@Schema("must_not_be_created")
@Entity({ table: "audit_conflicting_fk", migrate: true })
@ForeignKey(() => UuidParent, { properties: ["parentId"] })
@ForeignKey(() => TextParent, { properties: ["parentId"] })
class ConflictingForeignKeys {
  @Key({ generated: false }) id = 1;
  @Column({ type: "text" }) parentId = "";
}
test("A3: incompatible physical FK types fail before any additive schema DDL", async () => {
  const models = [UuidParent, TextParent, ConflictingForeignKeys];
  expect(() => compileExpectedSchema(new OrmModel(models))).toThrow("ORM_SCHEMA_FOREIGN_KEY_TYPE_MISMATCH");
  const { provider, statements } = recording();
  await expect(ctx(provider, models).database.migrate()).rejects.toThrow("ORM_SCHEMA_FOREIGN_KEY_TYPE_MISMATCH");
  expect(statements).toHaveLength(0);
});
