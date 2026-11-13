import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, Schema, Nullable } from "../index";

// 0.140.2: an integer beyond 2^53 is compared with a bigint column exactly.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

describe.skipIf(!url)("PostgreSQL integers beyond 2^53 (live)", () => {
  test("a condition on a big integer finds its row, not the neighbouring one", async () => {
    schema = `bazis_integer_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "rows" })
    class Row {
      @Key() id = 0;
      @Nullable() @Column({ type: "integer" }) big: number | null = null;
    }
    class Db extends DbContext { readonly rows = this.set(Row); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [Row] }));
    const ids = async (where: Parameters<ReturnType<typeof db>["rows"]["where"]>[0]) =>
      (await db().rows.asNoTracking().where(where).orderBy((row) => row.id).toList()).map((row) => row.id);
    try {
      await db().database.ensureCreated();
      // Two neighbours a double cannot tell apart, the first integer beyond 2^53, and a small one.
      await provider.execute(`INSERT INTO "${schema}"."rows" (id, big) VALUES (1, 1234567890123456789), (2, 1234567890123456790), (3, 9007199254740993), (4, 42), (5, NULL)`, []);

      expect(await ids((row) => row.big.eq("1234567890123456789" as never))).toEqual([1]);
      expect(await ids((row) => row.big.eq(1234567890123456789n as never))).toEqual([1]);
      expect(await ids((row) => row.big.in(["1234567890123456790", "42"] as never))).toEqual([2, 4]);
      expect(await ids((row) => row.big.ne("1234567890123456789" as never))).toEqual([2, 3, 4]);
      // 9007199254740992 is a double a number holds exactly; the row with ...993 lies above it.
      expect(await ids((row) => row.big.gt(9007199254740992))).toEqual([1, 2, 3]);
      expect(await ids((row) => row.big.lte(9007199254740992))).toEqual([4]);
      expect(await ids((row) => row.big.gte("9007199254740993" as never))).toEqual([1, 2, 3]);
      expect(await ids((row) => row.big.lt("1234567890123456790" as never))).toEqual([1, 3, 4]);
      // Small integers and fractions behave as before.
      expect(await ids((row) => row.big.eq(42))).toEqual([4]);
      expect(await ids((row) => row.big.gt(41.5))).toEqual([1, 2, 3, 4]);

      // An update by a big integer changes its row only, and writes the integer exactly.
      expect((await db().rows.asNoTracking().where((row) => row.big.eq(1234567890123456790n as never)).executeUpdate({ big: 1234567890123456791n as never })).affectedRows).toBe(1);
      const stored = await provider.query(`SELECT id, big::text AS big FROM "${schema}"."rows" WHERE id IN (1, 2) ORDER BY id`, []);
      expect(stored.map((row) => (row as { big: string }).big)).toEqual(["1234567890123456789", "1234567890123456791"]);
    } finally { await provider.close(); }
  }, 30_000);
});
