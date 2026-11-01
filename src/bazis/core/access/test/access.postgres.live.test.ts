import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, Schema } from "@/library/orm";
import { IAccess, AccessModule, AccessPolicy, AttributeLookup, definePermissions, grantsToWhere, type AccessValue, type Grants } from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singleton, singletonValue } from "@/core/di";
import { createTestContainer } from "@/core/testing";

// ACCESS-001 §4.3: the list filter and the object check agree on real rows.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

class GroupLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) {
    return { column: "kind", in: values.includes("paper") ? ["book", "magazine"] : [] };
  }
}

const permissions = definePermissions({
  "shop.items.read": {
    title: "See items",
    scope: { column: "shopId" },
    on: { status: { type: "string" }, kind: { type: "string" }, group: { type: "string", lookup: GroupLookup } },
    owner: "ownerId",
  },
});

describe.skipIf(!url)("access filters on PostgreSQL (live)", () => {
  test("every row passes the filter exactly when can() allows it", async () => {
    schema = `bazis_access_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "items" })
    class Item {
      @Key() id = 0;
      @Column({ nullable: true }) shopId: string | null = null;
      @Column({ nullable: true }) ownerId: string | null = null;
      @Column({ nullable: true }) status: string | null = null;
      @Column() kind = "";
    }
    class Db extends DbContext { readonly items = this.set(Item); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [Item] }));

    const grants: Grants = [
      { scopes: ["s1", null], where: { any: [{ own: true }, { all: [{ status: { in: ["new", "paid"] } }, { not: { kind: { eq: "secret" } } }] }] } },
      { scopes: "all", where: { all: [{ group: { eq: "paper" } }, { not: { status: { isNull: true } } }] } },
    ];
    @Module({ imports: [AccessModule], permissions, providers: [singleton(GroupLookup), singletonValue(AccessPolicy, new StaticAccessPolicy({ grants: { "user:7": { "shop.items.read": grants } } }))] })
    class AppModule {}

    try {
      await db().database.ensureCreated();
      const ctx = db();
      const shops = ["s1", "s2", null];
      const owners = ["7", "8", null];
      const statuses = ["new", "paid", "cancelled", null];
      const kinds = ["book", "magazine", "secret", "toy"];
      let id = 0;
      for (const shopId of shops) for (const ownerId of owners) for (const status of statuses) for (const kind of kinds) {
        ctx.items.add(Object.assign(new Item(), { id: ++id, shopId, ownerId, status, kind }));
      }
      await ctx.saveChanges();

      const scope = (await createTestContainer(AppModule)).createScope();
      const access = scope.resolve(IAccess).as({ sub: "user:7" }, scope);
      const where = grantsToWhere(await access.filter("shop.items.read"));
      expect(typeof where).toBe("object");
      const listed = (await db().items.asNoTracking().where(() => where as Exclude<typeof where, string>).orderBy((i) => i.id).toList()).map((item) => item.id);

      const all = await db().items.asNoTracking().orderBy((i) => i.id).toList();
      const allowed: number[] = [];
      for (const item of all) {
        const group = item.kind === "book" || item.kind === "magazine" ? "paper" : "other";
        if (await access.can("shop.items.read", { ...item, group, scope: item.shopId })) allowed.push(item.id);
      }
      expect(allowed.length).toBeGreaterThan(0);
      expect(allowed.length).toBeLessThan(all.length);
      expect(listed).toEqual(allowed);
    } finally {
      await provider.close();
    }
  });
});
