import { expect, test } from "bun:test";
import { HttpSetupError } from "../Errors/HttpError";
import { registerGeneratedBindings, resolveGeneratedBindings } from "../Binding/autoBindings";
import { registerRequestModelShape } from "../Binding/requestModelRegistry";
import { FromHeader, FromQuery } from "../Binding/sources";

// 0.101.0: a query or header model that cannot be bound from flat strings
// stops the start, before the first request, instead of yielding undefined.

class Address { city = ""; }
class Controller { }

function resolve(spec: { source: "queryModel" | "headerModel"; model: string }, model: new () => object): () => unknown {
  registerGeneratedBindings(Controller, { action: [spec] }, new Map([[spec.model, model]]));
  return () => resolveGeneratedBindings(Controller, "action");
}

test("a nested object in a query model is a setup error", () => {
  class NestedQuery { address?: Address; }
  registerRequestModelShape(NestedQuery, { address: { model: Address } });
  const run = resolve({ source: "queryModel", model: "NestedQuery" }, NestedQuery);
  expect(run).toThrow(HttpSetupError);
  expect(run).toThrow('Controller.action: query model "NestedQuery" field "address" is an object; query models take string, number, boolean and arrays of them.');
});

test("an array in a header model is a setup error", () => {
  class ListHeaders { tags: string[] = []; }
  registerRequestModelShape(ListHeaders, { tags: { primitive: "string", array: true } });
  expect(resolve({ source: "headerModel", model: "ListHeaders" }, ListHeaders))
    .toThrow('Controller.action: header model "ListHeaders" field "tags" is an array; a header model field takes one value.');
});

test("two fields on one wire name are a setup error", () => {
  class ClashQuery {
    @FromQuery("size") pageSize = 1;
    size = 2;
  }
  expect(resolve({ source: "queryModel", model: "ClashQuery" }, ClashQuery))
    .toThrow('Controller.action: query model "ClashQuery" binds "size" to both');
});

test("decorators refuse names that cannot be on the wire", () => {
  expect(() => { class BadHeader { @FromHeader("x tenant") tenant = ""; } return BadHeader; }).toThrow('@FromHeader: invalid name "x tenant".');
  expect(() => { class EmptyQuery { @FromQuery("") page = 1; } return EmptyQuery; }).toThrow('@FromQuery: invalid name "".');
  expect(() => {
    class TwoFields { @FromQuery("page") first = 1; @FromQuery("page") second = 2; }
    return TwoFields;
  }).toThrow('@FromQuery: "page" is used by both "first" and "second".');
});

test("header names are stored lower-case, query names as written", () => {
  class Mixed { @FromHeader("X-Tenant-Id") tenantId = ""; }
  class Query { @FromQuery("Page_Size") pageSize = 1; }
  registerRequestModelShape(Mixed, { tenantId: { primitive: "string" } });
  const headers = resolve({ source: "headerModel", model: "Mixed" }, Mixed)() as { fields: { wire: string }[] }[];
  expect(headers[0]!.fields.map((field) => field.wire)).toEqual(["x-tenant-id"]);
  const query = resolve({ source: "queryModel", model: "Query" }, Query)() as { fields: { wire: string }[] }[];
  expect(query[0]!.fields.map((field) => field.wire)).toEqual(["Page_Size"]);
});
