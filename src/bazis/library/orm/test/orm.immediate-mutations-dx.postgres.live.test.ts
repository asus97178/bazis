import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Index, Key, UUID, postgres, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const articlesTable = `ormimm_${run}_articles`;
const eventsTable = `ormimm_${run}_events`;
const live = url === undefined ? test.skip : test;

@Entity({ table: articlesTable })
class Article {
  @Key() id = 0;
  @Index({ unique: true }) @Column({ type: "text" }) slug = "";
  @Column({ type: "datetime", nullable: true }) publishedAt: Date | null = null;
}
@Entity({ table: eventsTable })
class Event { @UUID({ version: "v7" }) id = ""; @Index({ unique: true }) @Column({ type: "text" }) code = ""; }
class Db extends DbContext { readonly articles = this.set(Article); readonly events = this.set(Event); }

let shared: PostgresProvider | undefined;
const context = () => new Db(new DbContextOptions({ provider: shared ??= postgres({ url: url! }), entities: [Article, Event] }));

afterAll(async () => {
  if (!url) return;
  try { for (const name of [articlesTable, eventsTable]) await shared?.execute(`DROP TABLE IF EXISTS "${name}"`, []); } finally { await shared?.close(); }
});

describe("immediate mutations against a disposable PostgreSQL database", () => {
  live("insertIfAbsent lets the database assign identity keys and generates UUID v7 keys", async () => {
    await context().database.ensureCreated();
    for (const slug of ["a", "b", "a"]) await context().articles.insertIfAbsent(Object.assign(new Article(), { slug }), { conflictBy: (x) => [x.slug] });
    const rows = await context().articles.asNoTracking().orderBy((x) => x.id).toList();
    expect(rows.map((x) => x.slug)).toEqual(["a", "b"]);
    expect(rows.every((x) => x.id > 0)).toBe(true);
    expect(await context().events.insertIfAbsent(Object.assign(new Event(), { code: "e" }), { conflictBy: (x) => [x.code] })).toEqual({ inserted: true });
    expect((await context().events.asNoTracking().first()).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  live("executeUpdate sets a nullable column to NULL", async () => {
    const db = context();
    await db.articles.asNoTracking().where((x) => x.slug.eq("a")).executeUpdate({ publishedAt: new Date("2026-10-10T00:00:00Z") });
    expect(await db.articles.asNoTracking().where((x) => x.publishedAt.isNotNull()).count()).toBe(1);
    expect(await db.articles.asNoTracking().where((x) => x.slug.eq("a")).executeUpdate({ publishedAt: null })).toEqual({ affectedRows: 1 });
    expect(await db.articles.asNoTracking().where((x) => x.publishedAt.isNotNull()).count()).toBe(0);
  });
});
