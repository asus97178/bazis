import { describe, expect, test } from "bun:test";
import {
  Filterable,
  ListOptions,
  ListRequest,
  Sortable,
  optionsFromSchema,
  parseListQuery,
} from "@/library/jsonapi";

@ListOptions({ defaultSize: 10, maxSize: 50, include: ["posts"] })
class UserQuery extends ListRequest {
  @Sortable()
  @Filterable("eq", "contains")
  name!: string;

  @Filterable("eq")
  email!: string;

  @Sortable()
  @Filterable("gte", "lte", "in")
  age!: number;
}

describe("optionsFromSchema", () => {
  test("derives sort whitelist from @Sortable", () => {
    expect(optionsFromSchema(UserQuery).sort).toEqual(["name", "age"]);
  });

  test("derives filter whitelist + operators from @Filterable", () => {
    expect(optionsFromSchema(UserQuery).filter).toEqual({
      name: ["eq", "contains"],
      email: ["eq"],
      age: ["gte", "lte", "in"],
    });
  });

  test("reads page limits and include from @ListOptions", () => {
    const options = optionsFromSchema(UserQuery);
    expect(options.page).toEqual({ defaultSize: 10, maxSize: 50 });
    expect(options.include).toEqual(["posts"]);
  });

  test("empty schema for a class without decorators", () => {
    class Bare extends ListRequest {}
    expect(optionsFromSchema(Bare)).toEqual({});
  });
});

describe("ListRequest schema drives parseListQuery", () => {
  test("allowed fields pass, disallowed fields are rejected", () => {
    const options = optionsFromSchema(UserQuery);
    const query = parseListQuery(new URLSearchParams("sort=name&filter[age][gte]=18&page[size]=999"), options);

    expect(query.sort).toEqual([{ field: "name", dir: "asc" }]);
    expect(query.filters).toEqual([{ field: "age", op: "gte", value: "18" }]);
    expect(query.page.size).toBe(50); // clamped to maxSize from @ListOptions

    expect(() => parseListQuery(new URLSearchParams("sort=secret"), options)).toThrow();
    expect(() => parseListQuery(new URLSearchParams("filter[name][gte]=1"), options)).toThrow();
  });
});

describe("schema inheritance (copy-on-write)", () => {
  test("subclass extends parent's allowed fields without mutating it", () => {
    class Extended extends UserQuery {
      @Sortable()
      createdAt!: Date;
    }
    expect(optionsFromSchema(Extended).sort).toEqual(["name", "age", "createdAt"]);
    // parent unchanged
    expect(optionsFromSchema(UserQuery).sort).toEqual(["name", "age"]);
  });
});
