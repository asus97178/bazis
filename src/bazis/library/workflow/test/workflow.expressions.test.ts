import { describe, expect, test } from "bun:test";
import { checkExpression, EXPRESSION_LIMITS, evaluateExpression, ExpressionSyntaxError, isTruthy, parseExpression, printExpression, type Expr } from "@/library/workflow";

const data = {
  input: { orderId: "o-1", amount: "150.50", tags: ["vip"] },
  vars: { amount: 100, items: [{ id: 1 }, { id: 2 }], name: "  Ann " },
  nodes: { Pay: { id: "p-1" } },
  event: { record: { amount: 200000 } },
  trigger: { via: "event" },
  run: { id: "i-1", partition: "acme" },
  now: "2026-11-01T10:00:00.000Z",
};
const run = (expression: Expr) => evaluateExpression(expression, data);
const call = (op: string, ...args: unknown[]) => ({ op, args }) as Expr;
const vars = (name: string) => ({ path: `$vars.${name}` });

describe("evaluateExpression", () => {
  test("the examples of the format", () => {
    expect(run({ op: "mul", args: [{ path: "$vars.amount" }, 1.2] })).toBe(120);
    expect(run({ op: "concat", args: ["https://api/orders/", { path: "$input.orderId" }] })).toBe("https://api/orders/o-1");
    expect(run({ op: "gt", args: [{ path: "$event.record.amount" }, 100000] })).toBe(true);
  });

  test("arithmetic takes decimal strings; what cannot be computed is null", () => {
    expect(run(call("add", { path: "$input.amount" }, 0.5))).toBe(151);
    expect(run(call("add", 1, 2, 3))).toBe(6);
    expect(run(call("div", 1, 0))).toBeNull();
    expect(run(call("mod", 7, 0))).toBeNull();
    expect(run(call("mul", vars("none"), 2))).toBeNull();
    expect(run(call("round", 2.345, 2))).toBe(2.35);
    expect(run(call("round", 2.5))).toBe(3);
  });

  test("a comparison with a missing value does not hold", () => {
    expect(run(call("gt", vars("none"), 1))).toBe(false);
    expect(run(call("lt", vars("none"), 1))).toBe(false);
    expect(run(call("eq", 1, "1"))).toBe(true);
    expect(run(call("in", "b", ["a", "b"]))).toBe(true);
    expect(run(call("in", "b", "not a list"))).toBe(false);
    expect(run(call("contains", "abc", "b"))).toBe(true);
    expect(run(call("empty", vars("none")))).toBe(true);
    expect(run(call("notEmpty", vars("items")))).toBe(true);
  });

  test("logic", () => {
    expect(run(call("and", true, 1, "x"))).toBe(true);
    expect(run(call("and", true, 0))).toBe(false);
    expect(run(call("or", false, null, []))).toBe(false);
    expect(run(call("not", ""))).toBe(true);
    expect(run(call("if", call("gt", vars("amount"), 50), "big", "small"))).toBe("big");
    expect(run(call("coalesce", vars("none"), null, "x"))).toBe("x");
    expect(run(call("coalesce", vars("none")))).toBeNull();
    expect([isTruthy([]), isTruthy([0]), isTruthy(0), isTruthy("a")]).toEqual([false, true, false, true]);
  });

  test("text", () => {
    expect(run(call("concat", "a", 1, null, true))).toBe("a1true");
    expect(run(call("lower", "AB"))).toBe("ab");
    expect(run(call("upper", "ab"))).toBe("AB");
    expect(run(call("trim", vars("name")))).toBe("Ann");
    expect(run(call("lower", 1))).toBeNull();
    expect(run(call("length", "abc"))).toBe(3);
    expect(run(call("length", vars("items")))).toBe(2);
    expect(run(call("length", vars("none")))).toBe(0);
    expect(run(call("format", "{0} of {1}, {2}", 1, 2))).toBe("1 of 2, {2}");
  });

  test("dates take the time of the engine", () => {
    expect(run(call("now"))).toBe("2026-11-01T10:00:00.000Z");
    expect(run({ path: "$now" })).toBe("2026-11-01T10:00:00.000Z");
    expect(run(call("dateAdd", { path: "$now" }, "P1D"))).toBe("2026-11-02T10:00:00.000Z");
    expect(run(call("dateAdd", "not a date", "P1D"))).toBeNull();
    expect(run(call("dateDiff", "2026-11-03", "2026-11-01", "days"))).toBe(2);
    expect(run(call("dateDiff", "2026-11-01T00:00:01Z", "2026-11-01T00:00:00Z"))).toBe(1000);
    expect(run(call("toDate", "2026-11-01"))).toBe("2026-11-01T00:00:00.000Z");
    expect(run(call("toDate", "soon"))).toBeNull();
  });

  test("lists, and only own keys are read", () => {
    expect(run(call("first", vars("items")))).toEqual({ id: 1 });
    expect(run(call("first", []))).toBeNull();
    expect(run(call("pluck", vars("items"), "id"))).toEqual([1, 2]);
    expect(run(call("pluck", vars("items"), "constructor"))).toEqual([null, null]);
    expect(run({ path: "$vars.__proto__" })).toBeUndefined();
  });

  test("paths read the run", () => {
    expect(run({ path: "$run.partition" })).toBe("acme");
    expect(run({ path: "$trigger.via" })).toBe("event");
    expect(run({ path: "$event" })).toEqual({ record: { amount: 200000 } });
    expect(run({ path: "$nodes.Pay.id" })).toBe("p-1");
  });

  test("an object without op or path is a literal", () => {
    expect(run({ a: { path: "$vars.amount" } })).toEqual({ a: { path: "$vars.amount" } });
    expect(run([{ path: "$vars.amount" }])).toEqual([{ path: "$vars.amount" }]);
  });
});

