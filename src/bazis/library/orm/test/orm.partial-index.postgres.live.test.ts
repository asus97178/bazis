import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Index, Key, postgres, Required, Schema, SoftDelete, UniqueViolationError } from "../index";

// 0.115.0: a partial unique index lets a soft-deleted row free its value.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

function members(where: "deleted" | "deletedOrBanned" | "none") {
  class Fields {
    @Key() id = 0;
    @Required() @Column({ type: "text" }) email = "";
    @Required() @Column({ type: "boolean" }) banned = false;
    @SoftDelete() deletedAt: Date | null = null;
  }
  @Schema(schema!) @Entity({ table: "members" })
  class Plain extends Fields {}
  @Schema(schema!) @Entity({ table: "members" })
  @Index<Fields>(["email"], { unique: true, where: (m) => m.deletedAt.isNull() })
  class NotDeleted extends Fields {}
  @Schema(schema!) @Entity({ table: "members" })
  @Index<Fields>(["email"], { unique: true, where: (m) => m.deletedAt.isNull().and(m.banned.eq(false)) })
  class NotDeletedOrBanned extends Fields {}
  const Member = where === "none" ? Plain : where === "deleted" ? NotDeleted : NotDeletedOrBanned;
  class MembersDb extends DbContext { readonly members = this.set(Member); }
  return { Member, MembersDb };
}

describe.skipIf(!url)("PostgreSQL partial indexes (live)", () => {
  test("ensureCreated creates the partial index, a deleted row frees its value and a restart finds no drift", async () => {
    schema = `bazis_partial_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    const provider = postgres({ url: url! });
    try {
      const { Member, MembersDb } = members("deleted");
      const db = () => new MembersDb(new DbContextOptions({ provider, entities: [Member] }));
      await db().database.ensureCreated();
      const [index] = await provider.query(`SELECT pg_get_expr(ix.indpred, ix.indrelid, true) AS predicate, ix.indisunique AS unique FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace WHERE n.nspname = $1 AND ic.relname = 'ix_members_email'`, [schema]);
      expect(index).toEqual({ predicate: '"deletedAt" IS NULL', unique: true });

      const first = db();
      const ann = Object.assign(new Member(), { email: "ann@x.io" });
      first.members.add(ann);
      await first.saveChanges();
      first.members.remove(ann);
      await first.saveChanges();
      const second = db();
      second.members.add(Object.assign(new Member(), { email: "ann@x.io" }));
      await second.saveChanges();
      const third = db();
      third.members.add(Object.assign(new Member(), { email: "ann@x.io" }));
      await expect(third.saveChanges()).rejects.toBeInstanceOf(UniqueViolationError);
      expect(await db().members.ignoreQueryFilters().count()).toBe(2);

      // A second start verifies the stored condition against the declared one.
      await db().database.ensureCreated();
    } finally { await provider.close(); }
  }, 30_000);

  test("a partial index is added to an existing table; a changed condition needs a migration", async () => {
    schema = `bazis_partial_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    const provider = postgres({ url: url! });
    try {
      const v1 = members("none");
      await new v1.MembersDb(new DbContextOptions({ provider, entities: [v1.Member] })).database.ensureCreated();
      const v2 = members("deleted");
      await new v2.MembersDb(new DbContextOptions({ provider, entities: [v2.Member] })).database.ensureCreated();
      const v3 = members("deletedOrBanned");
      await expect(new v3.MembersDb(new DbContextOptions({ provider, entities: [v3.Member] })).database.ensureCreated()).rejects.toThrow("partial index condition (where) differs");
    } finally { await provider.close(); }
  }, 30_000);
});
