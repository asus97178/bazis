/**
 * Exact decimal numbers for the tests of a number attribute (ACCESS-001 §4.2).
 * A `numeric` column comes from the database as a string; turning it into a
 * `double` would make a check disagree with the list filter the database runs.
 */
export interface Decimal {
  readonly negative: boolean;
  /** Digits before the point, without leading zeros; `""` — zero. */
  readonly integer: string;
  /** Digits after the point, without trailing zeros. */
  readonly fraction: string;
}

const FORM = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
/** Enough for a `double` (1e308, 5e-324) and far beyond a column of money. */
const MAX_EXPONENT = 1000;
const MAX_DIGITS = 1100;

/** The decimal of a number, a bigint or a decimal string; `undefined` — not a number. */
export function decimalOf(value: unknown): Decimal | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? parse(String(value)) : undefined;
  if (typeof value === "bigint") return parse(String(value));
  if (typeof value === "string") return parse(value.trim());
  return undefined;
}

function parse(text: string): Decimal | undefined {
  if (text.length > MAX_DIGITS) return undefined;
  const match = FORM.exec(text);
  if (match === null) return undefined;
  const [, sign, whole = "", part = "", power] = match;
  if (whole === "" && part === "") return undefined;
  const exponent = power === undefined ? 0 : Number(power);
  if (Math.abs(exponent) > MAX_EXPONENT) return undefined;
  // Move the point by the exponent: digits = whole + part, the point stands after `whole.length + exponent` digits.
  const digits = whole + part;
  const point = whole.length + exponent;
  const integer = (point <= 0 ? "" : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point)).replace(/^0+/, "");
  const fraction = (point <= 0 ? "0".repeat(-point) + digits : point >= digits.length ? "" : digits.slice(point)).replace(/0+$/, "");
  return { negative: sign === "-" && (integer !== "" || fraction !== ""), integer, fraction };
}

/** Below zero — `left` is less, above — greater, zero — the numbers are equal. */
export function compareDecimals(left: Decimal, right: Decimal): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const order = compareMagnitudes(left, right);
  return order === 0 ? 0 : left.negative ? -order : order;
}

function compareMagnitudes(left: Decimal, right: Decimal): number {
  if (left.integer.length !== right.integer.length) return left.integer.length - right.integer.length;
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1;
  if (left.fraction === right.fraction) return 0;
  const length = Math.max(left.fraction.length, right.fraction.length);
  return left.fraction.padEnd(length, "0") < right.fraction.padEnd(length, "0") ? -1 : 1;
}

/** The decimal in plain notation, without an exponent: `-0.5`, `100000.01`. */
export function decimalText(value: Decimal): string {
  return `${value.negative ? "-" : ""}${value.integer === "" ? "0" : value.integer}${value.fraction === "" ? "" : `.${value.fraction}`}`;
}