describe("checkExpression", () => {
  const scope = { input: new Set(["orderId"]), vars: new Set(["amount"]), nodes: new Set(["Pay"]) };

  test("what is right passes", () => {
    for (const good of [1, "text", null, true, [1, 2], { a: 1 }, { path: "$now" }, { path: "$event.a.b" }, { path: "$run.id" }, { path: "$trigger" }, call("now"), call("round", 1), call("add", 1, 2, 3), call("dateAdd", { path: "$now" }, "PT1H"), call("mul", { path: "$vars.amount" }, 2)]) {
      expect(checkExpression(good, scope)).toBeNull();
    }
  });

  test("functions, their arguments and their types", () => {
    expect(checkExpression(call("eval", "x"))).toContain("unknown function");
    expect(checkExpression({ op: "add" })).toContain("args must be a list");
    expect(checkExpression({ op: "add", args: [1, 2], extra: 1 })).toContain("only the keys");
    expect(checkExpression(call("add", 1))).toContain("at least 2");
    expect(checkExpression(call("sub", 1, 2, 3))).toContain("at most 2");
    expect(checkExpression(call("mul", "a", 2))).toContain("must be number");
    expect(checkExpression(call("mul", call("concat", "a"), 2))).toContain("must be number");
    expect(checkExpression(call("in", 1, 2))).toContain("must be list");
    expect(checkExpression(call("dateAdd", { path: "$now" }, "P1M"))).toContain("ISO duration");
    expect(checkExpression(call("dateDiff", { path: "$now" }, { path: "$now" }, "weeks"))).toContain("the unit");
  });

  test("paths are checked against the document", () => {
    expect(checkExpression({ path: "$input.total" }, scope)).toContain("no field total");
    expect(checkExpression({ path: "$vars.none" }, scope)).toContain("no variable none");
    expect(checkExpression({ path: "$nodes.Nope.x" }, scope)).toContain("no node Nope");
    expect(checkExpression({ path: "$nodes" }, scope)).toContain("needs a node");
    expect(checkExpression({ path: "$now.x" }, scope)).toContain("no fields");
    expect(checkExpression({ path: "amount" }, scope)).toContain("must look like");
    expect(checkExpression({ path: "$secrets.TOKEN" }, scope)).toContain("must look like");
    expect(checkExpression({ path: "$vars.amount", extra: 1 }, scope)).toContain("only the key");
  });

  test("limits", () => {
    let deep: Expr = 1;
    for (let index = 0; index <= EXPRESSION_LIMITS.depth; index += 1) deep = call("not", deep);
    expect(checkExpression(deep)).toContain("deeper");
    expect(checkExpression(call("add", ...new Array(EXPRESSION_LIMITS.nodes + 1).fill(1)))).toContain("more than");
  });
});

