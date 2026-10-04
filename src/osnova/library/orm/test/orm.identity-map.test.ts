import { expect, test } from "bun:test";
import {
  Column, DbContext, DbContextOptions, DbUpdateError, Entity, EntityState, Key,
  PostCommitError, PostgresDialect, PostgresProvider, type DatabaseProvider, type Row, type SqlParam,
} from "../index";

@Entity({ table: "identity_manual" })
class Manual {
  @Key({ generated: false }) id = 0;
  @Column({ type: "text" }) name = "initial";
}
@Entity({ table: "identity_generated" })
class Generated {
  @Key() id = 0;
  @Column({ type: "text" }) name = "initial";
}
@Entity({ table: "identity_composite" })
class Composite {
  @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = "tenant";
  @Column({ type: "integer" }) id = 0;
  @Column({ type: "text" }) name = "initial";
}
class Context extends DbContext {
  readonly manual = this.set(Manual);
  readonly generated = this.set(Generated);
  readonly composite = this.set(Composite);
}

function fixture(callbacks = false) {
  const statements: Array<{ sql: string; params: readonly SqlParam[] }> = [];
  let rows: Row[] = [{ id: 1, name: "initial" }];
  let returned: Row[] = [{ id: 11 }, { id: 12 }];
  function read(sql: string, params: readonly SqlParam[] = []): Row[] {
    statements.push({ sql, params });
    return sql.startsWith("INSERT") ? returned : sql.startsWith("SELECT") ? rows : [];
  }
  let provider: DatabaseProvider;
  if (callbacks) {
    const postgres = new PostgresProvider({ options: {} });
    const session = {
      async unsafe(sql: string, params: readonly SqlParam[] = []) { return Object.assign(read(sql, params), { count: 1 }); },
      async release() {}, async close() {},
    };
    Object.defineProperty(postgres, "sql", { configurable: true, value: {
      async reserve() { return session; }, async close() {},
      async unsafe() { throw new Error("Root SQL is forbidden in this offline fixture."); },
    } });
    provider = postgres;
  } else {
    provider = {
      name: "identity-recording", dialect: new PostgresDialect(),
      async query(sql, params) { return read(sql, params); },
      async execute(sql, params) { read(sql, params); return { changes: 1, lastInsertId: 0 }; },
      async transaction(work) {
        read("BEGIN");
        try { const result = await work(provider); read("COMMIT"); return result; }
        catch (error) { read("ROLLBACK"); throw error; }
      },
      async introspect() { return { tables: new Map() }; }, async ping() { return true; }, async close() {},
    };
  }
  const db = new Context(new DbContextOptions({ provider, entities: [Manual, Generated, Composite], validateOnSave: false }));
  return { db, provider, statements, setRows(value: Row[]) { rows = value; }, setReturned(value: Row[]) { returned = value; } };
}

