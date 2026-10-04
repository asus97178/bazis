import { describe, expect, test } from "bun:test";
import {
  buildListDocument,
  ListQueryError,
  parseListQuery,
  serializeListQuery,
  type ListQueryOptions,
} from "@/library/jsonapi";

const OPTIONS: ListQueryOptions = {
  sort: ["name", "age", "createdAt"],
  filter: {
    name: ["eq", "contains"],
    age: ["gte", "lte", "in"],
    deletedAt: ["isNull", "isNotNull"],
  },
  include: ["posts"],
  page: { defaultSize: 20, maxSize: 100 },
};

function parse(qs: string) {
  return parseListQuery(new URLSearchParams(qs), OPTIONS);
}

describe("parseListQuery — sort", () => {
  test("parses direction and multiple keys", () => {
    expect(parse("sort=name,-age").sort).toEqual([
      { field: "name", dir: "asc" },
      { field: "age", dir: "desc" },
    ]);
  });

  test("treats leading + as ascending", () => {
    expect(parse("sort=+name").sort).toEqual([{ field: "name", dir: "asc" }]);
  });

  test("rejects sorting by a field not in the whitelist", () => {
    expect(() => parse("sort=email")).toThrow(ListQueryError);
  });
});

describe("parseListQuery — filter", () => {
  test("bare filter means eq", () => {
    expect(parse("filter[name]=Bob").filters).toEqual([{ field: "name", op: "eq", value: "Bob" }]);
  });

  test("operator in brackets", () => {
    expect(parse("filter[age][gte]=18").filters).toEqual([{ field: "age", op: "gte", value: "18" }]);
  });

  test("in splits a comma list", () => {
    expect(parse("filter[age][in]=18,21,30").filters).toEqual([
      { field: "age", op: "in", value: ["18", "21", "30"] },
    ]);
  });

  test("valueless operator keeps empty value", () => {
    expect(parse("filter[deletedAt][isNull]=").filters).toEqual([
      { field: "deletedAt", op: "isNull", value: "" },
    ]);
  });

  test("rejects unknown operator", () => {
    expect(() => parse("filter[age][between]=1")).toThrow(ListQueryError);
  });

  test("rejects operator not allowed for field", () => {
    expect(() => parse("filter[name][gte]=1")).toThrow(ListQueryError);
  });

  test("rejects filtering by a field not in the whitelist", () => {
    expect(() => parse("filter[secret]=1")).toThrow(ListQueryError);
  });
});

describe("parseListQuery — OR groups", () => {
  test("no OR groups by default", () => {
    expect(parse("filter[name]=Bob").or).toEqual([]);
  });

  test("groups rules by index, AND within a group", () => {
    const query = parse("filter[or][0][name]=Ann&filter[or][0][age][gte]=18&filter[or][1][name]=Cara");
    expect(query.or).toEqual([
      [
        { field: "name", op: "eq", value: "Ann" },
        { field: "age", op: "gte", value: "18" },
      ],
      [{ field: "name", op: "eq", value: "Cara" }],
    ]);
    expect(query.filters).toEqual([]);
  });

  test("orders groups by numeric index regardless of param order", () => {
    const query = parse("filter[or][2][name]=C&filter[or][0][name]=A&filter[or][1][name]=B");
    expect(query.or.map((g) => g[0]!.value)).toEqual(["A", "B", "C"]);
  });

  test("validates OR leaves against the same whitelist", () => {
    expect(() => parse("filter[or][0][secret]=1")).toThrow(ListQueryError);
    expect(() => parse("filter[or][0][name][gte]=1")).toThrow(ListQueryError);
  });

  test("top-level filters coexist with OR groups", () => {
    const query = parse("filter[name]=Bob&filter[or][0][age][gte]=18&filter[or][1][age][lte]=5");
    expect(query.filters).toEqual([{ field: "name", op: "eq", value: "Bob" }]);
    expect(query.or).toEqual([
      [{ field: "age", op: "gte", value: "18" }],
      [{ field: "age", op: "lte", value: "5" }],
    ]);
  });
});

