import { durationMs } from "./duration";
import { DATA_PATH, readPath, type InstanceData } from "./paths";

export interface ExprPath {
  readonly path: string;
}

export interface ExprCall {
  readonly op: ExprFunctionName;
  readonly args: readonly Expr[];
}

/**
 * An expression: a JSON tree run without `eval`. A leaf is a JSON literal or a
 * `{ path }`; an object with `op` is a call of a function of a closed list.
 *
 * ```json
 * { "op": "mul", "args": [{ "path": "$vars.amount" }, 1.2] }
 * ```
 */
export type Expr = string | number | boolean | null | readonly unknown[] | ExprPath | ExprCall | { readonly [key: string]: unknown };

/** What a function takes and gives. `date` is an ISO string, `any` takes everything. */
export type ExprType = "any" | "number" | "string" | "boolean" | "date" | "list";

export type ExprFunctionName =
  | "add" | "sub" | "mul" | "div" | "mod" | "round"
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "empty" | "notEmpty"
  | "and" | "or" | "not" | "if" | "coalesce"
  | "concat" | "lower" | "upper" | "trim" | "length" | "format"
  | "now" | "dateAdd" | "dateDiff" | "toDate"
  | "first" | "pluck";

export interface ExprFunction {
  readonly name: ExprFunctionName;
  readonly group: "arithmetic" | "comparison" | "logic" | "text" | "date" | "list";
  /** The types of the positional arguments. */
  readonly args: readonly ExprType[];
  /** How many of the last `args` may be left out. */
  readonly optional?: number;
  /** The type of any further arguments: the function takes as many as given. */
  readonly rest?: ExprType;
  readonly returns: ExprType;
}

const fn = (name: ExprFunctionName, group: ExprFunction["group"], args: readonly ExprType[], returns: ExprType, more: Pick<ExprFunction, "optional" | "rest"> = {}): ExprFunction => ({ name, group, args, returns, ...more });

/** The closed list of functions, also for a designer. A new function comes with a new minor version of the format. */
export const EXPRESSION_FUNCTIONS: readonly ExprFunction[] = Object.freeze([
  fn("add", "arithmetic", ["number", "number"], "number", { rest: "number" }),
  fn("sub", "arithmetic", ["number", "number"], "number"),
  fn("mul", "arithmetic", ["number", "number"], "number", { rest: "number" }),
  fn("div", "arithmetic", ["number", "number"], "number"),
  fn("mod", "arithmetic", ["number", "number"], "number"),
  fn("round", "arithmetic", ["number", "number"], "number", { optional: 1 }),
  fn("eq", "comparison", ["any", "any"], "boolean"),
  fn("ne", "comparison", ["any", "any"], "boolean"),
  fn("gt", "comparison", ["any", "any"], "boolean"),
  fn("gte", "comparison", ["any", "any"], "boolean"),
  fn("lt", "comparison", ["any", "any"], "boolean"),
  fn("lte", "comparison", ["any", "any"], "boolean"),
  fn("in", "comparison", ["any", "list"], "boolean"),
  fn("contains", "comparison", ["any", "any"], "boolean"),
  fn("empty", "comparison", ["any"], "boolean"),
  fn("notEmpty", "comparison", ["any"], "boolean"),
  fn("and", "logic", ["any"], "boolean", { rest: "any" }),
  fn("or", "logic", ["any"], "boolean", { rest: "any" }),
  fn("not", "logic", ["any"], "boolean"),
  fn("if", "logic", ["any", "any", "any"], "any"),
  fn("coalesce", "logic", ["any"], "any", { rest: "any" }),
  fn("concat", "text", ["any"], "string", { rest: "any" }),
  fn("lower", "text", ["string"], "string"),
  fn("upper", "text", ["string"], "string"),
  fn("trim", "text", ["string"], "string"),
  fn("length", "text", ["any"], "number"),
  fn("format", "text", ["string"], "string", { rest: "any" }),
  fn("now", "date", [], "date"),
  fn("dateAdd", "date", ["date", "string"], "date"),
  fn("dateDiff", "date", ["date", "date", "string"], "number", { optional: 1 }),
  fn("toDate", "date", ["any"], "date"),
  fn("first", "list", ["list"], "any"),
  fn("pluck", "list", ["list", "string"], "list"),
] satisfies ExprFunction[]);

