import { expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, ManyToOne, OneToMany, QueryFilter, type DatabaseProvider, type Row, type SqlDialect, Nullable } from "../index";

const dialect: SqlDialect = { name: "postgres", supportsReturning: false, quoteId: (name) => `"${name}"`, qualifyTable: (model) => `"${model.tableName}"`, parameter: (index) => `$${index + 1}`, columnType: () => "text", encode: (value) => value as never, decode: (value) => value, rowLockClause: () => "", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "" };
const log: { sql: string; params: readonly unknown[] }[] = [];
let rows: Row[] = [];
const provider = { name: "test", dialect, query: async (sql: string, params: readonly unknown[]) => { log.push({ sql, params }); return rows; }, execute: async (sql: string, params: readonly unknown[]) => { log.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; }, transaction: async <T>(work: (tx: never) => Promise<T>) => work({} as never), ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {} } as unknown as DatabaseProvider;

@Entity({ table: "owners" })
class Owner { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @OneToMany(() => Note, { foreignKey: "ownerId" }) notes: Note[] = []; }
@Entity({ table: "notes" })
@QueryFilter<Note, NotesDb>((n, db) => n.tenantId.eq(db.tenant()))
@QueryFilter<Note>((n) => n.archived.eq(false))
class Note { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Nullable() @Column({ type: "text" }) tenantId = ""; @Nullable() @Column({ type: "boolean" }) archived = false; @Nullable() @Column({ type: "integer" }) ownerId = 0; @ManyToOne(() => Owner, { foreignKey: "ownerId" }) owner?: Owner; }
class NotesDb extends DbContext {
  readonly notes = this.set(Note);
  readonly owners = this.set(Owner);
  constructor(options: DbContextOptions, private readonly tenantId?: string) { super(options); }
  tenant(): string { if (this.tenantId === undefined) throw new Error("no tenant for this request"); return this.tenantId; }
}
const options = new DbContextOptions({ provider, entities: [Note, Owner], validateOnSave: false });
const sqlOf = async (work: () => Promise<unknown>) => { log.length = 0; await work(); return log.map((entry) => [entry.sql, entry.params]); };

test("a filter with the context reads the value of each context at query time", async () => {
  expect(await sqlOf(() => new NotesDb(options, "acme").notes.toList())).toEqual([['SELECT "id", "tenantId", "archived", "ownerId" FROM "notes" WHERE "archived" = $1 AND "tenantId" = $2', [false, "acme"]]]);
  expect((await sqlOf(() => new NotesDb(options, "globex").notes.count()))[0]![1]).toEqual([false, "globex"]);
  expect((await sqlOf(() => new NotesDb(options, "acme").notes.find(7)))[0]![0]).toContain('"tenantId" = $');
  expect(await sqlOf(() => new NotesDb(options, "acme").notes.ignoreQueryFilters().toList())).toEqual([['SELECT "id", "tenantId", "archived", "ownerId" FROM "notes"', []]]);
});

test("the filter applies to included collections and immediate mutations", async () => {
  rows = [{ id: 1 }];
  const included = await sqlOf(() => new NotesDb(options, "acme").owners.include((o) => o.notes).toList());
  rows = [];
  expect(included[1]![0]).toContain('"tenantId" = $');
  expect(included[1]![1]).toContain("acme");
  const deleted = await sqlOf(() => new NotesDb(options, "acme").notes.asNoTracking().where((n) => n.id.gt(0)).executeDelete());
  expect(deleted[0]![0]).toContain('"tenantId" = $');
  expect(deleted[0]![1]).toContain("acme");
});

test("a filter that cannot get its value fails the query instead of running without it", async () => {
  log.length = 0;
  await expect(new NotesDb(options).notes.toList()).rejects.toThrow("no tenant for this request");
  await expect(new NotesDb(options).notes.asNoTracking().where((n) => n.id.gt(0)).executeDelete()).rejects.toThrow("no tenant for this request");
  expect(log).toEqual([]);
});
