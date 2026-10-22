import { expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, ManyToOne, OneToMany, QueryFilter, SoftDelete, type DatabaseProvider, type Row, type SqlDialect } from "../index";

// 0.114.0: ignoreQueryFilters() turned the filters off for the main query only;
// included entities were still read with @QueryFilter and the soft-delete
// condition, so soft-deleted children stayed hidden.
const dialect: SqlDialect = { name: "postgres", supportsReturning: false, quoteId: (name) => `"${name}"`, qualifyTable: (model) => `"${model.tableName}"`, parameter: (index) => `$${index + 1}`, columnType: () => "text", encode: (value) => value as never, decode: (value) => value, rowLockClause: () => "", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "" };
const log: string[] = [];
let rows: Row[] = [];
const provider = { name: "test", dialect, query: async (sql: string) => { log.push(sql); return rows; }, execute: async (sql: string) => { log.push(sql); return { changes: 1, lastInsertId: 0 }; }, transaction: async <T>(work: (tx: never) => Promise<T>) => work({} as never), ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {} } as unknown as DatabaseProvider;

@Entity({ table: "lists" })
@QueryFilter<List, ListsDb>((l, db) => l.tenantId.eq(db.tenant()))
class List {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "text" }) tenantId = "";
  @SoftDelete() deletedAt: Date | null = null;
  @OneToMany(() => Item, { foreignKey: "listId" }) items: Item[] = [];
}
@Entity({ table: "items" })
@QueryFilter<Item>((i) => i.archived.eq(false))
class Item {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "integer" }) listId = 0;
  @Column({ type: "boolean" }) archived = false;
  @SoftDelete() deletedAt: Date | null = null;
  @ManyToOne(() => List, { foreignKey: "listId" }) list?: List;
}
class ListsDb extends DbContext {
  readonly lists = this.set(List);
  readonly items = this.set(Item);
  constructor(options: DbContextOptions, private readonly tenantId?: string) { super(options); }
  tenant(): string { if (this.tenantId === undefined) throw new Error("no tenant for this request"); return this.tenantId; }
}
const options = new DbContextOptions({ provider, entities: [List, Item], validateOnSave: false });
const sqlOf = async (work: () => Promise<unknown>) => { log.length = 0; await work(); return [...log]; };

test("ignoreQueryFilters() also turns the filters off for included collections", async () => {
  rows = [{ id: 1, listId: 1 }];
  const sql = await sqlOf(() => new ListsDb(options).lists.ignoreQueryFilters().include((l) => l.items).toList());
  rows = [];
  expect(sql).toEqual([
    'SELECT "id", "tenantId", "deletedAt" FROM "lists"',
    'SELECT "id", "listId", "archived", "deletedAt" FROM "items" WHERE "listId" IN ($1)',
  ]);
});

test("ignoreQueryFilters() also turns the filters off for included references", async () => {
  rows = [{ id: 1, listId: 1 }];
  const sql = await sqlOf(() => new ListsDb(options).items.ignoreQueryFilters().include((i) => i.list).toList());
  rows = [];
  // The list's context filter needs a tenant; without ignoreQueryFilters it would fail.
  expect(sql[1]).toBe('SELECT "id", "tenantId", "deletedAt" FROM "lists" WHERE "id" IN ($1)');
});

test("without ignoreQueryFilters() included entities keep their filters", async () => {
  rows = [{ id: 1, listId: 1 }];
  const sql = await sqlOf(() => new ListsDb(options, "acme").lists.include((l) => l.items).toList());
  rows = [];
  expect(sql[1]).toBe('SELECT "id", "listId", "archived", "deletedAt" FROM "items" WHERE "archived" = $1 AND "deletedAt" IS NULL AND "listId" IN ($2)');
});
