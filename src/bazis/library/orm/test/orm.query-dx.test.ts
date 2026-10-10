import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, PostgresDialect, type DatabaseProvider, type ExecuteResult, type Row } from "../index";

// 0.98.16: a predicate that is not an ORM condition fails with a hint,
// text matches take { ignoreCase: true } (ILIKE), and a computation inside
// select() says to compute after toList().
@Entity({ table: "posts" })
class Post {
  @Key() id = 0;
  @Column({ type: "text" }) title = "";
  @Column({ type: "integer" }) views = 0;
}

class BlogDb extends DbContext { readonly posts = this.set(Post); }

function recording(): { readonly db: BlogDb; readonly sql: { text: string; params: readonly unknown[] }[] } {
  const sql: { text: string; params: readonly unknown[] }[] = [];
  const executor = {
    query: async (text: string, params: readonly unknown[]): Promise<Row[]> => { sql.push({ text, params }); return []; },
    execute: async (): Promise<ExecuteResult> => ({ changes: 0, lastInsertId: 0 }),
  };
  const provider = {
    name: "test", dialect: new PostgresDialect(), ...executor,
    transaction: async <T>(work: (value: typeof executor) => Promise<T>) => work(executor),
    ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {},
  } as unknown as DatabaseProvider;
  return { db: new BlogDb(new DbContextOptions({ provider, entities: [Post] })), sql };
}

describe("query DX", () => {
  test("a predicate that is not a condition fails with a hint", () => {
    const { db } = recording();
    expect(() => db.posts.where((p) => (p.views as unknown as number) > 70 as never)).toThrow(
      "where() expects a condition such as (p) => p.views.gt(70), got boolean. Use .gt()/.eq()/.and()/.or() instead of >, ===, &&, ||.",
    );
    expect(() => db.posts.where(() => undefined as never)).toThrow("got undefined");
  });

  test("ignoreCase uses ILIKE with escaped wildcards", async () => {
    const { db, sql } = recording();
    await db.posts.where((p) => p.title.contains("Sql_", { ignoreCase: true })).toList();
    await db.posts.where((p) => p.title.startsWith("b", { ignoreCase: true })).toList();
    await db.posts.where((p) => p.title.eq("Bun Tips", { ignoreCase: true })).toList();
    await db.posts.where((p) => p.title.contains("SQL")).toList();
    expect(sql.map((entry) => /"title" (I?LIKE) \$1 ESCAPE '\\'/.exec(entry.text)?.[1])).toEqual(["ILIKE", "ILIKE", "ILIKE", "LIKE"]);
    expect(sql.map((entry) => entry.params[0])).toEqual(["%Sql\\_%", "b%", "Bun Tips", "%SQL%"]);
    expect(() => db.posts.where((p) => p.views.eq(1, { ignoreCase: true }))).toThrow('eq(..., { ignoreCase: true }) on "views" needs a string value.');
  });

  test("a computation inside select() says to compute after toList()", () => {
    const { db } = recording();
    const hint = "select() maps properties as they are, e.g. (p) => ({ name: p.title }); compute values after toList().";
    expect(() => db.posts.select((p) => ({ label: `${p.title}!` }))).toThrow(hint);
    expect(() => db.posts.select((p) => ({ total: (p.views as number) + 1 }))).toThrow(hint);
    expect(() => db.posts.select(() => ({ fixed: 1 }))).toThrow(`${hint} "fixed" is not a property.`);
    expect(() => db.posts.select((p) => ({ name: p.title, views: p.views }))).not.toThrow();
  });
});
