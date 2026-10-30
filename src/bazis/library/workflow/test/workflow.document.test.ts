import { describe, expect, test } from "bun:test";
import { durationMs, emptyProcess, evaluateCondition, hasErrors, readPath, resolveInput, validateForm, validateProcess } from "@/library/workflow";

const DOCUMENT = {
  schemaVersion: "bazis.workflow/v1",
  input: { fields: [{ code: "amount", type: "number", required: true }] },
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
    c: { source: "Paid", target: "End", condition: { path: "$vars.payment.status", op: "eq", value: "paid" } },
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
    wrong.flows.c = { source: "Paid", target: "End", condition: { path: "$input.total", op: "gt", value: 1 } };
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
    expect(evaluateCondition({ all: [{ path: "$input.amount", op: "gte", value: "100" }, { path: "$input.tags", op: "contains", value: "vip" }] }, data)).toBe(true);
    expect(evaluateCondition({ not: { path: "$vars.payment.status", op: "in", value: ["paid", "refunded"] } }, data)).toBe(false);
    expect(evaluateCondition({ any: [{ path: "$vars.none", op: "notEmpty" }, { path: "$nodes.Pay.id", op: "eq", value: "p-2" }] }, data)).toBe(false);
  });
});

test("forms check types, required and unknown fields", () => {
  const spec = { fields: [{ code: "amount", type: "integer" as const, required: true }, { code: "kind", type: "enum" as const, values: ["a", "b"] }, { code: "on", type: "date" as const }] };
  expect(validateForm(spec, { amount: 3, kind: "a", on: "2026-10-31" })).toEqual({ value: { amount: 3, kind: "a", on: "2026-10-31" }, issues: [] });
  expect(validateForm(spec, { amount: 1.5, kind: "c", extra: 1 }).issues.map((issue) => [issue.field, issue.code])).toEqual([["extra", "unknown"], ["amount", "type"], ["kind", "enum"]]);
  expect(validateForm(spec, {}).issues.map((issue) => issue.code)).toEqual(["required"]);
});

test("durations", () => {
  expect(durationMs("P1DT2H")).toBe(26 * 3_600_000);
  expect(durationMs("PT45S")).toBe(45_000);
  expect(durationMs("P1M")).toBeUndefined();
});
