import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, SchemaAdmissionError, type Migration, type PostgresProvider } from "../index";

// An application user with data rights only (SELECT/INSERT/UPDATE/DELETE),
// while the schema belongs to the owner. Found while writing the production
// checklist: such a user could not start with migrations at all.
const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const table = `ormru_${run}_notes`;
const role = `ormru_${run}_app`;
const password = `pw_${run}`;
const live = url === undefined ? test.skip : test;

@Entity({ table }) class Note { @Key() id = 0; @Column({ type: "text" }) text = ""; }
@Entity({ table }) class NoteWithTitle { @Key() id = 0; @Column({ type: "text" }) text = ""; @Column({ type: "text" }) title: string | null = null; }

const providers: PostgresProvider[] = [];
const connect = (credentials?: { user: string; password: string }) => {
  const target = new URL(url!);
  if (credentials) { target.username = credentials.user; target.password = credentials.password; }
  const provider = postgres({ url: target.toString() });
  providers.push(provider);
  return provider;
};
const database = (provider: PostgresProvider, entity: new () => object) =>
  new (class extends DbContext {})(new DbContextOptions({ provider, entities: [entity] })).database;
const migrations: Migration[] = [{ id: `${run}_01_comment`, up: async (db) => { await db.execute(`COMMENT ON TABLE "${table}" IS 'notes'`); } }];

afterAll(async () => {
  if (!url) return;
  const owner = connect();
  try {
    await owner.execute(`DROP TABLE IF EXISTS "${table}"`, []);
    await owner.execute(`DELETE FROM "__BazisMigrations" WHERE "MigrationId" LIKE $1`, [`${run}%`]);
    for (const provider of providers.slice(0, -1)) await provider.close();
    await owner.execute(`DROP OWNED BY "${role}"`, []).catch(() => undefined);
    await owner.execute(`DROP ROLE IF EXISTS "${role}"`, []);
  } finally { await owner.close(); }
});

describe("a database user with data rights only", () => {
  live("starts with ensureCreated and migrations once the owner applied them, and names the way out for a schema change", async () => {
    const owner = connect();
    expect((await database(owner, Note).ensureCreatedWithMigrations(migrations)).applied).toEqual([`create table ${table}`]);
    await owner.execute(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`, []);
    await owner.execute(`GRANT USAGE ON SCHEMA public TO "${role}"`, []);
    await owner.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}", "__BazisMigrations" TO "${role}"`, []);
    await owner.execute(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`, []);

    const app = connect({ user: role, password });
    // Before 0.98.30: PostgresError 42501 "permission denied for schema public"
    // from CREATE TABLE IF NOT EXISTS "__BazisMigrations".
    const again = await database(app, Note).ensureCreatedWithMigrations(migrations);
    expect([again.applied, again.migrated, again.baselined]).toEqual([[], [], []]);

    const error = await database(app, NoteWithTitle).ensureCreatedWithMigrations(migrations).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaAdmissionError);
    expect((error as Error).message).toBe(
      `PostgreSQL additive schema admission failed: add column ${table}.title failed with PostgreSQL 42501: must be owner of table ${table}. ` +
        "This database user may not change the schema: apply the change with the schema owner's credentials (BAZIS_SCHEMA_ONLY=1 applies the schema and exits), or grant the rights.",
    );
  });
});