describe("the text of an expression", () => {
  test("the examples of the format", () => {
    expect(parseExpression("{amount} * 1.2")).toEqual({ op: "mul", args: [{ path: "$vars.amount" }, 1.2] });
    expect(parseExpression('concat({a}, "-", {b})')).toEqual({ op: "concat", args: [{ path: "$vars.a" }, "-", { path: "$vars.b" }] });
    expect(parseExpression("now()")).toEqual({ op: "now", args: [] });
    expect(parseExpression("{$input.orderId}")).toEqual({ path: "$input.orderId" });
    expect(parseExpression("{order.total}")).toEqual({ path: "$vars.order.total" });
  });

  test("precedence and brackets", () => {
    expect(parseExpression("1 + 2 * 3")).toEqual(call("add", 1, call("mul", 2, 3)));
    expect(parseExpression("(1 + 2) * 3")).toEqual(call("mul", call("add", 1, 2), 3));
    expect(parseExpression("1 - 2 - 3")).toEqual(call("sub", call("sub", 1, 2), 3));
    expect(parseExpression("{a} > 1 and {b} < 2 or not {c}")).toEqual(call("or", call("and", call("gt", vars("a"), 1), call("lt", vars("b"), 2)), call("not", vars("c"))));
    expect(parseExpression("-{a}")).toEqual(call("sub", 0, vars("a")));
    expect(parseExpression("-1.5")).toBe(-1.5);
    expect(parseExpression("{order} == 1")).toEqual(call("eq", vars("order"), 1));
  });

  test("literals", () => {
    expect(parseExpression("true")).toBe(true);
    expect(parseExpression("null")).toBeNull();
    expect(parseExpression('"a\\"b"')).toBe('a"b');
    expect(parseExpression('[1, "a", null]')).toEqual([1, "a", null]);
    expect(parseExpression('{"a": [1, {"b": 2}]}')).toEqual({ a: [1, { b: 2 }] });
    expect(parseExpression("{}")).toEqual({});
  });

  test("errors name the place", () => {
    const bad: readonly (readonly [string, string])[] = [
      ["", "ends too early"],
      ["1 +", "ends too early"],
      ["(1", "expected )"],
      ["1 2", "unexpected"],
      ["amount * 2", "written {amount}"],
      ["eval(1)", "unknown function"],
      ["concat(1 2)", "expected , or )"],
      ["{a", "no closing }"],
      ["{a b}", "not a path"],
      ['"abc', "no closing quote"],
      ["[{a}]", "are not expressions"],
      ["[1, 2", "expected ]"],
      ["1 < 2 < 3", "do not chain"],
    ];
    for (const [text, message] of bad) {
      expect(() => parseExpression(text)).toThrow(ExpressionSyntaxError);
      expect(() => parseExpression(text)).toThrow(message);
    }
  });

  test("printing can be read back", () => {
    const trees: Expr[] = [
      1, -1.5, "a\"b", null, true, [1, "a"], { a: 1 }, {},
      vars("amount"), { path: "$vars.a.b" }, { path: "$input.x" }, { path: "$now" },
      call("mul", vars("amount"), 1.2),
      call("add", 1, 2, 3),
      call("sub", 1, call("sub", 2, 3)),
      call("sub", call("sub", 1, 2), 3),
      call("mul", call("add", 1, 2), 3),
      call("add", call("mul", 2, 3), 1),
      call("and", 1),
      call("and", 1, 2, 3),
      call("or", call("and", 1, 2), call("and", 3, 4)),
      call("and", call("or", 1, 2), 3),
      call("eq", call("eq", 1, 2), 3),
      call("eq", 1, call("eq", 2, 3)),
      call("not", call("and", 1, 2)),
      call("not", call("not", 1)),
      call("gt", call("not", 1), 2),
      call("concat", "a", call("add", 1, 2)),
      call("now"),
      call("if", call("gt", vars("a"), 1), "x", "y"),
    ];
    for (const tree of trees) expect(parseExpression(printExpression(tree))).toEqual(tree);
    expect(printExpression(call("mul", vars("amount"), 1.2))).toBe("{amount} * 1.2");
    expect(printExpression(call("mul", call("add", 1, 2), 3))).toBe("(1 + 2) * 3");
  });
});
