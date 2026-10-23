import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, EntityState, Key, OrmError, postgres, Required, Schema } from "../index";

// 0.116.0: after a rolled-back scope the tracker keeps the changes (so the
// work can be retried). The guide advised remove() to drop them, which turns a
// Modified entity into a DELETE. detach(entity) stops tracking one entity.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

async function setup() {
  schema = `bazis_detach_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
  @Schema(schema) @Entity({ table: "accounts" })
  class Account { @Key() id = 0; @Required() @Column({ type: "text" }) name = ""; @Required() @Column({ type: "integer" }) balance = 0; }
  class Db extends DbContext { readonly accounts = this.set(Account); }
  const provider = postgres({ url: url! });
  const db = () => new Db(new DbContextOptions({ provider, entities: [Account] }));
  await db().database.ensureCreated();
  const seed = db();
  seed.accounts.add(Object.assign(new Account(), { name: "bob", balance: 100 }));
  await seed.saveChanges();
  return { provider, db, balance: async () => (await db().accounts.find(1))!.balance, rows: () => db().accounts.count() };
}

describe.skipIf(!url)("DbContext.detach (live)", () => {
  test("after a rollback detach() drops the kept change of one entity", async () => {
    const { provider, db, balance } = await setup();
    try {
      const ctx = db();
      await ctx.transactionScope(async () => {
        const bob = await ctx.accounts.find(1);
        bob!.balance += 1000;
        await ctx.saveChanges();
        throw new Error("x");
      }).catch(() => {});
      const bob = (await ctx.accounts.find(1))!;
      expect(ctx.stateOf(bob)).toBe(EntityState.Modified);
      ctx.detach(bob);
      expect(ctx.stateOf(bob)).toBe(EntityState.Detached);
      expect(await ctx.saveChanges()).toBe(0);
      expect(await balance()).toBe(100);
      // A fresh read is tracked again with the database values.
      const again = (await ctx.accounts.find(1))!;
      expect(again).not.toBe(bob);
      expect(again.balance).toBe(100);
    } finally { await provider.close(); }
  }, 30_000);

  test("a caught nested rollback: detach() keeps the row, remove() would delete it", async () => {
    const { provider, db, balance, rows } = await setup();
    try {
      const ctx = db();
      await ctx.transactionScope(async () => {
        try {
          await ctx.transactionScope(async () => {
            const bob = await ctx.accounts.find(1);
            bob!.balance = 5;
            await ctx.saveChanges();
            throw new Error("inner");
          });
        } catch {
          ctx.detach((await ctx.accounts.find(1))!);
        }
        expect(await ctx.saveChanges()).toBe(0);
      });
      expect(await rows()).toBe(1);
      expect(await balance()).toBe(100);
    } finally { await provider.close(); }
  }, 30_000);

  test("an entity saved in a scope that is still open cannot be detached", async () => {
    const { provider, db, balance } = await setup();
    try {
      const ctx = db();
      await ctx.transactionScope(async () => {
        const bob = (await ctx.accounts.find(1))!;
        bob.balance = 7;
        await ctx.saveChanges();
        expect(() => ctx.detach(bob)).toThrow(OrmError);
        expect(() => ctx.detach(bob)).toThrow("Account was saved in a transaction scope that is still open; detach it after the scope ends.");
      });
      expect(await balance()).toBe(7);
    } finally { await provider.close(); }
  }, 30_000);

  test("detach() of an untracked entity does nothing; a detached entity can be attached again", async () => {
    const { provider, db, balance } = await setup();
    try {
      const ctx = db();
      const bob = (await ctx.accounts.find(1))!;
      ctx.detach(bob);
      ctx.detach(bob);
      ctx.accounts.update(Object.assign(bob, { balance: 42 }));
      expect(await ctx.saveChanges()).toBe(1);
      expect(await balance()).toBe(42);
    } finally { await provider.close(); }
  }, 30_000);
});
