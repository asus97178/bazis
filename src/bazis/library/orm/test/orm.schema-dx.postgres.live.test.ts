import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Index, Key, postgres, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const items = `ormschdx_${run}_items`;
const tags = `ormschdx_${run}_tags`;
const prices = `ormschdx_${run}_prices`;
const live = url === undefined ? test.skip : test;

@Entity({ table: items })
class Item { @Key() id = 0; @Index({ unique: true }) @Column({ type: "text" }) code = ""; }
@Entity({ table: items })
class ItemWithNote { @Key() id = 0; @Index({ unique: true }) @Column({ type: "text" }) code = ""; @Column({ type: "text" }) note: string | null = null; }
@Entity({ table: tags })
class Tag { @Key() id = 0; @Column({ type: "text" }) tag = ""; }
@Entity({ table: tags })
class UniqueTag { @Key() id = 0; @Index({ unique: true }) @Column({ type: "text" }) tag = ""; }
@Entity({ table: prices })
class IntegerPrice { @Key() id = 0; @Column({ type: "integer" }) price = 0; }
@Entity({ table: prices })
class RealPrice { @Key() id = 0; @Column({ type: "real" }) price = 0; }

let shared: PostgresProvider | undefined;
const provider = () => shared ??= postgres({ url: url! });
const database = (entity: new () => object) => new (class extends DbContext {})(new DbContextOptions({ provider: provider(), entities: [entity] })).database;
const indexesOn = async (table: string) => (await provider().query("SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname", [table])).map((row) => row.indexname);

afterAll(async () => {
  if (!url) return;
  try { for (const table of [items, tags, prices]) await provider().execute(`DROP TABLE IF EXISTS "${table}"`, []); } finally { await shared?.close(); }
});

describe("schema management messages against a disposable PostgreSQL database", () => {
  live("ensureCreated reports the additive operations it applied", async () => {
    expect((await database(Item).ensureCreated()).applied).toEqual([`create table ${items}`, `create unique index ix_${items}_code on ${items} (code)`]);
    expect((await database(Item).ensureCreated()).applied).toEqual([]);
    expect((await database(ItemWithNote).ensureCreated()).applied).toEqual([`add column ${items}.note`]);
  });

  live("an index that differs only by name is reported and never duplicated", async () => {
    await provider().execute(`ALTER INDEX "ix_${items}_code" RENAME TO "legacy_${run}_code"`, []);
    const result = await database(ItemWithNote).ensureCreated();
    expect(result.applied).toEqual([]);
    expect(result.warnings).toEqual([`table "public"."${items}": index is named "legacy_${run}_code", the model expects "ix_${items}_code". It works as is; to align the name run: ALTER INDEX "public"."legacy_${run}_code" RENAME TO "ix_${items}_code";`]);
    const migrated = await database(ItemWithNote).migrate();
    expect(migrated.applied).toBe(0);
    expect(migrated.warnings).toEqual([`table "${items}": index "legacy_${run}_code" matches "ix_${items}_code" from the model except for its name (left untouched; to align it run: ALTER INDEX "legacy_${run}_code" RENAME TO "ix_${items}_code";).`]);
    expect(await indexesOn(items)).toEqual([`legacy_${run}_code`, `pk_${items}`]);
  });

  live("existing duplicates name the unique index ensureCreated could not create", async () => {
    await database(Tag).ensureCreated();
    await provider().execute(`INSERT INTO "${tags}" (tag) VALUES ('x'), ('x')`, []);
    const error = await database(UniqueTag).ensureCreated().catch((caught: unknown) => caught);
    expect((error as Error).message).toStartWith(`Existing PostgreSQL data violates the declared additive schema change: create unique index ix_${tags}_tag on ${tags} (tag) failed with PostgreSQL 23505: `);
    expect((error as Error).message).toEndWith("Fix the data, then start again.");
    expect((error as Error).message).not.toContain("(x)");
  });

  live("migrate warns about a changed column type", async () => {
    await database(IntegerPrice).ensureCreated();
    const result = await database(RealPrice).migrate();
    expect(result.warnings).toEqual([`table "${prices}": column "price" is integer in the database but real in the model (left untouched; change it with an explicit migration).`]);
  });

  live("a failed versioned migration names itself and is rolled back", async () => {
    const error = await database(RealPrice).migrateVersioned([{ id: `${run}_bad`, up: async (db) => { await db.execute(`ALTER TABLE "${prices}" ADD COLUMN note text`); await db.execute(`ALTER TABLE "nope_${run}" ADD COLUMN x int`); } }]).catch((caught: unknown) => caught);
    expect((error as Error).message).toStartWith(`Migration "${run}_bad" failed and was rolled back: PostgresError: relation "nope_${run}" does not exist`);
    const columns = await provider().query("SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [prices]);
    expect(columns.map((row) => row.column_name)).toEqual(["id", "price"]);
    await provider().execute(`DELETE FROM "__BazisMigrations" WHERE "MigrationId" = $1`, [`${run}_bad`]);
  });
});
