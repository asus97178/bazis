import { expressionFunction, isExpressionNode, type Expr, type ExprFunctionName } from "./expressions";

/** A text that is not an expression; `position` is the offset of the problem. */
export class ExpressionSyntaxError extends Error {
  override readonly name = "ExpressionSyntaxError";

  constructor(message: string, readonly position: number) {
    super(`${message} at ${position}`);
  }
}

/** Binary operators by precedence; the same functions are also callable by name. */
const LEVELS: readonly (readonly (readonly [symbol: string, op: ExprFunctionName])[])[] = [
  [["or", "or"]],
  [["and", "and"]],
  [["==", "eq"], ["!=", "ne"], [">=", "gte"], ["<=", "lte"], [">", "gt"], ["<", "lt"]],
  [["+", "add"], ["-", "sub"]],
  [["*", "mul"], ["/", "div"], ["%", "mod"]],
];

const INFIX = new Map<string, { readonly symbol: string; readonly level: number }>(
  LEVELS.flatMap((level, index) => level.map(([symbol, op]) => [op as string, { symbol, level: index }] as const)),
);
const UNARY_LEVEL = LEVELS.length;
/** Comparisons do not chain: `a < b < c` means nothing, so they do not nest without brackets. */
const NON_ASSOCIATIVE = 2;
/** `{amount}` is `$vars.amount`; other roots are written in full: `{$input.orderId}`. */
const VARIABLE_PREFIX = "$vars.";

/**
 * The designer's text of an expression (WORKFLOW-002 §3.8): `{amount} * 1.2`,
 * `concat({a}, "-", {b})`, `now()`. One syntax for every designer. Lists and
 * objects are JSON literals: their items are not expressions.
 */
export function parseExpression(text: string): Expr {
  return new Parser(text).parse();
}

class Parser {
  private position = 0;

  constructor(private readonly text: string) {}

  parse(): Expr {
    const value = this.binary(0);
    this.space();
    if (this.position < this.text.length) this.fail(`unexpected ${JSON.stringify(this.text[this.position])}`);
    return value;
  }

  private fail(message: string, position = this.position): never {
    throw new ExpressionSyntaxError(message, position);
  }

  private space(): void {
    while (/\s/.test(this.text[this.position] ?? "")) this.position += 1;
  }

  private binary(level: number): Expr {
    if (level === LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const found = this.operator(level);
      if (found === undefined) return left;
      const right = this.binary(level + 1);
      left = { op: found, args: [left, right] };
      if (level === NON_ASSOCIATIVE && this.operator(level, false) !== undefined) this.fail("comparisons do not chain: use brackets");
    }
  }

  private operator(level: number, take = true): ExprFunctionName | undefined {
    this.space();
    for (const [symbol, op] of LEVELS[level]!) {
      if (!this.text.startsWith(symbol, this.position)) continue;
      // A word operator must end: `order` is a name, not `or` and `der`.
      if (/^[a-z]/.test(symbol) && /[A-Za-z0-9_]/.test(this.text[this.position + symbol.length] ?? "")) continue;
      if (take) this.position += symbol.length;
      return op;
    }
    return undefined;
  }

  private unary(): Expr {
    this.space();
    if (this.word("not")) return { op: "not", args: [this.unary()] };
    if (this.text[this.position] === "-") {
      const next = this.text[this.position + 1] ?? "";
      if (/[0-9.]/.test(next)) return this.number();
      this.position += 1;
      return { op: "sub", args: [0, this.unary()] };
    }
    return this.primary();
  }

  private word(word: string): boolean {
    if (!this.text.startsWith(word, this.position) || /[A-Za-z0-9_]/.test(this.text[this.position + word.length] ?? "")) return false;
    // `not(a)` is the function call too, with the same meaning.
    this.position += word.length;
    return true;
  }

  private primary(): Expr {
    this.space();
    const char = this.text[this.position];
    if (char === undefined) this.fail("the expression ends too early");
    if (char === "(") {
      this.position += 1;
      const value = this.binary(0);
      this.space();
      if (this.text[this.position] !== ")") this.fail("expected )");
      this.position += 1;
      return value;
    }
    if (char === "\"") return this.string();
    if (/[0-9.]/.test(char)) return this.number();
    if (char === "[") return this.json("]");
    if (char === "{") {
      const after = /\s*(.)/.exec(this.text.slice(this.position + 1))?.[1];
      return after === "\"" || after === "}" ? this.json("}") : this.path();
    }
    if (/[A-Za-z_]/.test(char)) return this.name();
    return this.fail(`unexpected ${JSON.stringify(char)}`);
  }

