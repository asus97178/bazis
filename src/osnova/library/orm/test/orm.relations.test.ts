import { describe, expect, test } from "bun:test";
import {
  Column,
  DbContext,
  DbContextOptions,
  Entity,
  ForeignKey,
  Key,
  PostgresDialect,
  type DatabaseProvider,
} from "@/library/orm";

@Entity()
class OrderedParent {
  @Key({ generated: false })
  id = 0;
}

@Entity()
class OrderedChild {
  @Key({ generated: false })
  id = 0;

  @Column({ type: "integer" })
  @ForeignKey(() => OrderedParent)
  parentId = 0;
}

class OrderedContext extends DbContext {
  readonly parents = this.set(OrderedParent);
  readonly children = this.set(OrderedChild);
}

@Entity()
class CycleLeft {
  @Key({ generated: false })
  id = 0;

  @Column({ type: "integer" })
  @ForeignKey(() => CycleRight)
  rightId = 0;
}

@Entity()
class CycleRight {
  @Key({ generated: false })
  id = 0;

  @Column({ type: "integer" })
  @ForeignKey(() => CycleLeft)
  leftId = 0;
}

class CycleContext extends DbContext {
  readonly left = this.set(CycleLeft);
  readonly right = this.set(CycleRight);
}

function recordingProvider(onSql?: (sql: string) => void): DatabaseProvider {
  const provider: DatabaseProvider = {
    name: "postgres-recording",
    dialect: new PostgresDialect(),
    async query(sql) {
      onSql?.(sql);
      return [];
    },
    async execute(sql) {
      onSql?.(sql);
      return { changes: 1, lastInsertId: 0 };
    },
    async transaction(work) {
      return work(provider);
    },
    async ping() {
      return true;
    },
    async introspect() {
      return { tables: new Map() };
    },
    async close() {},
  };
  return provider;
}

describe("ORM relations — provider-independent ordering", () => {
  test("SaveChanges inserts parent before child and deletes child before parent", async () => {
    const statements: string[] = [];
    const ctx = new OrderedContext(
      new DbContextOptions({
        provider: recordingProvider((sql) => statements.push(sql)),
        entities: [OrderedChild, OrderedParent],
        validateOnSave: false,
      }),
    );
    const parent = Object.assign(new OrderedParent(), { id: 10 });
    const child = Object.assign(new OrderedChild(), { id: 20, parentId: 10 });
    ctx.children.add(child);
    ctx.parents.add(parent);
    await ctx.saveChanges();
    ctx.parents.remove(parent);
    ctx.children.remove(child);
    await ctx.saveChanges();

    expect(statements.map((sql) => sql.match(/"(OrderedParents|OrderedChilds)"/)?.[1])).toEqual([
      "OrderedParents",
      "OrderedChilds",
      "OrderedChilds",
      "OrderedParents",
    ]);
  });

  test("SaveChanges diagnoses model-level foreign-key cycles before issuing DML", async () => {
    let dmlStatements = 0;
    const ctx = new CycleContext(
      new DbContextOptions({
        provider: recordingProvider((sql) => {
          if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql)) dmlStatements += 1;
        }),
        entities: [CycleLeft, CycleRight],
        validateOnSave: false,
      }),
    );
    ctx.left.add(Object.assign(new CycleLeft(), { id: 1, rightId: 2 }));
    ctx.right.add(Object.assign(new CycleRight(), { id: 2, leftId: 1 }));

    await expect(ctx.saveChanges()).rejects.toThrow("foreign-key cycle: CycleLeft -> CycleRight -> CycleLeft");
    expect(dmlStatements).toBe(0);
  });
});
