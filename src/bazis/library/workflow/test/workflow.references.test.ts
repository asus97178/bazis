import { expect, test } from "bun:test";
import { documentReferences, inputReferences, resolveInput, schemaReferenceKinds, secretNames, validateProcess, type ProcessDocument } from "@/library/workflow";

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

test("the secrets of an input are found at any depth, and resolved only for it", () => {
  const input = { a: "$secrets.ONE", b: { c: ["$secrets.TWO"], d: { op: "concat", args: ["x", { path: "$secrets.THREE" }] } }, e: "$secrets.ONE", f: "not $secrets.FOUR" };
  expect(secretNames(input).sort()).toEqual(["ONE", "THREE", "TWO"]);
  const data = { input: {}, vars: {}, nodes: {}, secrets: { ONE: "1", TWO: "2", THREE: "3" } };
  expect(resolveInput(input, data)).toEqual({ a: "1", b: { c: ["2"], d: "x3" }, e: "1", f: "not $secrets.FOUR" });
});

test("a secret is refused wherever it could be kept", () => {
  const document = (nodes: Record<string, unknown>, flows: Record<string, unknown>) => ({ schemaVersion: "bazis.workflow/v2", nodes: { Start: { kind: "manualStart", title: "Start" }, ...nodes, End: { kind: "end", title: "End" } }, flows });
  const line = (node: unknown) => document({ Step: node }, { a: { source: "Start", target: "Step" }, b: { source: "Step", target: "End" } });
  const messages = (node: unknown) => validateProcess(line(node)).filter((issue) => issue.severity === "error").map((issue) => issue.message);
  expect(messages({ kind: "serviceTask", title: "T", config: { tool: "a.b", input: { token: "$secrets.TOKEN" } } })).toEqual([]);
  expect(messages({ kind: "assign", title: "T", config: { assignments: [{ var: "x", value: { path: "$secrets.TOKEN" } }] } }).join()).toContain("only in the input of a Tool");
  expect(messages({ kind: "callProcess", title: "T", config: { process: "other", input: { token: "$secrets.TOKEN" } } })[0]).toContain("only in the input of a Tool");
  expect(messages({ kind: "eventWait", title: "T", config: { event: "a.b", correlation: "$secrets.TOKEN" } })[0]).toContain("only in the input of a Tool");
  expect(messages({ kind: "timerCatch", title: "T", config: { at: "$secrets.TOKEN" } })[0]).toContain("only in the input of a Tool");
  expect(messages({ kind: "eventWait", title: "T", config: { event: "a.b", until: { path: "$secrets.TOKEN" } } })[0]).toContain("only in the input of a Tool");
});
