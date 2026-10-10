import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, OrmTransactionScopeError, postgres, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const tableName = `ormtxdx_${run}_accounts`;
const live = url === undefined ? test.skip : test;

@Entity({ table: tableName })
class Account { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "integer" }) balance = 0; }
class Db extends DbContext { readonly accounts = this.set(Account); }

const sql: string[] = [];
let shared: PostgresProvider | undefined;
const provider = () => shared ??= postgres({ url: url!, onSql: (text) => { sql.push(text); } });
const context = () => new Db(new DbContextOptions({ provider: provider(), entities: [Account], validateOnSave: false }));
const transactionCommands = () => sql.filter((text) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(text));

afterAll(async () => {
  if (!url) return;
  try { await provider().execute(`DROP TABLE IF EXISTS "${tableName}"`, []); } finally { await shared?.close(); }
});

describe("transaction scope diagnostics against a disposable PostgreSQL database", () => {
  live("onSql shows BEGIN with COMMIT or ROLLBACK", async () => {
    const db = context();
    await db.database.ensureCreated();
    sql.length = 0;
    await db.transactionScope(async () => { db.accounts.add(Object.assign(new Account(), { id: 1, balance: 10 })); await db.saveChanges(); });
    expect(transactionCommands()).toEqual(["BEGIN", "COMMIT"]);
    sql.length = 0;
    await expect(db.transactionScope(async () => { await db.database.executeSqlRaw(`UPDATE "${tableName}" SET balance = 0`); throw new Error("undo"); })).rejects.toThrow("undo");
    expect(transactionCommands()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(Number((await db.database.querySqlRaw(`SELECT balance FROM "${tableName}" WHERE id = 1`))[0]!.balance)).toBe(10);
  });

  live("a SQL timeout inside a scope reports the time budget", async () => {
    const db = context();
    const error = await db.transactionScope(async () => db.database.querySqlRaw("SELECT pg_sleep(3)"), { timeoutMs: 200 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrmTransactionScopeError);
    expect((error as Error).message).toContain("ORM transaction scope timed out after 200 ms");
    expect(await context().accounts.count()).toBe(1);
  }, 10_000);

  live("a caught SQL failure rolls the scope back with the database message", async () => {
    const db = context();
    const error = await db.transactionScope(async () => {
      await db.database.executeSqlRaw(`UPDATE "${tableName}" SET balance = 99`);
      try { await db.database.querySqlRaw("SELECT 1/0"); } catch { /* ignored on purpose */ }
      return "returned normally";
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("division by zero");
    expect(Number((await db.database.querySqlRaw(`SELECT balance FROM "${tableName}" WHERE id = 1`))[0]!.balance)).toBe(10);
  });

  live("forUpdate needs a transaction and works inside a scope", async () => {
    const db = context();
    await expect(db.accounts.findForUpdate(1)).rejects.toThrow("forUpdate() locks rows only until the surrounding transaction ends");
    const balance = await db.transactionScope(async () => (await db.accounts.findForUpdate(1))?.balance);
    expect(balance).toBe(10);
  });
});
