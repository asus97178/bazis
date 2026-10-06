import { afterAll, beforeAll, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Index, Key, TransactionOutcomeUnknownError, UniqueViolationError, postgres, type PostgresProvider } from "../index";

// SaveChanges against a real unique index: needs BAZIS_PG_URL, otherwise skipped.
const url = process.env.BAZIS_PG_URL;
const live = url === undefined ? test.skip : test;
const table = `ormuv_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const quoted = () => {
  if (!/^ormuv_[a-f0-9]{16}$/.test(table)) throw new Error("foreign cleanup rejected");
  return `"${table}"`;
};

@Entity({ table })
@Index(["code"], { unique: true, name: `${table}_code_key` })
class Row {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Column() code = "";
  @Column({ type: "integer" }) amount = 0;
}

class Context extends DbContext {
  readonly rows = this.set(Row);
  constructor(provider: PostgresProvider) {
    super(new DbContextOptions({ provider, entities: [Row], validateOnSave: false }));
  }
}

const row = (id: number, code: string, amount = 1) => Object.assign(new Row(), { id, code, amount });
let provider: PostgresProvider;

beforeAll(async () => {
  if (!url) return;
  provider = postgres({ url });
  await provider.execute(`DROP TABLE IF EXISTS ${quoted()}`, []);
  await provider.execute(`CREATE TABLE ${quoted()} (id integer PRIMARY KEY, code text NOT NULL, amount integer NOT NULL CHECK (amount > 0), CONSTRAINT "${table}_code_key" UNIQUE (code))`, []);
});

afterAll(async () => {
  if (!url) return;
  await provider.execute(`DROP TABLE IF EXISTS ${quoted()}`, []);
  await provider.close();
});

live("duplicate unique value rejects SaveChanges with UniqueViolationError and saves nothing", async () => {
  const db = new Context(provider);
  db.rows.add(row(1, "same"));
  await db.saveChanges();

  const second = new Context(provider);
  second.rows.add(row(2, "same"));
  second.rows.add(row(3, "other"));
  const error = await second.saveChanges().then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(UniqueViolationError);
  expect((error as UniqueViolationError).constraint).toBe(`${table}_code_key`);
  expect((error as UniqueViolationError).table).toBe(table);
  expect((error as UniqueViolationError).cause).toBeInstanceOf(Error);
  expect((await provider.query(`SELECT id FROM ${quoted()} ORDER BY id`, [])).map((value) => value.id)).toEqual([1]);
});

live("inside a transaction scope the violation is a known rejection, not an unknown outcome", async () => {
  const db = new Context(provider);
  const error = await db.transactionScope(async () => {
    db.rows.add(row(10, "same"));
    await db.saveChanges();
  }).then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(UniqueViolationError);
  expect(error).not.toBeInstanceOf(TransactionOutcomeUnknownError);
  expect(await provider.query(`SELECT id FROM ${quoted()} WHERE id = 10`, [])).toEqual([]);
});

live("other constraint errors keep the driver error", async () => {
  const db = new Context(provider);
  db.rows.add(row(20, "check", 0));
  const error = await db.saveChanges().then(() => undefined, (failure: unknown) => failure);
  expect(error).not.toBeInstanceOf(UniqueViolationError);
  expect((error as { errno?: unknown }).errno).toBe("23514");
});
