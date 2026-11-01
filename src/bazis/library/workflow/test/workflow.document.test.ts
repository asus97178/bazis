import { describe, expect, test } from "bun:test";
import { durationMs, emptyProcess, evaluateExpression, hasErrors, parseCron, readPath, resolveInput, validateForm, validateProcess, type Expr } from "@/library/workflow";

const DOCUMENT = {
  schemaVersion: "bazis.workflow/v2",
  variables: [{ name: "amount", type: "number", direction: "in", required: true }],
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Pay: { kind: "serviceTask", title: "Pay", config: { tool: "payments.charge", input: { amount: "$input.amount" }, saveTo: "payment", retry: { maxAttempts: 3, backoff: "PT1M" } } },
    Paid: { kind: "exclusiveGateway", title: "Paid?" },
    Review: { kind: "userTask", title: "Review", config: { assignee: { role: "support" } } },
    End: { kind: "end", title: "End" },
  },
  flows: {
    a: { source: "Start", target: "Pay" },
    b: { source: "Pay", target: "Paid" },
    c: { source: "Paid", target: "End", condition: { op: "eq", args: [{ path: "$vars.payment.status" }, "paid"] } },
    d: { source: "Paid", target: "Review", isDefault: true },
    e: { source: "Review", target: "End" },
  },
};

describe("validateProcess", () => {
  test("a valid document has no findings; a new one is valid too", () => {
    expect(validateProcess(DOCUMENT, { tools: (name) => name === "payments.charge" })).toEqual([]);
    expect(validateProcess(emptyProcess())).toEqual([]);
  });

  test("a Tool processes may not call is an error on its node", () => {
    const issues = validateProcess(DOCUMENT, { tools: () => false });
    expect(issues).toEqual([expect.objectContaining({ severity: "error", code: "unknown_tool", node: "Pay" })]);
    expect(hasErrors(issues)).toBe(true);
  });

  test("every graph problem is reported at once", () => {
    const broken = structuredClone(DOCUMENT) as unknown as { nodes: Record<string, unknown>; flows: Record<string, unknown> };
    delete broken.nodes.Start;
    broken.flows.c = { source: "Paid", target: "End" };
    broken.nodes.Lost = { kind: "end", title: "Lost" };
    const codes = validateProcess(broken).map((issue) => issue.code);
    expect(codes).toContain("no_start");
    expect(codes).toContain("flow_dangling");
    expect(codes).toContain("condition_missing");
    expect(codes).toContain("end_incoming");
  });

  test("node configs are checked", () => {
    const wrong = structuredClone(DOCUMENT) as unknown as { nodes: Record<string, { config?: unknown }> };
    wrong.nodes.Pay!.config = { tool: "payments.charge", retry: { maxAttempts: 50 } };
    wrong.nodes.Review!.config = { assignee: { role: "support", user: "u-1" } };
    expect(validateProcess(wrong).filter((issue) => issue.code === "config_invalid").map((issue) => [issue.node, issue.message])).toEqual([
      ["Pay", "config.retry.maxAttempts must be 1–10"],
      ["Review", "config.assignee needs exactly one of role or user"],
    ]);
  });

  test("a condition may read only declared input fields and existing nodes", () => {
    const wrong = structuredClone(DOCUMENT) as unknown as { flows: Record<string, unknown> };
    wrong.flows.c = { source: "Paid", target: "End", condition: { op: "gt", args: [{ path: "$input.total" }, 1] } };
    expect(validateProcess(wrong)).toEqual([expect.objectContaining({ code: "condition_invalid", flow: "c" })]);
  });
});

describe("instance data", () => {
  const data = { input: { amount: 150, tags: ["vip"] }, vars: { payment: { status: "paid" } }, nodes: { Pay: { id: "p-1" } } };

  test("paths read own keys only", () => {
    expect(readPath(data, "$vars.payment.status")).toBe("paid");
    expect(readPath(data, "$input.__proto__")).toBeUndefined();
    expect(readPath(data, "$input.constructor")).toBeUndefined();
    expect(resolveInput({ amount: "$input.amount", ref: ["$nodes.Pay.id", "literal"], missing: "$vars.none" }, data)).toEqual({ amount: 150, ref: ["p-1", "literal"], missing: null });
  });

  test("conditions", () => {
    const run = (expression: Expr) => evaluateExpression(expression, data);
    expect(run({ op: "and", args: [{ op: "gte", args: [{ path: "$input.amount" }, "100"] }, { op: "contains", args: [{ path: "$input.tags" }, "vip"] }] })).toBe(true);
    expect(run({ op: "not", args: [{ op: "in", args: [{ path: "$vars.payment.status" }, ["paid", "refunded"]] }] })).toBe(false);
    expect(run({ op: "or", args: [{ op: "notEmpty", args: [{ path: "$vars.none" }] }, { op: "eq", args: [{ path: "$nodes.Pay.id" }, "p-2"] }] })).toBe(false);
  });

  test("a step input takes paths, expressions and literals", () => {
    expect(resolveInput({ total: { op: "mul", args: [{ path: "$input.amount" }, 2] }, status: { path: "$vars.payment.status" }, literal: { a: 1 } }, data)).toEqual({ total: 300, status: "paid", literal: { a: 1 } });
  });
});

test("forms check types, required and unknown fields", () => {
  const spec = { fields: [{ name: "amount", type: "integer" as const, required: true }, { name: "kind", type: "enum" as const, values: ["a", "b"] }, { name: "on", type: "date" as const }] };
  expect(validateForm(spec, { amount: 3, kind: "a", on: "2026-10-31" })).toEqual({ value: { amount: 3, kind: "a", on: "2026-10-31" }, issues: [] });
  expect(validateForm(spec, { amount: 1.5, kind: "c", extra: 1 }).issues.map((issue) => [issue.field, issue.code])).toEqual([["extra", "unknown"], ["amount", "type"], ["kind", "enum"]]);
  expect(validateForm(spec, {}).issues.map((issue) => issue.code)).toEqual(["required"]);
});

test("durations", () => {
  expect(durationMs("P1DT2H")).toBe(26 * 3_600_000);
  expect(durationMs("PT45S")).toBe(45_000);
  expect(durationMs("P1M")).toBeUndefined();
});

test("cron: next and matches in UTC", () => {
  const at = (iso: string) => new Date(iso);
  expect(parseCron("*/15 9-17 * * 1-5")!.next(at("2026-10-30T17:50:00Z"))?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
  expect(parseCron("0 0 1 * *")!.next(at("2026-12-15T00:00:00Z"))?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  expect(parseCron("30 8 13 * 5")!.next(at("2026-11-01T00:00:00Z"))?.toISOString()).toBe("2026-11-06T08:30:00.000Z");
  expect(parseCron("0 12 * * 7")!.matches(at("2026-11-01T12:00:00Z"))).toBe(true);
  expect(parseCron("0 0 30 2 *")!.next(at("2026-01-01T00:00:00Z"))).toBeUndefined();
  for (const bad of ["* * * *", "60 * * * *", "* * 0 * *", "5-1 * * * *", "*/0 * * * *", "a * * * *"]) expect(parseCron(bad)).toBeUndefined();
});
