import { describe, expect, test } from "bun:test";
import { parseListQuery, type ListQueryOptions } from "@/library/jsonapi";
import {
  Column, DbContext, DbContextOptions, Entity, Key, PostgresDialect,
  type DatabaseProvider, type SqlParam,
} from "@/library/orm";
import { paginate } from "../listQuery";

const options: ListQueryOptions = {
  sort: ["name", "age"],
  filter: { name: ["eq", "contains", "in"], age: ["gte", "lte", "eq"], active: ["eq"] },
  page: { defaultSize: 20, maxSize: 100 },
};

describe("ListQuery parse contract", () => {
  test("normalizes filter, order and pagination shape before provider execution", () => {
    const query = parseListQuery(new URLSearchParams(
      "filter[active]=true&filter[or][0][age][lte]=19&filter[or][1][age][gte]=41&sort=-age,name&page[number]=2&page[size]=10",
    ), options);
    expect(query.sort).toEqual([{ field: "age", dir: "desc" }, { field: "name", dir: "asc" }]);
    expect(query.page).toMatchObject({ number: 2, size: 10, limit: 10, offset: 10 });
    expect(query.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "active", op: "eq", value: "true" }),
    ]));
    expect(query.or).toHaveLength(2);
  });

  test("rejects unknown fields and clamps the declared maximum page size before any provider is selected", () => {
    expect(() => parseListQuery(new URLSearchParams("sort=unknown"), options)).toThrow();
    expect(() => parseListQuery(new URLSearchParams("filter[unknown]=x"), options)).toThrow();
    expect(parseListQuery(new URLSearchParams("page[size]=101"), options).page)
      .toMatchObject({ size: 100, limit: 100 });
  });
});

@Entity({ table: "list_query_values" })
class ListQueryValue {
  @Key({ generated: false }) id = 0;
  @Column({ type: "text", name: "value_text" }) text = "";
  @Column({ type: "integer" }) amount = 0;
  @Column({ type: "real" }) ratio = 0;
  @Column({ type: "boolean" }) active = false;
}

class ListQueryContext extends DbContext {
  readonly values = this.set(ListQueryValue);
}

const typedOptions: ListQueryOptions = {
  filter: {
    text: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"],
    amount: ["eq", "gte", "in"],
    ratio: ["eq", "lte", "in"],
    active: ["eq", "in"],
  },
};

async function compiledFilter(params: URLSearchParams) {
  const statements: { sql: string; params: readonly SqlParam[] }[] = [];
  const provider: DatabaseProvider = {
    name: "list-query-recording",
    dialect: new PostgresDialect(),
    async query(sql, values = []) {
      statements.push({ sql, params: [...values] });
      return sql.startsWith("SELECT COUNT") ? [{ count: 0 }] : [];
    },
    async execute() { throw new Error("The list-query fixture permits reads only."); },
    async transaction(work) { return work(provider); },
    async introspect() { return { tables: new Map() }; },
    async ping() { return true; },
    async close() {},
  };
  const db = new ListQueryContext(new DbContextOptions({ provider, entities: [ListQueryValue] }));
  await paginate(db.values, parseListQuery(params, typedOptions));
  expect(statements).toHaveLength(2);
  const [count, select] = statements;
  expect(count!.sql).toStartWith('SELECT COUNT(*) AS count FROM "list_query_values"');
  expect(select!.params.slice(0, count!.params.length)).toEqual([...count!.params]);
  return count!;
}

describe("ListQuery filters use column metadata", () => {
  const textValues = ["0012", "000.50", "9007199254740993", "ordinary text", "true", "false"];

  for (const operation of ["eq", "ne", "gt", "gte", "lt", "lte"] as const) {
    test(`${operation} preserves text values exactly`, async () => {
      for (const value of textValues) {
        const compiled = await compiledFilter(new URLSearchParams({ [`filter[text][${operation}]`]: value }));
        expect(compiled.params).toEqual([value]);
        expect(compiled.sql).toContain('"value_text"');
      }
    });
  }

  for (const operation of ["in", "nin"] as const) {
    test(`${operation} preserves every text array element`, async () => {
      const compiled = await compiledFilter(new URLSearchParams({ [`filter[text][${operation}]`]: textValues.join(",") }));
      expect(compiled.params).toEqual(textValues);
      expect(compiled.sql).toContain(operation === "nin" ? 'NOT ("value_text" IN (' : '"value_text" IN (');
    });
  }

  test("OR groups use each selected column's type", async () => {
    const compiled = await compiledFilter(new URLSearchParams({
      "filter[or][0][text][eq]": "0012",
      "filter[or][0][active][eq]": "false",
      "filter[or][1][amount][gte]": "0012",
      "filter[or][1][ratio][lte]": "000.50",
    }));
    expect(compiled.params).toEqual(["0012", false, 12, 0.5]);
  });

  test("integer and real columns keep numeric query parameters", async () => {
    for (const [field, value, expected] of [
      ["amount", "0012", 12], ["amount", "-12", -12], ["amount", "0", 0],
      ["ratio", "000.50", 0.5], ["ratio", "-0.50", -0.5],
    ] as const) {
      const compiled = await compiledFilter(new URLSearchParams({ [`filter[${field}][eq]`]: value }));
      expect(compiled.params).toEqual([expected]);
    }
    const compiled = await compiledFilter(new URLSearchParams({ "filter[amount][in]": "0012,-12,0" }));
    expect(compiled.params).toEqual([12, -12, 0]);
  });

  test("integer filters keep precision outside the JavaScript safe range", async () => {
    const compiled = await compiledFilter(new URLSearchParams({ "filter[amount][in]": "9007199254740993,-9007199254740993" }));
    expect(compiled.params).toEqual([9007199254740993n, -9007199254740993n]);
  });

  test("boolean columns keep true/false and existing 1/0 query values", async () => {
    for (const [value, expected] of [["true", true], ["false", false], ["1", true], ["0", false]] as const) {
      const compiled = await compiledFilter(new URLSearchParams({ "filter[active][eq]": value }));
      expect(compiled.params).toEqual([expected]);
    }
    const compiled = await compiledFilter(new URLSearchParams({ "filter[active][in]": "true,false" }));
    expect(compiled.params).toEqual([true, false]);
  });
});
