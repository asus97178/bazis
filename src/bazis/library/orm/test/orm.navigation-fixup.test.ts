import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, ManyToOne, OneToMany, PostgresDialect, Required, type DatabaseProvider, type ExecuteResult, type Row } from "../index";

// 0.98.17: saveChanges takes foreign keys from navigations. Before,
// `article.author = bob` left authorId at 0 and the insert violated the FK.
@Entity({ table: "authors" })
class Author {
  @Key() id = 0;
  @Column({ type: "text" }) @Required() name = "";
  @OneToMany(() => Article, { foreignKey: "authorId" }) articles: Article[] = [];
}
@Entity({ table: "articles" })
class Article {
  @Key() id = 0;
  @Column({ type: "text" }) title = "";
  @Column({ type: "integer" }) authorId = 0;
  @ManyToOne(() => Author, { foreignKey: "authorId" }) author?: Author;
}
class Db extends DbContext { readonly authors = this.set(Author); readonly articles = this.set(Article); }

function recording() {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  let nextId = 100;
  const executor = {
    query: async (sql: string, params: readonly unknown[]): Promise<Row[]> => {
      statements.push({ sql, params });
      if (sql.startsWith("INSERT")) return Array.from({ length: (sql.match(/\(\$/g) ?? []).length }, () => ({ id: nextId++ }));
      if (sql.startsWith("SELECT")) return [{ id: 5, name: "Ann" }];
      return [];
    },
    execute: async (sql: string, params: readonly unknown[]): Promise<ExecuteResult> => { statements.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; },
  };
  const provider = {
    name: "test", dialect: new PostgresDialect(), ...executor,
    transaction: async <T>(work: (value: typeof executor) => Promise<T>) => work(executor),
    ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {},
  } as unknown as DatabaseProvider;
  return { db: new Db(new DbContextOptions({ provider, entities: [Author, Article] })), statements };
}

const articleInsert = (statements: { sql: string; params: readonly unknown[] }[]) =>
  statements.find((statement) => statement.sql.startsWith('INSERT INTO "articles"'))!;

describe("navigation fix-up on save", () => {
  test("a reference navigation to a new parent sets the foreign key after the parent's insert", async () => {
    const { db, statements } = recording();
    const bob = Object.assign(new Author(), { name: "Bob" });
    const article = Object.assign(new Article(), { title: "By Bob", author: bob });
    db.authors.add(bob);
    db.articles.add(article);
    await db.saveChanges();
    expect(bob.id).toBe(100);
    expect(article.authorId).toBe(100);
    expect(articleInsert(statements).params).toContain(100);
  });

  test("a collection navigation sets the children's foreign key", async () => {
    const { db } = recording();
    const bob = Object.assign(new Author(), { name: "Bob" });
    const first = Object.assign(new Article(), { title: "One" });
    const second = Object.assign(new Article(), { title: "Two" });
    bob.articles.push(first, second);
    db.authors.add(bob);
    db.articles.addRange([first, second]);
    await db.saveChanges();
    expect([first.authorId, second.authorId]).toEqual([100, 100]);
  });

  test("changing the navigation of a loaded entity updates the foreign key", async () => {
    const { db, statements } = recording();
    const loaded = db.articles.attach(Object.assign(new Article(), { id: 1, title: "Old", authorId: 5 }));
    const eve = Object.assign(new Author(), { name: "Eve" });
    db.authors.add(eve);
    loaded.author = eve;
    await db.saveChanges();
    expect(loaded.authorId).toBe(100);
    const update = statements.find((statement) => statement.sql.startsWith('UPDATE "articles"'))!;
    expect(update.sql).toBe('UPDATE "articles" SET "authorId" = $1 WHERE "id" = $2');
    expect(update.params).toEqual([100, 1]);
  });

  test("an explicit foreign key without a navigation is kept", async () => {
    const { db } = recording();
    const article = Object.assign(new Article(), { title: "Plain", authorId: 42 });
    db.articles.add(article);
    await db.saveChanges();
    expect(article.authorId).toBe(42);
  });
});
