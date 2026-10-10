import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, type Migration, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const fresh = `ormecm_${run}_fresh`;
const existing = `ormecm_${run}_existing`;
const racing = `ormecm_${run}_racing`;
const broken = `ormecm_${run}_broken`;
const live = url === undefined ? test.skip : test;

@Entity({ table: fresh }) class FreshPrice { @Key() id = 0; @Column({ type: "real" }) price = 0; }
@Entity({ table: existing }) class OldPrice { @Key() id = 0; @Column({ type: "integer" }) price = 0; }
@Entity({ table: existing }) class NewPrice { @Key() id = 0; @Column({ type: "real" }) price = 0; @Column({ type: "text" }) note: string | null = null; }
@Entity({ table: racing }) class RacingPrice { @Key() id = 0; @Column({ type: "real" }) price = 0; }
@Entity({ table: broken }) class BrokenOld { @Key() id = 0; @Column({ type: "integer" }) price = 0; }
@Entity({ table: broken }) class BrokenNew { @Key() id = 0; @Column({ type: "real" }) price = 0; }

let shared: PostgresProvider | undefined;
const provider = () => shared ??= postgres({ url: url! });
const database = (entity: new () => object) => new (class extends DbContext {})(new DbContextOptions({ provider: provider(), entities: [entity] })).database;
const alterPrice = (table: string, id: string): Migration => ({ id, up: async (db) => { await db.execute(`ALTER TABLE "${table}" ALTER COLUMN price TYPE double precision`); } });
const history = async (prefix: string) => (await provider().query(`SELECT "MigrationId" AS id FROM "__BazisMigrations" WHERE "MigrationId" LIKE $1 ORDER BY 1`, [`${prefix}%`])).map((row) => row.id);
const columnType = async (table: string) => (await provider().query("SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'price'", [table]))[0]?.data_type;

afterAll(async () => {
  if (!url) return;
  try {
    for (const table of [fresh, existing, racing, broken]) await provider().execute(`DROP TABLE IF EXISTS "${table}"`, []);
    await provider().execute(`DELETE FROM "__BazisMigrations" WHERE "MigrationId" LIKE $1`, [`${run}%`]);
  } finally { await shared?.close(); }
});

describe("ensureCreated with versioned migrations against a disposable PostgreSQL database", () => {
  live("an empty database is created from the model and the migrations are only recorded", async () => {
    const result = await database(FreshPrice).ensureCreatedWithMigrations([alterPrice(fresh, `${run}_fresh_01`)]);
    expect(result.applied).toEqual([`create table ${fresh}`]);
    expect(result.migrated).toEqual([]);
    expect(result.baselined).toEqual([`${run}_fresh_01`]);
    expect(await history(`${run}_fresh`)).toEqual([`${run}_fresh_01`]);
    expect(await columnType(fresh)).toBe("double precision");
  });

  live("an existing database runs pending migrations first, then ensureCreated adds the rest and verifies", async () => {
    await database(OldPrice).ensureCreated();
    await expect(database(NewPrice).ensureCreated()).rejects.toThrow("PostgreSQL schema change requires an explicit migration.");
    const migrations = [alterPrice(existing, `${run}_existing_01`)];
    const result = await database(NewPrice).ensureCreatedWithMigrations(migrations);
    expect(result.migrated).toEqual([`${run}_existing_01`]);
    expect(result.baselined).toEqual([]);
    expect(result.applied).toEqual([`add column ${existing}.note`]);
    expect(await columnType(existing)).toBe("double precision");
    const again = await database(NewPrice).ensureCreatedWithMigrations(migrations);
    expect([again.migrated, again.baselined, again.applied]).toEqual([[], [], []]);
  });

  live("starting instances on an empty database create and record once", async () => {
    const migrations = [alterPrice(racing, `${run}_racing_01`)];
    const results = await Promise.all([0, 1, 2].map(() => new (class extends DbContext {})(new DbContextOptions({ provider: postgres({ url: url! }), entities: [RacingPrice] })).database.ensureCreatedWithMigrations(migrations)));
    expect(results.flatMap((result) => result.baselined)).toEqual([`${run}_racing_01`]);
    expect(results.flatMap((result) => result.migrated)).toEqual([]);
    expect(await history(`${run}_racing`)).toEqual([`${run}_racing_01`]);
  }, 20_000);

  live("a failed migration stops before the schema check and names itself", async () => {
    await database(BrokenOld).ensureCreated();
    const error = await database(BrokenNew).ensureCreatedWithMigrations([{ id: `${run}_broken_01`, up: async (db) => { await db.execute(`ALTER TABLE "${broken}" ALTER COLUMN price TYPE double precision`); await db.execute(`SELECT * FROM "nope_${run}"`); } }]).catch((caught: unknown) => caught);
    expect((error as Error).message).toStartWith(`Migration "${run}_broken_01" failed and was rolled back: PostgresError: relation "nope_${run}" does not exist`);
    expect(await columnType(broken)).toBe("bigint");
    expect(await history(`${run}_broken`)).toEqual([]);
  });
});
