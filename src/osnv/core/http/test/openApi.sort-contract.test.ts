import { registerGeneratedBindings } from "../Binding/autoBindings";
import { describe, expect, test } from "bun:test";
import { ApiVersion, Controller, Get } from "../index";
import { ListRequest, Sortable, optionsFromSchema, parseListQuery } from "../../../library/jsonapi";
import { buildHttpOpenApiDocument } from "../OpenApi/openApiDocument";
import { projectOpenApiByOperationIds } from "../../../library/openapi";

class SortQuery extends ListRequest {
  @Sortable() name!: string;
  @Sortable() age!: number;
  @Sortable() createdAt!: Date;
  id!: number;
  email!: string;
}

class PriorityQuery extends ListRequest { @Sortable() priority!: number; }
class EmptyQuery extends ListRequest {}
class SortV1Query extends ListRequest { @Sortable() name!: string; @Sortable() age!: number; }
class SortV2Query extends ListRequest { @Sortable() name!: string; @Sortable() createdAt!: Date; }

@Controller("sort-contract")
class SortController {
  @Get("typed")
  typed(_query: SortQuery): object { return {}; }

  @Get("priority")
  priority(_query: PriorityQuery): object { return {}; }

  @Get("none")
  none(_query: EmptyQuery): object { return {}; }
}

@ApiVersion("1")
@Controller("versioned-sort")
class SortV1Controller {
  @Get()
  getAll(_query: SortV1Query): object { return {}; }
}

@ApiVersion("2")
@Controller("versioned-sort")
class SortV2Controller {
  @Get()
  getAll(_query: SortV2Query): object { return {}; }
}

registerGeneratedBindings(SortController, { typed: [{ source: "list", model: "SortQuery" }], priority: [{ source: "list", model: "PriorityQuery" }], none: [{ source: "list", model: "EmptyQuery" }] }, new Map<string, new () => object>([["SortQuery", SortQuery], ["PriorityQuery", PriorityQuery], ["EmptyQuery", EmptyQuery]]));
registerGeneratedBindings(SortV1Controller, { getAll: [{ source: "list", model: "SortV1Query" }] }, new Map([["SortV1Query", SortV1Query]]));
registerGeneratedBindings(SortV2Controller, { getAll: [{ source: "list", model: "SortV2Query" }] }, new Map([["SortV2Query", SortV2Query]]));

function document(controllers = [SortController]) {
  return buildHttpOpenApiDocument({ controllers, title: "Sort contract", version: "1" });
}

function operation(doc: ReturnType<typeof document>, path: string) {
  return (doc.paths as Record<string, { get: { operationId: string; parameters: Record<string, unknown>[] } }>)[path]!.get;
}

function fields(doc: ReturnType<typeof document>, path: string): unknown {
  return operation(doc, path).parameters.find((parameter) => parameter.name === "sort")?.["x-osnv-sort-fields"];
}

describe("OpenAPI list sort contract", () => {
  test("publishes declared fields rather than response columns and every option is accepted", () => {
    const allowed = fields(document(), "/sort-contract/typed") as string[];
    expect(allowed).toEqual(["name", "age", "createdAt"]);
    for (const field of allowed) {
      for (const value of [field, `-${field}`]) {
        expect(() => parseListQuery(new URLSearchParams({ sort: value }), optionsFromSchema(SortQuery))).not.toThrow();
      }
    }
    expect(() => parseListQuery(new URLSearchParams({ sort: "email" }), optionsFromSchema(SortQuery))).toThrow();
    expect(() => parseListQuery(new URLSearchParams({ sort: "id" }), optionsFromSchema(SortQuery))).toThrow();
  });

  test("handles generated class bindings and a route without sortable fields", () => {
    expect(fields(document(), "/sort-contract/priority")).toEqual(["priority"]);
    expect(fields(document(), "/sort-contract/none")).toEqual([]);
    expect(operation(document(), "/sort-contract/typed").parameters.find((p) => p.name === "sort")?.schema).toEqual({ type: "string" });
  });

  test("preserves the whitelist in protected UI document projection", () => {
    const full = document();
    const projected = projectOpenApiByOperationIds(full, [operation(full, "/sort-contract/typed").operationId]);
    expect(fields(projected, "/sort-contract/typed")).toEqual(["name", "age", "createdAt"]);
  });

  test("a merged versioned operation only advertises fields accepted by every version", () => {
    const doc = buildHttpOpenApiDocument({
      controllers: [SortV1Controller, SortV2Controller], title: "Versioned sort", version: "1",
      versioning: { source: "query", parameterName: "v" },
    });
    expect(fields(doc, "/versioned-sort")).toEqual(["name"]);
  });
});