const FUNCTIONS = new Map(EXPRESSION_FUNCTIONS.map((definition) => [definition.name as string, definition]));

export const EXPRESSION_LIMITS = Object.freeze({ depth: 16, nodes: 200 });

const DIFF_UNITS: Readonly<Record<string, number>> = { ms: 1, seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** The function by name; `undefined` outside the closed list. */
export function expressionFunction(name: unknown): ExprFunction | undefined {
  return typeof name === "string" ? FUNCTIONS.get(name) : undefined;
}

/** `true` for an object an expression reads as a call or a path; any other object is a literal. */
export function isExpressionNode(value: unknown): value is ExprPath | ExprCall {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.hasOwn(value, "op") || Object.hasOwn(value, "path"));
}

/**
 * The value of an expression. It never throws: what cannot be computed (a
 * missing value in arithmetic, division by zero, a bad date) is `null`, and a
 * comparison with `null` is false, so a condition on missing data does not hold.
 */
export function evaluateExpression(expression: Expr, data: InstanceData): unknown {
  if (!isExpressionNode(expression)) return expression;
  if ("path" in expression) return readPath(data, expression.path);
  return call(expression, data);
}

/** How a value counts as a condition: `null`, `false`, `0`, an empty string and an empty list do not hold. */
export function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function call({ op, args }: ExprCall, data: InstanceData): unknown {
  const value = (index: number) => (index < args.length ? evaluateExpression(args[index]!, data) : undefined);
  const values = () => args.map((arg) => evaluateExpression(arg, data));
  switch (op) {
    case "add": return arithmetic(values(), (a, b) => a + b);
    case "sub": return arithmetic(values(), (a, b) => a - b);
    case "mul": return arithmetic(values(), (a, b) => a * b);
    case "div": return arithmetic(values(), (a, b) => (b === 0 ? Number.NaN : a / b));
    case "mod": return arithmetic(values(), (a, b) => (b === 0 ? Number.NaN : a % b));
    case "round": {
      const number = numeric(value(0));
      const digits = args.length > 1 ? numeric(value(1)) : 0;
      if (number === null || digits === null) return null;
      const scale = 10 ** Math.trunc(digits);
      return Math.round(number * scale) / scale;
    }
    case "eq": return same(value(0), value(1));
    case "ne": return !same(value(0), value(1));
    case "gt": return compare(value(0), value(1), (a, b) => a > b);
    case "gte": return compare(value(0), value(1), (a, b) => a >= b);
    case "lt": return compare(value(0), value(1), (a, b) => a < b);
    case "lte": return compare(value(0), value(1), (a, b) => a <= b);
    case "in": {
      const list = value(1);
      const item = value(0);
      return Array.isArray(list) && list.some((other) => same(item, other));
    }
    case "contains": {
      const whole = value(0);
      const part = value(1);
      if (typeof whole === "string") return typeof part === "string" && whole.includes(part);
      return Array.isArray(whole) && whole.some((item) => same(item, part));
    }
    case "empty": return isEmpty(value(0));
    case "notEmpty": return !isEmpty(value(0));
    case "and": return args.every((arg) => isTruthy(evaluateExpression(arg, data)));
    case "or": return args.some((arg) => isTruthy(evaluateExpression(arg, data)));
    case "not": return !isTruthy(value(0));
    case "if": return isTruthy(value(0)) ? value(1) : value(2);
    case "coalesce":
      for (const arg of args) {
        const item = evaluateExpression(arg, data);
        if (item !== null && item !== undefined) return item;
      }
      return null;
    case "concat": return values().map(textOfValue).join("");
    case "lower": return mapText(value(0), (text) => text.toLowerCase());
    case "upper": return mapText(value(0), (text) => text.toUpperCase());
    case "trim": return mapText(value(0), (text) => text.trim());
    case "length": {
      const item = value(0);
      return typeof item === "string" || Array.isArray(item) ? item.length : 0;
    }
    case "format": {
      const template = value(0);
      if (typeof template !== "string") return null;
      const items = values().slice(1);
      return template.replace(/\{(\d+)\}/g, (whole, index: string) => (Number(index) < items.length ? textOfValue(items[Number(index)]) : whole));
    }
    case "now": return data.now ?? null;
    case "dateAdd": {
      const date = timeOf(value(0));
      const by = value(1);
      const ms = typeof by === "string" ? durationMs(by) : undefined;
      return date === null || ms === undefined ? null : new Date(date + ms).toISOString();
    }
    case "dateDiff": {
      const end = timeOf(value(0));
      const start = timeOf(value(1));
      const unit = DIFF_UNITS[args.length > 2 ? String(value(2)) : "ms"];
      return end === null || start === null || unit === undefined ? null : (end - start) / unit;
    }
    case "toDate": {
      const time = timeOf(value(0));
      return time === null ? null : new Date(time).toISOString();
    }
    case "first": {
      const list = value(0);
      return Array.isArray(list) ? list[0] ?? null : null;
    }
    case "pluck": {
      const list = value(0);
      const field = value(1);
      if (!Array.isArray(list) || typeof field !== "string") return null;
      return list.map((item) => (typeof item === "object" && item !== null && Object.hasOwn(item, field) ? (item as Record<string, unknown>)[field] : null));
    }
  }
}

