import { describe, expect, test } from "bun:test";
import { parseListQuery, type ListQueryOptions } from "@/library/jsonapi";
import {
  Column, DbContext, DbContextOptions, Entity, Key, ManyToOne, OneToMany,
  Schema, postgres,
} from "@/library/orm";
import { paginate } from "../listQuery";

const enabled = process.env.BAZIS_RELEASE_095_PG === "owned-disposable-v1";

function fixtureUrl(): string {
  const raw = process.env.BAZIS_RELEASE_095_PG_URL;
  if (!enabled || !raw) throw new Error("The release ORM test requires its disposable PostgreSQL guard and dedicated URL.");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("The disposable PostgreSQL URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port || parsed.port === "5432"
    || parsed.pathname !== "/bazis_release_095") {
    throw new Error("The release ORM test only accepts database bazis_release_095 on a dedicated non-default 127.0.0.1 port.");
  }
  return raw;
}

async function createFixture() {
  const schema = `release_095_${crypto.randomUUID().replaceAll("-", "")}`;
  const statements: string[] = [];
  const provider = postgres({
    url: fixtureUrl(),
    operationTimeoutMs: 5_000,
    cancellationTimeoutMs: 1_000,
    onSql: (sql) => { statements.push(sql); },
  });
  let created = false;
  async function close() {
    try {
      if (created) {
        await provider.execute(`DROP SCHEMA "${schema}" CASCADE`, []);
        created = false;
      }
    } finally { await provider.close(); }
  }

  @Entity({ table: "roots" })
  @Schema(schema)
  class Root {
    @Key({ generated: false }) id = 0;
    @Column({ type: "integer", nullable: true }) featuredId: number | null = null;
    @OneToMany(() => Child, { foreignKey: "rootId" }) children: Child[] = [];
    @ManyToOne(() => Child, { foreignKey: "featuredId" }) featured: Child | null = null;
  }

  @Entity({ table: "children" })
  @Schema(schema)
  class Child {
    @Key({ generated: false }) id = 0;
    @Column({ type: "integer" }) rootId = 0;
    @Column({ type: "integer" }) noteId = 0;
    @OneToMany(() => Leaf, { foreignKey: "childId" }) leaves: Leaf[] = [];
    @ManyToOne(() => Note, { foreignKey: "noteId" }) note: Note | null = null;
  }

  @Entity({ table: "leaves" })
  @Schema(schema)
  class Leaf {
    @Key({ generated: false }) id = 0;
    @Column({ type: "integer" }) childId = 0;
  }

  @Entity({ table: "notes" })
  @Schema(schema)
  class Note {
    @Key({ generated: false }) id = 0;
  }

  @Entity({ table: "values" })
  @Schema(schema)
  class Value {
    @Key({ generated: false }) id = 0;
    @Column({ type: "text" }) text = "";
    @Column({ type: "integer" }) amount = 0;
    @Column({ type: "real" }) ratio = 0;
    @Column({ type: "boolean" }) active = false;
  }

  class Context extends DbContext {
    readonly roots = this.set(Root);
    readonly values = this.set(Value);
  }

  try {
    await provider.execute(`CREATE SCHEMA "${schema}"`, []);
    created = true;
    await provider.execute(`CREATE TABLE "${schema}"."roots" ("id" bigint PRIMARY KEY, "featuredId" bigint)`, []);
    await provider.execute(`CREATE TABLE "${schema}"."children" ("id" bigint PRIMARY KEY, "rootId" bigint NOT NULL, "noteId" bigint NOT NULL)`, []);
    await provider.execute(`CREATE TABLE "${schema}"."leaves" ("id" bigint PRIMARY KEY, "childId" bigint NOT NULL)`, []);
    await provider.execute(`CREATE TABLE "${schema}"."notes" ("id" bigint PRIMARY KEY)`, []);
    await provider.execute(`CREATE TABLE "${schema}"."values" ("id" bigint PRIMARY KEY, "text" text NOT NULL, "amount" bigint NOT NULL, "ratio" double precision NOT NULL, "active" boolean NOT NULL)`, []);
    await provider.execute(`INSERT INTO "${schema}"."roots" VALUES (1, 11), (2, 12), (3, NULL)`, []);
    await provider.execute(`INSERT INTO "${schema}"."children" VALUES (11, 1, 101), (12, 2, 102)`, []);
    await provider.execute(`INSERT INTO "${schema}"."leaves" VALUES (21, 11), (22, 11), (23, 12)`, []);
    await provider.execute(`INSERT INTO "${schema}"."notes" VALUES (101), (102)`, []);
    for (const [index, text] of ["0012", "12", "000.50", "0.5", "9007199254740993", "9007199254740992"].entries()) {
      await provider.execute(`INSERT INTO "${schema}"."values" VALUES ($1, $2, $3, $4, $5)`,
        [index + 1, text, index === 0 ? 9007199254740993n : index + 1, (index + 1) / 2, index % 2 === 0]);
    }
    const options = new DbContextOptions({ provider, entities: [Root, Child, Leaf, Note, Value] });
    statements.length = 0;
    return { context: () => new Context(options), statements, schema, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Release ORM fixture setup and cleanup failed.");
    }
    throw error;
  }
}

