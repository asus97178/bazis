import { describe, expect, test } from "bun:test";
import { Filterable, ListOptions, ListRequest, Sortable, optionsFromSchema } from "@/library/jsonapi";
import { bindArguments } from "../Binding/ParameterBinder";
import type { ParameterBinding } from "../Binding/bindings";
import { HttpContext, type RouteParams } from "../HttpContext/HttpContext";

@ListOptions({ maxSize: 50 })
class ThingQuery extends ListRequest {
  @Sortable()
  @Filterable("eq", "contains")
  name!: string;

  @Sortable()
  @Filterable("gte", "lte")
  size!: number;
}

const BINDING: ParameterBinding = {
  source: "list",
  model: ThingQuery,
  listOptions: optionsFromSchema(ThingQuery),
};

function ctxFor(qs: string): HttpContext {
  const url = new URL(`http://localhost/things?${qs}`);
  // services scope is unused by the "list" source.
  return new HttpContext(new Request(url.href), url, {} as RouteParams, {} as never);
}

describe("list binding (class-based, generated signatures)", () => {
  test("hydrates a ListRequest instance from the query string", async () => {
    const args = await bindArguments([BINDING], ctxFor("sort=-size&filter[name][contains]=ab&page[size]=10"), {});
    const query = args[0] as ThingQuery;
    expect(query).toBeInstanceOf(ThingQuery);
    expect(query.sort).toEqual([{ field: "size", dir: "desc" }]);
    expect(query.filters).toEqual([{ field: "name", op: "contains", value: "ab" }]);
    expect(query.page.size).toBe(10);
  });

  test("disallowed field -> 400", async () => {
    await expect(bindArguments([BINDING], ctxFor("sort=secret"), {})).rejects.toMatchObject({ status: 400 });
  });

  test("clamps page size to schema maxSize", async () => {
    const args = await bindArguments([BINDING], ctxFor("page[size]=999"), {});
    expect((args[0] as ThingQuery).page.size).toBe(50);
  });
});
