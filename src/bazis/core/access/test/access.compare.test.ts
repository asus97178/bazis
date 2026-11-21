import { expect, test } from "bun:test";
import { AccessModule, AccessPolicy, AttributeLookup, IAccess, IAccessCatalog, definePermissions, grantsToWhere, type AccessValue, type Condition, type PermissionsOf } from "@/core/access";
import { compareDecimals, decimalOf, decimalText } from "@/core/access/check/decimal";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singletonValue } from "@/core/di";
import { createTestContainer } from "@/core/testing";

// ACCESS-001 §4.2: gt, gte, lt, lte and the exact comparison of number attributes.

class RankLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) { return { column: "rankId", in: values }; }
}

const dealPermissions = definePermissions({
  "deals.read": {
    title: "See deals",
    on: { total: { type: "number" }, weight: { type: "number", column: "kg" }, rank: { type: "number", lookup: RankLookup }, status: { type: "string" }, buyer: { type: "string" } },
  },
});
declare module "@/core/access" {
  interface BazisPermissions extends PermissionsOf<typeof dealPermissions> {}
}

async function accessWith(where: Condition) {
  @Module({ imports: [AccessModule], permissions: dealPermissions, providers: [singletonValue(AccessPolicy, new StaticAccessPolicy({ grants: { "user:7": { "deals.read": [{ scopes: "all", where }] } } }))] })
  class DealsModule {}
  const container = await createTestContainer(DealsModule);
  const scope = container.createScope();
  return { access: scope.resolve(IAccess).as({ sub: "user:7" }, scope), catalog: container.resolve(IAccessCatalog) };
}

test("decimals compare exactly, whatever the notation", () => {
  const order = (left: unknown, right: unknown) => Math.sign(compareDecimals(decimalOf(left)!, decimalOf(right)!));
  expect(order("100000.00", 100000)).toBe(0);
  expect(order("100000.01", 100000)).toBe(1);
  expect(order("99999.99", 100000)).toBe(-1);
  expect(order("-5.50", -5.5)).toBe(0);
  expect(order("-5.51", -5.5)).toBe(-1);
  expect(order("-1", "0.5")).toBe(-1);
  expect(order("-0", 0)).toBe(0);
  expect(order("0.0", "-0.00")).toBe(0);
  expect(order("007.50", "7.5")).toBe(0);
  expect(order(".5", 0.5)).toBe(0);
  expect(order("5.", 5)).toBe(0);
  expect(order("1e3", 1000)).toBe(0);
  expect(order(1e21, "1000000000000000000000")).toBe(0);
  expect(order(1.5e-7, "0.00000015")).toBe(0);
  expect(order(10n, "9.99")).toBe(1);
  // A double cannot tell these two apart; the decimal comparison can.
  expect(Number("12345678901234567.89") === Number("12345678901234567.88")).toBe(true);
  expect(order("12345678901234567.89", "12345678901234567.88")).toBe(1);
  expect(order("9", "10")).toBe(-1);
  expect(order("0.1", "0.09")).toBe(1);

  for (const bad of ["", ".", "-", "abc", "1.2.3", "1e", "0x10", "1e5000", " ", "Infinity", NaN, Infinity, true, null, undefined, {}]) expect(decimalOf(bad), String(bad)).toBeUndefined();
  expect(decimalText(decimalOf("-007.500")!)).toBe("-7.5");
  expect(decimalText(decimalOf(1e21)!)).toBe("1000000000000000000000");
  expect(decimalText(decimalOf("-0.0")!)).toBe("0");
  expect(decimalText(decimalOf(1.5e-7)!)).toBe("0.00000015");
});

test("can: comparisons of a number attribute in three-valued logic", async () => {
  const { access } = await accessWith({ all: [{ total: { gt: 1000 } }, { total: { lte: 100000 } }, { not: { kg: { gte: 50 } } }] } as never);
  // `kg` is a column, not an attribute: the grant is dropped as a whole, not widened.
  expect(await access.grants("deals.read")).toEqual([]);

  const range = (await accessWith({ all: [{ total: { gt: 1000 } }, { total: { lte: 100000 } }, { not: { weight: { gte: 50 } } }] })).access;
  expect(await range.can("deals.read", { total: "100000.00", weight: 49.9 })).toBe(true);
  expect(await range.can("deals.read", { total: 100000, weight: 0 })).toBe(true);
  expect(await range.can("deals.read", { total: 1000.01, weight: 1 })).toBe(true);
  expect(await range.can("deals.read", { total: "1000.00", weight: 1 })).toBe(false);
  expect(await range.can("deals.read", { total: "100000.01", weight: 1 })).toBe(false);
  expect(await range.can("deals.read", { total: 5000, weight: 50 })).toBe(false);
  expect(await range.can("deals.read", { total: 5000n, weight: "49.999" })).toBe(true);
  // Unknown: the total is empty, the weight is missing, the value is not a number.
  expect(await range.can("deals.read", { total: null, weight: 1 })).toBe(false);
  expect(await range.can("deals.read", { total: 5000 })).toBe(false);
  expect(await range.can("deals.read", { total: 5000, weight: null })).toBe(false);
  expect(await range.can("deals.read", { total: "many", weight: 1 })).toBe(false);
  expect(await range.can("deals.read", { total: true, weight: 1 })).toBe(false);

  // «not greater» of an unknown value is unknown too, like in SQL: NOT (NULL > 5) is not true.
  const notGreater = (await accessWith({ not: { total: { gt: 5 } } })).access;
  expect(await notGreater.can("deals.read", { total: 5 })).toBe(true);
  expect(await notGreater.can("deals.read", { total: null })).toBe(false);
  expect(await notGreater.can("deals.read", {})).toBe(false);
});