if (!enabled) {
  test.skip("SKIP — release ORM physical regressions require BAZIS_RELEASE_095_PG=owned-disposable-v1 and BAZIS_RELEASE_095_PG_URL", () => {});
} else {
  describe("release 0.95 disposable PostgreSQL ORM regressions", () => {
    test("both include branches survive all reference/collection, tracking and order combinations", async () => {
      const fixture = await createFixture();
      try {
        for (const navigation of ["children", "featured"] as const) {
          for (const noTracking of [false, true]) {
            for (const noteFirst of [false, true]) {
              const db = fixture.context();
              const query = noTracking ? db.roots.asNoTracking() : db.roots;
              const first = noteFirst ? "note" : "leaves";
              const second = noteFirst ? "leaves" : "note";
              fixture.statements.length = 0;
              const roots = await query.orderBy((root) => root.id)
                .include((root) => root[navigation]).thenInclude((child) => child[first])
                .include((root) => root[navigation]).thenInclude((child) => child[second])
                .toList();
              const children = navigation === "children"
                ? roots.flatMap((root) => root.children)
                : roots.flatMap((root) => root.featured ? [root.featured] : []);
              expect(children.map((child) => ({ id: child.id, leaves: child.leaves.map((leaf) => leaf.id).sort(), note: child.note?.id })))
                .toEqual([{ id: 11, leaves: [21, 22], note: 101 }, { id: 12, leaves: [23], note: 102 }]);
              expect(roots[2]![navigation]).toEqual(navigation === "children" ? [] : null);
              expect(fixture.statements.filter((sql) => sql.includes(`FROM "${fixture.schema}"."children"`))).toHaveLength(1);
              expect(fixture.statements.filter((sql) => sql.startsWith("SELECT "))).toHaveLength(4);
            }
          }
        }
      } finally { await fixture.close(); }
    }, 30_000);

    test("paginate returns exact text matches and typed numeric/boolean matches", async () => {
      const fixture = await createFixture();
      const options: ListQueryOptions = {
        filter: { text: ["eq", "in", "nin"], amount: ["eq"], ratio: ["eq"], active: ["eq"] },
      };
      try {
        async function list(values: Record<string, string>) {
          return paginate(fixture.context().values.asNoTracking(), parseListQuery(new URLSearchParams(values), options));
        }
        for (const text of ["0012", "000.50", "9007199254740993"]) {
          const result = await list({ "filter[text][eq]": text });
          expect(result.items.map((item) => item.text)).toEqual([text]);
          expect(result.total).toBe(1);
        }
        const included = await list({ "filter[text][in]": "0012,000.50,9007199254740993" });
        expect(included.items.map((item) => item.text)).toEqual(["0012", "000.50", "9007199254740993"]);
        expect(included.total).toBe(3);
        const excluded = await list({ "filter[text][nin]": "0012,000.50,9007199254740993" });
        expect(excluded.items.map((item) => item.text)).toEqual(["12", "0.5", "9007199254740992"]);
        expect(excluded.total).toBe(3);
        expect((await list({ "filter[amount][eq]": "0002" })).items.map((item) => item.id)).toEqual([2]);
        expect((await list({ "filter[amount][eq]": "9007199254740993" })).items.map((item) => item.id)).toEqual([1]);
        expect((await list({ "filter[ratio][eq]": "000.50" })).items.map((item) => item.id)).toEqual([1]);
        expect((await list({ "filter[active][eq]": "false" })).items.map((item) => item.id)).toEqual([2, 4, 6]);
        expect((await list({ "filter[active][eq]": "true" })).items.map((item) => item.id)).toEqual([1, 3, 5]);
      } finally { await fixture.close(); }
    }, 30_000);
  });
}
