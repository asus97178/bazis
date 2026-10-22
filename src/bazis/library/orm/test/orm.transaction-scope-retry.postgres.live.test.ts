import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, OrmTransactionScopeError, postgres, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const tableName = `ormtxretry_${run}_accounts`;
const live = url === undefined ? test.skip : test;

@Entity({ table: tableName })
class Account { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "integer" }) balance = 0; }
class Db extends DbContext { readonly accounts = this.set(Account); }

let shared: PostgresProvider | undefined;
const provider = () => shared ??= postgres({ url: url! });
const context = () => new Db(new DbContextOptions({ provider: provider(), entities: [Account], validateOnSave: false, executionStrategy: { maxRetries: 3, baseDelayMs: 20 } }));

afterAll(async () => {
  if (!url) return;
  try { await provider().execute(`DROP TABLE IF EXISTS "${tableName}"`, []); } finally { await shared?.close(); }
});

beforeEach(async () => {
  if (!url) return;
  const db = context();
  await db.database.ensureCreated();
  await db.database.executeSqlRaw(`DELETE FROM "${tableName}"`);
  db.accounts.add(Object.assign(new Account(), { id: 1, balance: 100 }));
  db.accounts.add(Object.assign(new Account(), { id: 2, balance: 100 }));
  await db.saveChanges();
});

/** Locks `from`, waits, then locks `to`: two opposite transfers deadlock. */
function transfer(db: Db, from: number, to: number, amount: number, attempts: { count: number }, retry: boolean) {
  return db.transactionScope(async () => {
    attempts.count += 1;
    const source = (await db.accounts.findForUpdate(from))!;
    await Bun.sleep(300);
    const target = (await db.accounts.findForUpdate(to))!;
    source.balance -= amount;
    target.balance += amount;
    await db.saveChanges();
  }, { retry });
}

async function balances(): Promise<number[]> {
  const rows = await context().accounts.asNoTracking().orderBy((x) => x.id).toList();
  return rows.map((row) => row.balance);
}

describe("transactionScope({ retry }) against a disposable PostgreSQL database", () => {
  live("a deadlocked scope runs again from a clean context and applies its changes once", async () => {
    const first = { count: 0 }, second = { count: 0 };
    const results = await Promise.allSettled([transfer(context(), 1, 2, 10, first, true), transfer(context(), 2, 1, 1, second, true)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(first.count + second.count).toBe(3);
    expect(await balances()).toEqual([91, 109]);
  });

  live("an entity changed by the failed attempt is read again, not changed twice", async () => {
    const db = context();
    let attempts = 0;
    await db.transactionScope(async () => {
      attempts += 1;
      const account = (await db.accounts.find(1))!;
      account.balance -= 10;
      await db.saveChanges();
      if (attempts === 1) throw new Error("flaky");
    }, { retry: { maxRetries: 1, baseDelayMs: 1, isTransient: (error) => (error as Error).message === "flaky" } });
    expect(attempts).toBe(2);
    expect(await balances()).toEqual([90, 100]);
  });

  live("without retry the deadlocked scope fails", async () => {
    const results = await Promise.allSettled([transfer(context(), 1, 2, 10, { count: 0 }, false), transfer(context(), 2, 1, 1, { count: 0 }, false)]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason)).toContain("deadlock detected");
  });

  live("a non-transient failure is not retried", async () => {
    const db = context();
    let attempts = 0;
    await expect(db.transactionScope(async () => { attempts += 1; throw new Error("boom"); }, { retry: true })).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });

  live("retry is refused for a context that already tracks entities, and for a nested scope", async () => {
    const db = context();
    await db.accounts.find(1);
    await expect(db.transactionScope(async () => undefined, { retry: true })).rejects.toThrow(
      "transactionScope({ retry }) needs Db without tracked entities: every attempt starts from a clean context, and the 1 entity tracked before the scope would lose its changes. Start the scope before loading anything, or create a new scope for it.",
    );
    const fresh = context();
    await expect(fresh.transactionScope(() => fresh.transactionScope(async () => undefined, { retry: true }))).rejects.toBeInstanceOf(OrmTransactionScopeError);
    await expect(fresh.transactionScope(() => fresh.transactionScope(async () => undefined, { retry: true }))).rejects.toThrow("transactionScope({ retry }) must be the outermost scope");
  });

  live("a context joined with tx.use is cleared too, and must be clean when it joins", async () => {
    const other = { count: 0 };
    const db = context(), joined = context();
    const results = await Promise.allSettled([
      db.transactionScope((tx) => tx.use(joined, async () => {
        other.count += 1;
        const source = (await joined.accounts.findForUpdate(1))!;
        await Bun.sleep(300);
        const target = (await joined.accounts.findForUpdate(2))!;
        source.balance -= 10; target.balance += 10;
        await joined.saveChanges();
      }), { retry: true }),
      transfer(context(), 2, 1, 1, { count: 0 }, true),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await balances()).toEqual([91, 109]);

    const dirty = context();
    await dirty.accounts.find(1);
    await expect(context().transactionScope((tx) => tx.use(dirty, async () => undefined), { retry: true })).rejects.toThrow("needs Db without tracked entities");
  });
});
