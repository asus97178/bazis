import { describe, expect, test } from "bun:test";
import {
  Column,
  DbContext,
  DbContextOptions,
  Entity,
  Key,
  ManyToOne,
  OneToMany,
  PostgresDialect,
  type DatabaseProvider,
  type Row,
  type SqlParam,
} from "../index";

@Entity({ table: "include_roots" })
class IncludeRoot {
  @Key({ generated: false }) id = 0;
  @Column({ type: "integer", nullable: true }) featuredId: number | null = null;
  @OneToMany(() => IncludeChild, { foreignKey: "rootId" }) children: IncludeChild[] = [];
  @ManyToOne(() => IncludeChild, { foreignKey: "featuredId" }) featured: IncludeChild | null = null;
}

@Entity({ table: "include_children" })
class IncludeChild {
  @Key({ generated: false }) id = 0;
  @Column({ type: "integer" }) rootId = 0;
  @Column({ type: "integer", nullable: true }) noteId: number | null = null;
  @OneToMany(() => IncludeLeaf, { foreignKey: "childId" }) leaves: IncludeLeaf[] = [];
  @ManyToOne(() => IncludeNote, { foreignKey: "noteId" }) note: IncludeNote | null = null;
}

@Entity({ table: "include_leaves" })
class IncludeLeaf {
  @Key({ generated: false }) id = 0;
  @Column({ type: "integer" }) childId = 0;
}

@Entity({ table: "include_notes" })
class IncludeNote {
  @Key({ generated: false }) id = 0;
}

class IncludeContext extends DbContext {
  readonly roots = this.set(IncludeRoot);
}

function fixture() {
  const rows: Record<string, Row[]> = {
    include_roots: [{ id: 1, featuredId: 11 }, { id: 2, featuredId: 12 }, { id: 3, featuredId: null }],
    include_children: [{ id: 11, rootId: 1, noteId: 101 }, { id: 12, rootId: 2, noteId: 102 }],
    include_leaves: [{ id: 21, childId: 11 }, { id: 22, childId: 11 }, { id: 23, childId: 12 }],
    include_notes: [{ id: 101 }, { id: 102 }],
  };
  const statements: { table: string; sql: string; params: readonly SqlParam[] }[] = [];
  const provider: DatabaseProvider = {
    name: "include-recording",
    dialect: new PostgresDialect(),
    async query(sql, params = []) {
      const table = sql.match(/FROM "([^"]+)"/)?.[1];
      if (!table || !rows[table]) throw new Error(`Unexpected fixture query: ${sql}`);
      statements.push({ table, sql, params: [...params] });
      const field = sql.match(/WHERE "([^"]+)" IN/)?.[1];
      return rows[table]!.filter((row) => !field || params.includes(row[field] as SqlParam));
    },
    async execute() { throw new Error("The include fixture permits reads only."); },
    async transaction(work) { return work(provider); },
    async introspect() { return { tables: new Map() }; },
    async ping() { return true; },
    async close() {},
  };
  const db = new IncludeContext(new DbContextOptions({
    provider,
    entities: [IncludeRoot, IncludeChild, IncludeLeaf, IncludeNote],
  }));
  return { db, statements, rows };
}

describe("ORM branched includes", () => {
  for (const navigation of ["children", "featured"] as const) {
    for (const noTracking of [false, true]) {
      for (const noteFirst of [false, true]) {
        test(`${navigation}: retains both branches and reads the shared prefix once (noTracking=${noTracking}, noteFirst=${noteFirst})`, async () => {
          const { db, statements } = fixture();
          const query = noTracking ? db.roots.asNoTracking() : db.roots;
          const first = noteFirst ? "note" : "leaves";
          const second = noteFirst ? "leaves" : "note";
          const roots = await query
            .include((root) => root[navigation]).thenInclude((child) => child[first])
            .include((root) => root[navigation]).thenInclude((child) => child[second])
            .toList();
          const children = navigation === "children"
            ? roots.flatMap((root) => root.children)
            : roots.flatMap((root) => root.featured ? [root.featured] : []);

          expect(children.map((child) => ({ id: child.id, leaves: child.leaves.map((leaf) => leaf.id), note: child.note?.id })))
            .toEqual([{ id: 11, leaves: [21, 22], note: 101 }, { id: 12, leaves: [23], note: 102 }]);
          expect(roots[2]![navigation]).toEqual(navigation === "children" ? [] : null);
          expect(statements.filter((statement) => statement.table === "include_children")).toHaveLength(1);
          expect(statements.map((statement) => statement.table)).toEqual([
            "include_roots", "include_children",
            ...(noteFirst ? ["include_notes", "include_leaves"] : ["include_leaves", "include_notes"]),
          ]);
        });
      }
    }
  }

  test("a standalone repeated prefix does not replace its previously populated branches", async () => {
    const { db, statements } = fixture();
    const roots = await db.roots.asNoTracking()
      .include((root) => root.children).thenInclude((child) => child.leaves)
      .include((root) => root.children)
      .toList();

    expect(roots[0]!.children[0]!.leaves.map((leaf) => leaf.id)).toEqual([21, 22]);
    expect(statements.filter((statement) => statement.table === "include_children")).toHaveLength(1);
  });

  test("empty shared prefixes are read once and do not issue descendant queries", async () => {
    const { db, statements, rows } = fixture();
    rows.include_children = [];
    const roots = await db.roots.asNoTracking()
      .include((root) => root.children).thenInclude((child) => child.leaves)
      .include((root) => root.children).thenInclude((child) => child.note)
      .toList();

    expect(roots.every((root) => root.children.length === 0)).toBe(true);
    expect(statements.map((statement) => statement.table)).toEqual(["include_roots", "include_children"]);
  });

  test("the loaded-prefix cache belongs to one query execution", async () => {
    const { db, statements, rows } = fixture();
    const query = db.roots.asNoTracking()
      .include((root) => root.children).thenInclude((child) => child.leaves)
      .include((root) => root.children).thenInclude((child) => child.note);
    const before = await query.toList();
    rows.include_leaves = [{ id: 29, childId: 11 }];
    const after = await query.toList();

    expect(before[0]!.children[0]!.leaves.map((leaf) => leaf.id)).toEqual([21, 22]);
    expect(after[0]!.children[0]!.leaves.map((leaf) => leaf.id)).toEqual([29]);
    expect(after[0]!.children[0]).not.toBe(before[0]!.children[0]);
    expect(statements.filter((statement) => statement.table === "include_children")).toHaveLength(2);
  });
});
