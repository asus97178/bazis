import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Column,
  DbContext,
  DbContextOptions,
  Entity,
  ForeignKey,
  HasConversion,
  Index,
  Key,
  ManyToOne,
  OneToMany,
  QueryFilter,
  SoftDelete,
  ValueConverters,
  postgres,
  type PostgresProvider,
} from "@/library/orm";

/**
 * Живая интеграция провайдера PostgreSQL.
 *
 * Запускается только если задан `OSNV_PG_URL` (иначе весь блок пропускается),
 * поэтому в обычном `bun test` без базы он не мешает, а в CI с поднятой PG —
 * проверяет реальный путь: миграция, RETURNING-ключи, нативные типы
 * (boolean/timestamptz/jsonb), запросы, include и транзакционный SaveChanges.
 *
 *   OSNV_PG_URL="postgres://postgres:PASSWORD@localhost:5432/bun_app" bun test
 *
 * Использует таблицы `pg_it_*` и удаляет их до и после прогона.
 */

const PG_SECRET = "pg-live-test-secret";
const PG_TENANT = "live";

@Entity({ migrate: true, table: "pg_it_categories" })
class Category {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";

  @Column({ type: "json" })
  meta: Record<string, unknown> = {};

  @OneToMany(() => Product, { foreignKey: "categoryId" })
  products: Product[] = [];
}

@Entity({ migrate: true, table: "pg_it_products" })
class Product {
  @Key()
  id = 0;

  @Column({ type: "text" })
  title = "";

  @Index({ unique: true })
  @Column({ type: "text" })
  sku = "";

  @Column({ type: "real" })
  price = 0;

  @Column({ type: "boolean" })
  inStock = true;

  @Column({ type: "datetime" })
  createdAt = new Date();

  @Column({ type: "integer" })
  @ForeignKey(() => Category)
  categoryId = 0;

  @ManyToOne(() => Category, { foreignKey: "categoryId" })
  category?: Category;
}

class ShopContext extends DbContext {
  readonly products = this.set(Product);
  readonly categories = this.set(Category);
}

@Entity({ migrate: true, table: "pg_it_docs" })
@QueryFilter<PgDoc>((d) => d.tenantId.eq(PG_TENANT))
class PgDoc {
  @Key()
  id = 0;

  @Column({ type: "text" })
  tenantId = PG_TENANT;

  @Column({ type: "text" })
  title = "";

  @HasConversion(ValueConverters.encrypted(PG_SECRET))
  @Column({ type: "text" })
  secret = "";
}

@Entity({ migrate: true, table: "pg_it_soft_docs" })
class PgSoftDoc {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";

  @SoftDelete()
  deletedAt: Date | null = null;
}

class RoadmapContext extends DbContext {
  readonly docs = this.set(PgDoc);
  readonly softDocs = this.set(PgSoftDoc);
}

const url = process.env.OSNV_PG_URL;

async function dropCoreTables(provider: PostgresProvider): Promise<void> {
  await provider.execute("DROP TABLE IF EXISTS pg_it_products", []);
  await provider.execute("DROP TABLE IF EXISTS pg_it_categories", []);
}

async function dropRoadmapTables(provider: PostgresProvider): Promise<void> {
  await provider.execute("DROP TABLE IF EXISTS pg_it_soft_docs", []);
  await provider.execute("DROP TABLE IF EXISTS pg_it_docs", []);
}