test("can: eq, in and notIn of a number attribute compare numbers, not texts", async () => {
  const equal = (await accessWith({ total: { eq: 100000 } })).access;
  expect(await equal.can("deals.read", { total: "100000.00" })).toBe(true);
  expect(await equal.can("deals.read", { total: 100000 })).toBe(true);
  expect(await equal.can("deals.read", { total: "100000.01" })).toBe(false);

  const listed = (await accessWith({ total: { in: [0, "2.50", 1e3] } })).access;
  expect(await listed.can("deals.read", { total: "0.00" })).toBe(true);
  expect(await listed.can("deals.read", { total: 2.5 })).toBe(true);
  expect(await listed.can("deals.read", { total: "1000" })).toBe(true);
  expect(await listed.can("deals.read", { total: 3 })).toBe(false);
  expect(await listed.can("deals.read", { total: null })).toBe(false);

  const others = (await accessWith({ total: { notIn: [0, 100000] } })).access;
  expect(await others.can("deals.read", { total: "100000.00" })).toBe(false);
  expect(await others.can("deals.read", { total: "0.01" })).toBe(true);
  expect(await others.can("deals.read", { total: null })).toBe(false);

  // A string attribute keeps comparing as before.
  const status = (await accessWith({ status: { eq: "1.0" } })).access;
  expect(await status.can("deals.read", { status: "1.0" })).toBe(true);
  expect(await status.can("deals.read", { status: "1" })).toBe(false);
});

test("filter: a comparison becomes a column condition and an ORM predicate", async () => {
  const { access } = await accessWith({ any: [{ all: [{ total: { gte: 1000 } }, { total: { lt: 100000.5 } }] }, { not: { weight: { gt: 10 } } }, { total: { in: [1, "1e3", "007.50"] } }] });
  const filter = await access.filter("deals.read");
  expect(filter).toEqual({
    kind: "where",
    where: {
      any: [
        { all: [{ column: "total", op: "gte", value: 1000 }, { column: "total", op: "lt", value: 100000.5 }] },
        { not: { column: "kg", op: "gt", value: 10 } },
        { column: "total", in: [1, "1000", "7.5"] },
      ],
    },
  });
  const where = grantsToWhere(filter) as Exclude<ReturnType<typeof grantsToWhere>, string>;
  // An integer goes as it is; a fraction goes as decimal text, which a decimal column of the ORM accepts.
  expect(JSON.stringify(where.node)).toContain('{"kind":"compare","property":"total","op":">=","value":1000}');
  expect(JSON.stringify(where.node)).toContain('{"kind":"compare","property":"total","op":"<","value":"100000.5"}');
  expect(JSON.stringify(where.node)).toContain('{"kind":"compare","property":"kg","op":">","value":10}');
});

test("a comparison is for a number attribute with a column; the grant with another one is refused", async () => {
  const { catalog } = await accessWith({ total: { gt: 1 } });
  const problem = (where: unknown) => catalog.grantProblem("deals.read", { scopes: "all", where: where as Condition });
  expect(await problem({ total: { gt: 1 } })).toBeUndefined();
  expect(await problem({ weight: { lte: -0.5 } })).toBeUndefined();
  expect(await problem({ status: { gt: 1 } })).toBe('status.gt: only an attribute of type "number" with a column can be compared');
  expect(await problem({ buyer: { lt: 1 } })).toBe('buyer.lt: only an attribute of type "number" with a column can be compared');
  expect(await problem({ rank: { gte: 1 } })).toBe('rank.gte: only an attribute of type "number" with a column can be compared (this one has a lookup)');
  // Equality and lists through a lookup stay possible.
  expect(await problem({ rank: { in: [1, 2] } })).toBeUndefined();
  expect(await problem({ total: { gt: "1" } })).toBe("total.gt must be a number");
  expect(await problem({ total: { gt: Infinity } })).toBe("total.gt must be a number");
  expect(await problem({ total: { gt: null } })).toBe("total.gt must be a number");
  expect(await problem({ total: { gt: 1, lt: 5 } })).toBe('the test of "total" must have exactly one of eq, in, notIn, isNull, gt, gte, lt, lte');
  expect(await problem({ total: { between: [1, 5] } })).toBe('unknown test "between" of "total"');
  expect(await problem({ total: { eq: true } })).toBe("total.eq must be a number: the attribute is a number");
  expect(await problem({ total: { in: [1, "x"] } })).toBe("total.in must be a list of numbers: the attribute is a number");
  expect(await problem({ total: { eq: "100000.00" } })).toBeUndefined();
});
