import { expect, test } from "bun:test";
import { Module } from "@/core/di";
import { ormModule } from "@/core/orm";
import { createTestContainer } from "@/core/testing";
import { Column, DbContext, Entity, OrmError, UUID, type DatabaseProvider, type DbContextOptions, Nullable } from "@/library/orm";

@Entity({ table: "ce_users" }) class User { @UUID() id = ""; @Nullable() @Column({ type: "text" }) name = ""; }
@Entity({ table: "ce_posts" }) class Post { @UUID() id = ""; @Nullable() @Column({ type: "text" }) title = ""; }
@Entity({ table: "ce_tags" }) class Tag { @UUID() id = ""; @Nullable() @Column({ type: "text" }) name = ""; }

class BlogDbContext extends DbContext {
  readonly users = this.set(User);
  readonly posts = this.set(Post);
  readonly again = this.setOf(User);
}

class Clock { now() { return 1; } }
class NeedsClock extends DbContext {
  readonly users = this.set(User);
  readonly startedAt: number;
  constructor(options: DbContextOptions, clock: Clock) {
    super(options);
    this.startedAt = clock.now();
  }
}

const provider = { name: "fake", dialect: {}, query: async () => [], execute: async () => ({ affectedRows: 0 }), close: async () => undefined, ping: async () => true } as unknown as DatabaseProvider;

test("a context names the entities of its sets, each once, in the order of its fields", () => {
  expect(DbContext.entitiesOf(BlogDbContext)).toEqual([User, Post]);
  // Reading the sets leaves nothing behind: an ordinary context is built as before.
  expect(DbContext.entitiesOf(BlogDbContext)).toEqual([User, Post]);
});

test("a constructor that needs its dependencies says to list the entities", () => {
  expect(() => DbContext.entitiesOf(NeedsClock)).toThrow(OrmError);
  expect(() => DbContext.entitiesOf(NeedsClock)).toThrow("List them: entities: [...]");
  expect(() => ormModule({ context: NeedsClock, provider })).toThrow("List them: entities: [...]");
  expect(() => ormModule({ context: NeedsClock, entities: [User], provider })).not.toThrow();
});

test("ormBazis without entities maps the sets; listed entities are added to them", async () => {
  @Module({ ormBazis: { context: BlogDbContext, provider, healthCheck: false } }) class BlogModule {}
  const container = await createTestContainer(BlogModule);
  const scope = container.createScope();
  try {
    const db = scope.resolve(BlogDbContext);
    expect(db.users).toBeDefined();
    expect(() => db.setOf(Post)).not.toThrow();
    expect(() => db.setOf(Tag)).toThrow();
  } finally {
    await scope.dispose();
  }

  @Module({ ormBazis: { context: BlogDbContext, entities: [Tag], provider, healthCheck: false } }) class TaggedModule {}
  const tagged = await createTestContainer(TaggedModule);
  const taggedScope = tagged.createScope();
  try {
    const db = taggedScope.resolve(BlogDbContext);
    expect(() => db.setOf(Tag)).not.toThrow();
    expect(() => db.setOf(User)).not.toThrow();
  } finally {
    await taggedScope.dispose();
  }
});