describe.skipIf(!url)("PostgreSQL (live) — provider integration", () => {
  let provider: PostgresProvider;
  let ctx: ShopContext;
  let category: Category;

  beforeAll(async () => {
    provider = postgres({ url });
    await dropCoreTables(provider);
    ctx = new ShopContext(new DbContextOptions({ provider, entities: [Product, Category] }));
  });

  afterAll(async () => {
    if (provider) {
      await dropCoreTables(provider);
      await provider.close();
    }
  });

  test("connection ping succeeds", async () => {
    expect(await provider.ping()).toBe(true);
  });

  test("migrate creates schema in FK order; second run is a no-op", async () => {
    const first = await ctx.database.migrate();
    // createTable(categories) + createTable(products) + createIndex(products.sku)
    expect(first.applied).toBeGreaterThanOrEqual(3);
    const second = await ctx.database.migrate();
    expect(second.applied).toBe(0);
  });

  test("insert assigns generated key via RETURNING (typed as number)", async () => {
    category = new Category();
    category.name = "Peripherals";
    category.meta = { featured: true, rank: 1 };
    ctx.categories.add(category);
    await ctx.saveChanges();
    expect(typeof category.id).toBe("number");
    expect(category.id).toBeGreaterThan(0);

    const mk = (title: string, sku: string, price: number, inStock: boolean): Product => {
      const p = new Product();
      p.title = title;
      p.sku = sku;
      p.price = price;
      p.inStock = inStock;
      p.categoryId = category.id;
      return p;
    };
    ctx.products.addRange([
      mk("Keyboard", "KB-1", 49.9, true),
      mk("Mouse", "MS-1", 19.5, true),
      mk("Monitor", "MN-1", 199, false),
    ]);
    expect(await ctx.saveChanges()).toBe(3);
  });

  test("query: where + orderByDescending with native boolean/real", async () => {
    const cheap = await ctx.products
      .where((p) => p.inStock.eq(true).and(p.price.lt(100)))
      .orderByDescending((p) => p.price)
      .toList();
    expect(cheap.map((p) => p.sku)).toEqual(["KB-1", "MS-1"]);
  });

  test("include loads navigation (split query) and jsonb round-trips", async () => {
    const withProducts = await ctx.categories.include((c) => c.products).first();
    expect(withProducts.products).toHaveLength(3);
    expect((withProducts.meta as { featured?: boolean }).featured).toBe(true);
  });

  test("datetime round-trips as Date (timestamptz)", async () => {
    const product = await ctx.products.asNoTracking().first((p) => p.sku.eq("KB-1"));
    expect(product.createdAt).toBeInstanceOf(Date);
  });

  test("update persists only changed column", async () => {
    const mouse = await ctx.products.first((p) => p.sku.eq("MS-1"));
    mouse.price = 24.99;
    await ctx.saveChanges();
    const reloaded = await ctx.products.asNoTracking().first((p) => p.sku.eq("MS-1"));
    expect(reloaded.price).toBeCloseTo(24.99, 5);
  });

  test("delete inside transaction reduces count", async () => {
    const mouse = await ctx.products.first((p) => p.sku.eq("MS-1"));
    ctx.products.remove(mouse);
    await ctx.saveChanges();
    expect(await ctx.products.count()).toBe(2);
  });

  test("unique index rejects duplicate sku", async () => {
    const dup = new Product();
    dup.title = "Dup";
    dup.sku = "KB-1";
    dup.categoryId = category.id;
    ctx.products.add(dup);
    await expect(ctx.saveChanges()).rejects.toThrow();
  });
});

describe.skipIf(!url)("PostgreSQL (live) — roadmap features", () => {
  let provider: PostgresProvider;
  let ctx: RoadmapContext;

  beforeAll(async () => {
    provider = postgres({ url });
    await dropRoadmapTables(provider);
    ctx = new RoadmapContext(
      new DbContextOptions({ provider, entities: [PgDoc, PgSoftDoc], validateOnSave: false }),
    );
    await ctx.database.migrate();
  });

  afterAll(async () => {
    if (provider) {
      await dropRoadmapTables(provider);
      await provider.close();
    }
  });

  test("@QueryFilter and encrypted @HasConversion on PostgreSQL", async () => {
    const mine = new PgDoc();
    mine.title = "Mine";
    mine.secret = "classified";
    ctx.docs.add(mine);

    const theirs = new PgDoc();
    theirs.tenantId = "other";
    theirs.title = "Theirs";
    theirs.secret = "hidden";
    ctx.docs.add(theirs);
    await ctx.saveChanges();

    expect(await ctx.docs.count()).toBe(1);
    expect(await ctx.docs.ignoreQueryFilters().count()).toBe(2);

    const raw = await ctx.database.querySqlRaw('SELECT "secret" FROM pg_it_docs WHERE "title" = {0}', "Mine");
    expect(String(raw[0]!.secret)).not.toBe("classified");

    const loaded = await ctx.docs.asNoTracking().first((d) => d.title.eq("Mine"));
    expect(loaded.secret).toBe("classified");

    const rows = await ctx.docs.select((d) => ({ title: d.title })).toList();
    expect(rows).toEqual([{ title: "Mine" }]);
  });

  test("encrypted converter is applied by UPDATE and decodes through a fresh provider/context", async () => {
    const title = `converter-update-${crypto.randomUUID()}`;
    const doc = Object.assign(new PgDoc(), { title, secret: "before-update" });
    ctx.docs.add(doc); await ctx.saveChanges();
    doc.secret = "reclassified";
    await ctx.saveChanges();
    const raw = await ctx.database.querySqlRaw('SELECT "secret" FROM pg_it_docs WHERE "title" = {0}', title);
    expect(String(raw[0]!.secret)).not.toBe("reclassified");
    const freshProvider = postgres({ url });
    try {
      const fresh = new RoadmapContext(new DbContextOptions({ provider: freshProvider, entities: [PgDoc, PgSoftDoc], validateOnSave: false }));
      expect((await fresh.docs.asNoTracking().first((d) => d.title.eq(title))).secret).toBe("reclassified");
    } finally { await freshProvider.close(); }
  });

  test("@SoftDelete sets deletedAt instead of DELETE on PostgreSQL", async () => {
    const item = new PgSoftDoc();
    item.name = "Archive me";
    ctx.softDocs.add(item);
    await ctx.saveChanges();

    ctx.softDocs.remove(item);
    await ctx.saveChanges();

    expect(await ctx.softDocs.count()).toBe(0);
    const ghost = await ctx.softDocs.ignoreQueryFilters().first((d) => d.id.eq(item.id));
    expect(ghost.deletedAt).toBeInstanceOf(Date);
  });

});