for (const operation of ["attach", "update", "remove", "add"] as const) {
  test(`a conflicting ${operation} leaves the canonical instance and tracker unchanged`, async () => {
    const { db, statements } = fixture();
    const first = (await db.manual.find(1))!;
    const duplicate = Object.assign(new Manual(), { id: 1, name: "replacement" });
    expect(() => db.manual[operation](duplicate)).toThrow(DbUpdateError);
    expect(db.stateOf(duplicate)).toBe(EntityState.Detached);
    expect(db.stateOf(first)).toBe(EntityState.Unchanged);
    expect(await db.manual.find(1)).toBe(first);
    first.name = "one update";
    expect(await db.saveChanges()).toBe(1);
    expect(statements.filter(item => item.sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(statements.find(item => item.sql.startsWith("UPDATE"))!.params).toEqual(["one update", 1]);
    expect(await db.saveChanges()).toBe(0);
  });
}

test("reusing the canonical object remains valid and detached unique update still works", async () => {
  const { db, statements } = fixture();
  const record = Object.assign(new Manual(), { id: 1, name: "detached" });
  db.manual.update(record);
  expect(await db.saveChanges()).toBe(1);
  expect(await db.manual.find(1)).toBe(record);
  db.manual.attach(record);
  db.manual.update(record);
  expect(await db.saveChanges()).toBe(1);
  expect(statements.filter(item => item.sql.startsWith("UPDATE"))).toHaveLength(2);
});

test("manual Added keys can be assigned after add and duplicate final keys reject before SQL", async () => {
  const { db, statements } = fixture();
  const first = new Manual(); const second = new Manual();
  db.manual.addRange([first, second]);
  first.id = 21; second.id = 21;
  await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
  expect(statements).toEqual([]);
  expect(db.stateOf(first)).toBe(EntityState.Added);
  expect(db.stateOf(second)).toBe(EntityState.Added);
  second.id = 22;
  expect(await db.saveChanges()).toBe(2);
  expect(statements.filter(item => item.sql.startsWith("INSERT"))).toHaveLength(1);
});

test("manual Added cannot collide with a later attach and recovery has no orphan entries", async () => {
  const { db, statements } = fixture();
  const added = Object.assign(new Manual(), { id: 1 }); db.manual.add(added);
  const attached = Object.assign(new Manual(), { id: 1 }); db.manual.attach(attached);
  await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
  expect(statements).toEqual([]);
  added.id = 2;
  expect(await db.saveChanges()).toBe(1);
  expect(await db.manual.find(1)).toBe(attached);
});

test("composite keys reject duplicates without mixing identities of different models", async () => {
  const { db, statements } = fixture();
  const first = Object.assign(new Composite(), { id: 1 }); db.composite.attach(first);
  expect(() => db.composite.attach(Object.assign(new Composite(), { id: 1 }))).toThrow(DbUpdateError);
  db.manual.attach(Object.assign(new Manual(), { id: 1 }));
  db.composite.addRange([Object.assign(new Composite(), { id: 2 }), Object.assign(new Composite(), { id: 2 })]);
  await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
  expect(statements).toEqual([]);
});

for (const callbacks of [false, true]) {
  test(`generated zero placeholders remain independent (callbacks=${callbacks})`, async () => {
    const { db, provider, setRows } = fixture(callbacks);
    const first = new Generated(); const second = new Generated();
    db.generated.addRange([first, second]);
    expect(await db.saveChanges()).toBe(2);
    expect([first.id, second.id]).toEqual([11, 12]);
    setRows([{ id: 11, name: "stored" }]); expect(await db.generated.find(11)).toBe(first);
    setRows([{ id: 12, name: "stored" }]); expect(await db.generated.find(12)).toBe(second);
    await provider.close();
  });

  test(`all RETURNING keys are checked before commit or partial acceptance (callbacks=${callbacks})`, async () => {
    const { db, provider, statements, setReturned } = fixture(callbacks);
    const first = new Generated(); const second = new Generated();
    db.generated.addRange([first, second]); setReturned([{ id: 11 }, { id: 11 }]);
    await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
    expect([first.id, second.id]).toEqual([0, 0]);
    expect([db.stateOf(first), db.stateOf(second)]).toEqual([EntityState.Added, EntityState.Added]);
    expect(statements.some(item => item.sql === "ROLLBACK")).toBe(true);
    expect(statements.some(item => item.sql === "COMMIT")).toBe(false);
    setReturned([{ id: 21 }, { id: 22 }]); expect(await db.saveChanges()).toBe(2);
    expect([first.id, second.id]).toEqual([21, 22]);
    await provider.close();
  });

  test(`RETURNING cannot replace a loaded instance (callbacks=${callbacks})`, async () => {
    const { db, provider, statements, setReturned } = fixture(callbacks);
    const original = (await db.generated.find(1))!;
    const added = new Generated(); db.generated.add(added); setReturned([{ id: 1 }]);
    await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
    expect(added.id).toBe(0); expect(db.stateOf(added)).toBe(EntityState.Added);
    expect(db.stateOf(original)).toBe(EntityState.Unchanged);
    expect(await db.generated.find(1)).toBe(original);
    expect(statements.some(item => item.sql === "COMMIT")).toBe(false);
    db.generated.remove(added);
    original.name = "retained"; expect(await db.saveChanges()).toBe(1);
    await provider.close();
  });
}

test("outer rollback restores manual Added and Deleted identities", async () => {
  const { db, provider } = fixture(true);
  const added = Object.assign(new Manual(), { id: 2 }); db.manual.add(added);
  await expect(db.database.transaction(async () => { await db.saveChanges(); throw new Error("rollback insert"); })).rejects.toThrow("rollback insert");
  expect(db.stateOf(added)).toBe(EntityState.Added);
  expect(await db.saveChanges()).toBe(1);
  const original = (await db.manual.find(1))!; db.manual.remove(original);
  await expect(db.database.transaction(async () => { await db.saveChanges(); throw new Error("rollback delete"); })).rejects.toThrow("rollback delete");
  expect(db.stateOf(original)).toBe(EntityState.Deleted);
  expect(() => db.manual.attach(Object.assign(new Manual(), { id: 1 }))).toThrow(DbUpdateError);
  expect(await db.saveChanges()).toBe(1);
  await provider.close();
});

test("a provisional delete reserves its identity until outer rollback finishes", async () => {
  const { db, provider } = fixture(true);
  const original = (await db.manual.find(1))!;
  const replacement = Object.assign(new Manual(), { id: 1, name: "replacement" });
  await expect(db.database.transaction(async () => {
    db.manual.remove(original); await db.saveChanges();
    expect(() => db.manual.attach(replacement)).toThrow(DbUpdateError);
    expect(db.stateOf(replacement)).toBe(EntityState.Detached);
    throw new Error("rollback provisional delete");
  })).rejects.toThrow("rollback provisional delete");
  expect(db.stateOf(original)).toBe(EntityState.Deleted);
  db.manual.attach(original);
  expect(await db.manual.find(1)).toBe(original);
  await provider.close();
});

test("a committed delete releases its identity for another object", async () => {
  const { db, provider } = fixture(true);
  const original = (await db.manual.find(1))!;
  const replacement = Object.assign(new Manual(), { id: 1, name: "replacement" });
  await db.database.transaction(async () => {
    db.manual.remove(original); await db.saveChanges();
    expect(() => db.manual.add(replacement)).toThrow(DbUpdateError);
    expect(db.stateOf(replacement)).toBe(EntityState.Detached);
  });
  db.manual.add(replacement);
  expect(await db.saveChanges()).toBe(1);
  expect(db.stateOf(original)).toBe(EntityState.Detached);
  expect(await db.manual.find(1)).toBe(replacement);
  await provider.close();
});

test("a committed callback-less provider failure also releases a deleted identity", async () => {
  const { db, provider } = fixture();
  const original = (await db.manual.find(1))!;
  const transaction = provider.transaction.bind(provider);
  provider.transaction = async (work) => {
    await transaction(work);
    throw new PostCommitError([new Error("after commit")]);
  };
  db.manual.remove(original);
  await expect(db.saveChanges()).rejects.toBeInstanceOf(PostCommitError);
  const replacement = Object.assign(new Manual(), { id: 1 });
  db.manual.attach(replacement);
  expect(db.stateOf(original)).toBe(EntityState.Detached);
  expect(await db.manual.find(1)).toBe(replacement);
});

test("delete identities release before user afterCommit callbacks in their original order", async () => {
  const { db, provider, statements, setRows } = fixture(true);
  const first = (await db.manual.find(1))!;
  const second = Object.assign(new Manual(), { id: 2 }); db.manual.attach(second);
  const replacements = [1, 2].map(id => Object.assign(new Manual(), { id, name: "replacement" }));
  const calls: number[] = [];
  await expect(db.database.transaction(async () => {
    provider.afterCommit!(() => {
      expect(statements.some(item => item.sql === "COMMIT")).toBe(true);
      db.manual.attach(replacements[0]!); db.manual.attach(replacements[1]!);
      calls.push(1);
      throw new Error("first public callback failed");
    });
    db.manual.remove(first); await db.saveChanges();
    provider.afterCommit!(() => { calls.push(2); });
    db.manual.remove(second); await db.saveChanges();
    provider.afterCommit!(() => { calls.push(3); });
  })).rejects.toBeInstanceOf(PostCommitError);
  expect(calls).toEqual([1, 2, 3]);
  expect(await db.manual.find(1)).toBe(replacements[0]!);
  setRows([{ id: 2, name: "stored" }]);
  expect(await db.manual.find(2)).toBe(replacements[1]!);
  await provider.close();
});

for (const rollback of [false, true]) {
  test(`delete and reinsert the canonical object stays valid (rollback=${rollback})`, async () => {
    const { db, provider } = fixture(true);
    const original = (await db.manual.find(1))!;
    const work = db.database.transaction(async () => {
      db.manual.remove(original); expect(await db.saveChanges()).toBe(1);
      original.name = "reinserted";
      db.manual.add(original); expect(await db.saveChanges()).toBe(1);
      if (rollback) throw new Error("rollback reinsert");
    });
    if (rollback) await expect(work).rejects.toThrow("rollback reinsert"); else await work;
    expect(await db.manual.find(1)).toBe(original);
    expect(db.stateOf(original)).toBe(rollback ? EntityState.Modified : EntityState.Unchanged);
    expect(await db.saveChanges()).toBe(rollback ? 1 : 0);
    await provider.close();
  });
}
