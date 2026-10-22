import { afterAll, expect, test } from "bun:test";
import { DbContext, DbContextOptions, OrmError, postgres, type Migration, type PostgresProvider } from "../index";

// 0.112.0: rolling back an applied migration that is missing from the passed
// list said "has no down() method" (a plain Error), as if the migration were
// in the list without down().
const url = process.env.BAZIS_PG_URL;
const live = url === undefined ? test.skip : test;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
class Db extends DbContext {}

let shared: PostgresProvider | undefined;
const provider = () => shared ??= postgres({ url: url! });
const db = () => new Db(new DbContextOptions({ provider: provider(), entities: [] }));

const withDown: Migration = { id: `${run}_01_with_down`, up: async () => {}, down: async () => {} };
const withoutDown: Migration = { id: `${run}_02_without_down`, up: async () => {} };

afterAll(async () => {
  if (!url) return;
  try { await provider().execute(`DELETE FROM "__BazisMigrations" WHERE "MigrationId" LIKE '${run}%'`, []); } finally { await shared?.close(); }
});

live("rollback names a migration missing from the list and one without down()", async () => {
  await db().database.migrateVersioned([withDown, withoutDown]);

  const missing = await db().database.rollbackVersioned([withDown]).then(() => undefined, (error: unknown) => error);
  expect(missing).toBeInstanceOf(OrmError);
  expect((missing as Error).message).toBe(
    `Migration "${withoutDown.id}" is applied but is not in the migrations passed to rollbackVersioned(); pass the full list.`,
  );

  const noDown = await db().database.rollbackVersioned([withDown, withoutDown]).then(() => undefined, (error: unknown) => error);
  expect(noDown).toBeInstanceOf(OrmError);
  expect((noDown as Error).message).toBe(`Migration "${withoutDown.id}" has no down() method.`);
});