describe("parseListQuery — pagination", () => {
  test("defaults", () => {
    expect(parse("").page).toEqual({ number: 1, size: 20, offset: 0, limit: 20 });
  });

  test("number/size style", () => {
    expect(parse("page[number]=3&page[size]=10").page).toEqual({ number: 3, size: 10, offset: 20, limit: 10 });
  });

  test("offset/limit style normalizes to number", () => {
    expect(parse("page[offset]=40&page[limit]=20").page).toEqual({ number: 3, size: 20, offset: 40, limit: 20 });
  });

  test("clamps size to maxSize", () => {
    expect(parse("page[size]=1000").page.size).toBe(100);
  });

  test("rejects invalid page number", () => {
    expect(() => parse("page[number]=0")).toThrow(ListQueryError);
    expect(() => parse("page[number]=abc")).toThrow(ListQueryError);
  });
});

describe("parseListQuery — include & fields", () => {
  test("include whitelist", () => {
    expect(parse("include=posts").include).toEqual(["posts"]);
    expect(() => parse("include=secrets")).toThrow(ListQueryError);
  });

  test("sparse fieldsets are parsed per type", () => {
    expect(parse("fields[users]=name,age").fields).toEqual({ users: ["name", "age"] });
  });
});

describe("parseListQuery — error aggregation", () => {
  test("collects every problem at once", () => {
    try {
      parse("sort=email&filter[secret]=1&page[number]=0");
      throw new Error("expected ListQueryError");
    } catch (error) {
      expect(error).toBeInstanceOf(ListQueryError);
      expect((error as ListQueryError).problems).toHaveLength(3);
    }
  });
});

describe("buildListDocument", () => {
  test("meta counters", () => {
    const query = parse("page[number]=2&page[size]=10");
    const doc = buildListDocument([{ id: 1 }], query, 35);
    expect(doc.meta).toEqual({ total: 35, page: 2, size: 10, pageCount: 4 });
    expect(doc.links).toBeUndefined();
  });

  test("links with basePath", () => {
    const query = parse("page[number]=2&page[size]=10&sort=name");
    const doc = buildListDocument([], query, 35, { basePath: "/api/users" });
    expect(doc.links?.self).toContain("/api/users?");
    expect(doc.links?.first).toContain("page%5Bnumber%5D=1");
    expect(doc.links?.prev).toContain("page%5Bnumber%5D=1");
    expect(doc.links?.next).toContain("page%5Bnumber%5D=3");
    expect(doc.links?.last).toContain("page%5Bnumber%5D=4");
  });

  test("no prev on first page, no next on last", () => {
    const query = parse("page[number]=1&page[size]=10");
    const doc = buildListDocument([], query, 5, { basePath: "/x" });
    expect(doc.links?.prev).toBeUndefined();
    expect(doc.links?.next).toBeUndefined();
  });
});

describe("serializeListQuery", () => {
  test("round-trips through parseListQuery", () => {
    const query = parse("sort=name,-age&filter[age][gte]=18&filter[name]=Bob&page[number]=2&page[size]=10");
    const reparsed = parseListQuery(new URLSearchParams(serializeListQuery(query)), OPTIONS);
    expect(reparsed.sort).toEqual(query.sort);
    expect(reparsed.filters).toEqual(query.filters);
    expect(reparsed.page).toEqual(query.page);
  });

  test("round-trips OR groups", () => {
    const query = parse("filter[name]=Bob&filter[or][0][age][gte]=18&filter[or][1][age][lte]=5");
    const reparsed = parseListQuery(new URLSearchParams(serializeListQuery(query)), OPTIONS);
    expect(reparsed.filters).toEqual(query.filters);
    expect(reparsed.or).toEqual(query.or);
  });
});
