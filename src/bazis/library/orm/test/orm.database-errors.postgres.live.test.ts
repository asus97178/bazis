import { afterAll, describe, expect, test } from "bun:test";
import { Check, CheckViolationError, Column, DbContext, DbContextOptions, Entity, ForeignKeyViolationError, Key, LockTimeoutError, ManyToOne, NotNullViolationError, postgres, Required, TransactionOutcomeUnknownError, UniqueViolationError, Index, type PostgresProvider, Nullable } from "../index";

const url = process.env.BAZIS_PG_URL;
const live = url === undefined ? test.skip : test;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const categories = `dberr_${run}_categories`;
const products = `dberr_${run}_products`;

@Entity({ table: categories })
class Category { @Key() id = 0; @Index({ unique: true }) @Column({ type: "text" }) @Required() name = ""; }
@Entity({ table: products })
@Check<Product>(`ck_${products}_price`, (p) => p.price.gte(0))
class Product {
  @Key() id = 0;
  @Column({ type: "text" }) @Required() title = "";
  @Nullable() @Column({ type: "integer" }) price = 0;
  @Nullable() @Column({ type: "integer" }) categoryId = 0;
  @ManyToOne(() => Category, { foreignKey: "categoryId" }) category?: Category;
}
class Shop extends DbContext { readonly categories = this.set(Category); readonly products = this.set(Product); }

const providers: PostgresProvider[] = [];
const shop = (settings: { readonly operationTimeoutMs?: number; readonly serverTimeouts?: { readonly lockTimeoutMs?: number } } = {}) => { const provider = postgres({ url: url!, ...settings }); providers.push(provider); return new Shop(new DbContextOptions({ provider, entities: [Category, Product], validateOnSave: false })); };
const failure = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { return error; } throw new Error("expected a failure"); };

afterAll(async () => {
  if (!url) return;
  try { await shop().database.executeSqlRaw(`DROP TABLE IF EXISTS "${products}", "${categories}"`); } finally { for (const provider of providers) await provider.close(); }
});

describe("database errors against a disposable PostgreSQL database", () => {
  live("constraint violations from saveChanges and raw SQL arrive as ORM errors", async () => {
    const db = shop();
    await db.database.ensureCreated();
    db.categories.add(Object.assign(new Category(), { name: "Tea" }));
    await db.saveChanges();
    const unique = shop(); unique.categories.add(Object.assign(new Category(), { name: "Tea" }));
    expect(await failure(() => unique.saveChanges())).toBeInstanceOf(UniqueViolationError);
    const fk = shop(); fk.products.add(Object.assign(new Product(), { title: "Green", categoryId: 999 }));
    const fkError = await failure(() => fk.saveChanges()) as ForeignKeyViolationError;
    expect(fkError).toBeInstanceOf(ForeignKeyViolationError);
    expect(fkError.constraint).toBe(`fk_${products}_categoryId`);
    const check = shop(); check.products.add(Object.assign(new Product(), { title: "Green", price: -5, categoryId: 1 }));
    expect(await failure(() => check.saveChanges())).toBeInstanceOf(CheckViolationError);
    const notNull = await failure(() => shop().database.executeSqlRaw(`INSERT INTO "${products}" (title, price, "categoryId") VALUES (NULL, 1, 1)`)) as NotNullViolationError;
    expect(notNull).toBeInstanceOf(NotNullViolationError);
    expect(notNull.message).toBe(`Column "title" of table "${products}" does not accept NULL.`);
  });

  live("a lock that is not granted within lockTimeoutMs is a LockTimeoutError", async () => {
    const holder = shop(); const waiter = shop({ serverTimeouts: { lockTimeoutMs: 300 } });
    let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void; const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holding = holder.transactionScope(async () => { await holder.categories.findForUpdate(1); locked(); await released; });
    await isLocked;
    const error = await failure(() => waiter.transactionScope(() => waiter.categories.findForUpdate(1)));
    release(); await holding;
    expect(error).toBeInstanceOf(LockTimeoutError);
  }, 15_000);

  live("an unanswered statement outside a transaction names the timeout", async () => {
    const error = await failure(() => shop({ operationTimeoutMs: 300 }).database.querySqlRaw("SELECT pg_sleep(2)")) as TransactionOutcomeUnknownError;
    expect(error).toBeInstanceOf(TransactionOutcomeUnknownError);
    expect(error.phase).toBe("statement");
    expect(error.message).toBe("The database did not answer a statement sent outside a transaction: ORM operation timed out after 300 ms. If the statement changed data, its outcome is unknown: check the data and use a new DbContext before saving again.");
  }, 15_000);
});
