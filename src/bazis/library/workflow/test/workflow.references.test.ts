import { expect, test } from "bun:test";
import { documentReferences, inputReferences, schemaReferenceKinds, type ProcessDocument } from "@/library/workflow";

const schema = {
  type: "object",
  properties: {
    table: { type: "string", "x-ref": "dm.table" },
    field: { type: "string", "x-ref": "dm.field", "x-ref-scope": "/table" },
    values: { type: "object", "x-ref-keys": "dm.field", "x-ref-scope": "/table", properties: { nested: { type: "string", "x-ref": "users.user" } } },
    many: { type: "array", items: { type: "string", "x-ref": "dm.table" } },
    fixed: { type: "object", "x-ref-keys": "orm.field", "x-ref-scope": "Order" },
  },
};

test("literal references are found by the schema, each in its area", () => {
  const found = inputReferences(schema, { table: "orders", field: "status", values: { amount: 1, nested: "u-1" }, many: ["a", "b"], fixed: { status: "new" } });
  expect(found).toEqual([
    { kind: "dm.table", id: "orders", path: "/table" },
    { kind: "dm.field", id: "status", within: "orders", path: "/field" },
    { kind: "dm.field", id: "amount", within: "orders", path: "/values/amount" },
    { kind: "dm.field", id: "nested", within: "orders", path: "/values/nested" },
    { kind: "users.user", id: "u-1", path: "/values/nested" },
    { kind: "dm.table", id: "a", path: "/many/0" },
    { kind: "dm.table", id: "b", path: "/many/1" },
    { kind: "orm.field", id: "status", within: "Order", path: "/fixed/status" },
  ]);
});

test("what is computed when the step runs is left out, and so is what lies in a computed area", () => {
  expect(inputReferences(schema, { table: "$input.table", field: "status", values: { a: 1 } })).toEqual([]);
  expect(inputReferences(schema, { table: { path: "$input.table" } })).toEqual([]);
  expect(inputReferences(schema, { table: "orders", field: { op: "concat", args: ["a"] } })).toEqual([{ kind: "dm.table", id: "orders", path: "/table" }]);
  expect(inputReferences(schema, { table: null, many: [] })).toEqual([]);
  expect(inputReferences(undefined, { table: "orders" })).toEqual([]);
  expect(inputReferences(schema, undefined)).toEqual([]);
});

test("the kinds of a schema are known without values", () => {
  expect(schemaReferenceKinds(schema).sort()).toEqual(["dm.field", "dm.table", "orm.field", "users.user"]);
  expect(schemaReferenceKinds(undefined)).toEqual([]);
});

test("a document holds references in its Tools, variables and calls", () => {
  const document = {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "target", type: "ref", direction: "in", ref: "dm.table", default: "orders" },
      { name: "other", type: "ref", direction: "in", ref: "dm.table" },
    ],
    settings: { errorHandler: "on-error" },
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Step: { kind: "serviceTask", title: "Step", config: { tool: "dm.find", input: { table: "orders" } } },
      Unknown: { kind: "serviceTask", title: "Unknown", config: { tool: "dm.gone", input: { table: "orders" } } },
      Call: { kind: "callProcess", title: "Call", config: { process: "child" } },
      End: { kind: "end", title: "End" },
    },
    flows: {},
  } as unknown as ProcessDocument;
  expect(documentReferences(document, (tool) => (tool === "dm.find" ? schema : undefined))).toEqual([
    { kind: "dm.table", id: "orders", path: "/default", variable: "target" },
    { kind: "workflow.process", id: "on-error", path: "/settings/errorHandler" },
    { kind: "dm.table", id: "orders", path: "/table", node: "Step" },
    { kind: "workflow.process", id: "child", path: "/process", node: "Call" },
  ]);
});
