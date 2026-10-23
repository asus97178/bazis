import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, ManyToOne, OneToMany, postgres, Required, Schema } from "../index";

// 0.117.1: migrate() (migrateOnStart, versioned CREATE TABLE) left the
// PostgreSQL default constraint names (items_pkey, items_listId_fkey) while
// ensureCreated expects pk_items and fk_items_listId; the foreign key name is
// checked exactly, so such a table could not move to ensureCreated.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

describe.skipIf(!url)("constraint names of tables created by migrate() (live)", () => {
  test("migrate() names keys like ensureCreated, so ensureCreated accepts the tables", async () => {
    schema = `bazis_names_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "lists" })
    class List { @Key() id = 0; @Required() @Column({ type: "text" }) name = ""; @OneToMany(() => Item, { foreignKey: "listId" }) items: Item[] = []; }
    @Schema(schema) @Entity({ table: "items" })
    class Item { @Key() id = 0; @Required() @Column({ type: "integer" }) listId = 0; @ManyToOne(() => List, { foreignKey: "listId" }) list?: List; }
    @Schema(schema) @Entity({ table: "tags" })
    class Tag { @Key({ generated: false }) @Column({ type: "text" }) code = ""; }
    class Db extends DbContext { readonly lists = this.set(List); readonly items = this.set(Item); readonly tags = this.set(Tag); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [List, Item, Tag] }));
    try {
      await provider.execute(`CREATE SCHEMA "${schema}"`, []);
      await db().database.migrate();
      const names = await provider.query(`SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 ORDER BY c.conname`, [schema]);
      expect(names.map((row) => row.conname)).toEqual(["fk_items_listId", "pk_items", "pk_lists", "pk_tags"]);
      const result = await db().database.ensureCreated();
      expect(result.warnings).toEqual([]);
    } finally { await provider.close(); }
  }, 30_000);
});