  private path(): Expr {
    const start = this.position;
    const end = this.text.indexOf("}", start);
    if (end < 0) this.fail("a path has no closing }", start);
    const inner = this.text.slice(start + 1, end).trim();
    if (!/^\$?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(inner)) this.fail(`${JSON.stringify(inner)} is not a path`, start);
    this.position = end + 1;
    return { path: inner.startsWith("$") ? inner : `${VARIABLE_PREFIX}${inner}` };
  }

  private string(): string {
    const start = this.position;
    let at = start + 1;
    while (at < this.text.length && this.text[at] !== "\"") at += this.text[at] === "\\" ? 2 : 1;
    if (at >= this.text.length) this.fail("a string has no closing quote", start);
    this.position = at + 1;
    try {
      return JSON.parse(this.text.slice(start, at + 1)) as string;
    } catch {
      return this.fail("the string has a bad escape", start);
    }
  }

  private number(): number {
    const match = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(this.text.slice(this.position));
    if (!match) this.fail("a number was expected");
    this.position += match[0].length;
    return Number(match[0]);
  }

  /** A JSON list or object, scanned to its closing bracket. */
  private json(close: "]" | "}"): Expr {
    const start = this.position;
    let depth = 0;
    let at = start;
    for (; at < this.text.length; at += 1) {
      const char = this.text[at]!;
      if (char === "\"") {
        at += 1;
        while (at < this.text.length && this.text[at] !== "\"") at += this.text[at] === "\\" ? 2 : 1;
      } else if (char === "[" || char === "{") {
        depth += 1;
      } else if (char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (at >= this.text.length || this.text[at] !== close) this.fail(`expected ${close}`, start);
    this.position = at + 1;
    let value: unknown;
    try {
      value = JSON.parse(this.text.slice(start, at + 1));
    } catch {
      this.fail("a list or an object is JSON: its items are not expressions", start);
    }
    if (isExpressionNode(value)) this.fail("an object with op or path is not a literal", start);
    return value as Expr;
  }

  private name(): Expr {
    const start = this.position;
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(start))!;
    const name = match[0];
    this.position += name.length;
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    this.space();
    if (this.text[this.position] !== "(") this.fail(`unknown word ${name}: a variable is written {${name}}`, start);
    const definition = expressionFunction(name);
    if (!definition) this.fail(`unknown function ${name}`, start);
    this.position += 1;
    const args: Expr[] = [];
    this.space();
    if (this.text[this.position] === ")") {
      this.position += 1;
      return { op: definition.name, args };
    }
    for (;;) {
      args.push(this.binary(0));
      this.space();
      const char = this.text[this.position];
      this.position += 1;
      if (char === ")") return { op: definition.name, args };
      if (char !== ",") this.fail("expected , or )", this.position - 1);
    }
  }
}

/**
 * The text of an expression: `parseExpression(printExpression(e))` gives `e`
 * back. A call goes infix only with two arguments: `add(a, b, c)` stays a call,
 * because `a + b + c` reads as two calls.
 */
export function printExpression(expression: Expr): string {
  return print(expression, 0);
}

function print(expression: Expr, outer: number): string {
  if (!isExpressionNode(expression)) return JSON.stringify(expression) ?? "null";
  if ("path" in expression) {
    const path = String(expression.path);
    return `{${path.startsWith(VARIABLE_PREFIX) ? path.slice(VARIABLE_PREFIX.length) : path}}`;
  }
  const { op, args } = expression;
  const infix = INFIX.get(op);
  if (infix && args.length === 2) {
    const { level, symbol } = infix;
    // The right side binds one level tighter: `a - (b - c)` keeps its brackets. Comparisons do not chain at all.
    const leftLevel = level === NON_ASSOCIATIVE ? level + 1 : level;
    const text = `${print(args[0]!, leftLevel)} ${symbol} ${print(args[1]!, level + 1)}`;
    return level < outer ? `(${text})` : text;
  }
  if (op === "not" && args.length === 1) {
    const text = `not ${print(args[0]!, UNARY_LEVEL)}`;
    return UNARY_LEVEL < outer ? `(${text})` : text;
  }
  return `${op}(${args.map((arg) => print(arg, 0)).join(", ")})`;
}