/** Decimals arrive as strings, so numeric strings count as numbers. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function arithmetic(values: readonly unknown[], step: (a: number, b: number) => number): number | null {
  let result: number | null = null;
  for (const [index, value] of values.entries()) {
    const number = numeric(value);
    if (number === null) return null;
    result = index === 0 ? number : step(result!, number);
    if (!Number.isFinite(result)) return null;
  }
  return result;
}

function same(a: unknown, b: unknown): boolean {
  if ((typeof a === "number" && typeof b === "string") || (typeof a === "string" && typeof b === "number")) return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Numbers compare as numbers (a decimal arrives as a string), other strings as strings (ISO dates compare right). */
function compare(a: unknown, b: unknown, test: (a: number | string, b: number | string) => boolean): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = Number(a), nb = Number(b);
  if (typeof a !== "boolean" && typeof b !== "boolean" && a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return test(na, nb);
  return typeof a === "string" && typeof b === "string" ? test(a, b) : false;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function textOfValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function mapText(value: unknown, change: (text: string) => string): string | null {
  return typeof value === "string" ? change(value) : null;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** What an expression may read; a set left out is not checked. */
export interface ExpressionScope {
  /** Input fields: `$input.<field>`. */
  readonly input?: ReadonlySet<string>;
  /** Variables: `$vars.<name>`. */
  readonly vars?: ReadonlySet<string>;
  /** Nodes: `$nodes.<node>`. */
  readonly nodes?: ReadonlySet<string>;
  /** Whether it is read inside a loop body: `$item` and `$index` exist only there. */
  readonly loop?: boolean;
}

/** What is wrong with an expression, or `null`: its shape, functions, argument types, paths and limits. */
export function checkExpression(expression: unknown, scope: ExpressionScope = {}): string | null {
  const budget = { nodes: 0 };
  const result = check(expression, scope, 0, budget);
  return result.problem ?? null;
}

interface Checked {
  readonly problem?: string;
  readonly type: ExprType;
}

function literalType(value: unknown): ExprType {
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return Array.isArray(value) ? "list" : "any";
}

function check(value: unknown, scope: ExpressionScope, depth: number, budget: { nodes: number }): Checked {
  budget.nodes += 1;
  if (budget.nodes > EXPRESSION_LIMITS.nodes) return { problem: `expression has more than ${EXPRESSION_LIMITS.nodes} nodes`, type: "any" };
  if (depth > EXPRESSION_LIMITS.depth) return { problem: `expression is nested deeper than ${EXPRESSION_LIMITS.depth}`, type: "any" };
  if (value === undefined) return { problem: "expression has no value", type: "any" };
  if (!isExpressionNode(value)) return { type: literalType(value) };
  const keys = Object.keys(value);
  if ("path" in value && !("op" in value)) {
    if (keys.length !== 1) return { problem: "a path has only the key path", type: "any" };
    const problem = checkPath(value.path, scope);
    return problem === null ? { type: "any" } : { problem, type: "any" };
  }
  if (keys.some((key) => key !== "op" && key !== "args")) return { problem: "a call has only the keys op and args", type: "any" };
  const definition = expressionFunction((value as { op?: unknown }).op);
  if (!definition) return { problem: `unknown function ${JSON.stringify((value as { op?: unknown }).op)}`, type: "any" };
  const args = (value as { args?: unknown }).args;
  if (!Array.isArray(args)) return { problem: `${definition.name}: args must be a list`, type: "any" };
  const required = definition.args.length - (definition.optional ?? 0);
  if (args.length < required) return { problem: `${definition.name} takes at least ${required} arguments`, type: "any" };
  if (definition.rest === undefined && args.length > definition.args.length) return { problem: `${definition.name} takes at most ${definition.args.length} arguments`, type: "any" };
  for (const [index, arg] of args.entries()) {
    const checked = check(arg, scope, depth + 1, budget);
    if (checked.problem !== undefined) return checked;
    const expected = definition.args[index] ?? definition.rest ?? "any";
    if (!fits(checked.type, expected)) return { problem: `${definition.name}: argument ${index + 1} must be ${expected}, not ${checked.type}`, type: "any" };
  }
  const problem = literalArgumentProblem(definition.name, args);
  return problem === null ? { type: definition.returns } : { problem, type: "any" };
}

/** `any` fits everything; a date is a string in JSON. */
function fits(actual: ExprType, expected: ExprType): boolean {
  if (actual === "any" || expected === "any" || actual === expected) return true;
  return (actual === "string" && expected === "date") || (actual === "date" && expected === "string");
}

/** Arguments that must be one of a few literals are checked when they are written literally. */
function literalArgumentProblem(name: ExprFunctionName, args: readonly unknown[]): string | null {
  if (name === "dateAdd" && typeof args[1] === "string" && durationMs(args[1]) === undefined) return `dateAdd: ${args[1]} is not an ISO duration without months and years`;
  if (name === "dateDiff" && typeof args[2] === "string" && !Object.hasOwn(DIFF_UNITS, args[2])) return `dateDiff: the unit must be one of ${Object.keys(DIFF_UNITS).join(", ")}`;
  return null;
}

/** What is wrong with a `$` path, or `null`. */
export function checkPath(path: unknown, scope: ExpressionScope = {}): string | null {
  if (typeof path !== "string" || !DATA_PATH.test(path)) return `path ${JSON.stringify(path)} must look like $input.field, $vars.name, $nodes.Node.field, $event.field, $trigger, $run.id, $now, $item.field or $index`;
  const [root, first] = path.split(".");
  if (root === "$now" && first !== undefined) return "$now has no fields";
  if (root === "$index" && first !== undefined) return "$index has no fields";
  if ((root === "$item" || root === "$index") && scope.loop === false) return `path ${path}: ${root} exists only inside a loop body`;
  if (root === "$nodes" && first === undefined) return "$nodes needs a node: $nodes.Node.field";
  if (first === undefined) return null;
  if (root === "$input" && scope.input && !scope.input.has(first)) return `path ${path}: the input has no field ${first}`;
  if (root === "$vars" && scope.vars && !scope.vars.has(first)) return `path ${path}: there is no variable ${first}`;
  if (root === "$nodes" && scope.nodes && !scope.nodes.has(first)) return `path ${path}: there is no node ${first}`;
  return null;
}
