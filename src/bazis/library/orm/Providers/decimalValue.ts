import { OrmError } from "../errors";
import type { PropertyModel } from "../Metadata/types";

const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

/**
 * A decimal is written as text so no digit is lost: a string such as "19.90"
 * or "-0.5", a bigint, or a safe integer. A float like 0.1 is refused because
 * it is already inexact.
 */
export function decimalText(value: unknown): string | undefined {
  if (typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value))) return String(value);
  return typeof value === "string" && DECIMAL_TEXT.test(value) ? value : undefined;
}

/** The parameter for a decimal column; anything that is not an exact decimal is refused. */
export function decimalParameter(value: unknown): string {
  const text = decimalText(value);
  if (text !== undefined) return text;
  throw new OrmError(`A decimal value must be a string such as "19.90" (or an integer), got ${typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : typeof value}.`);
}

/**
 * Before a write: a value with more digits than `numeric(precision, scale)`
 * allows is refused, because PostgreSQL would round the fraction silently.
 * Trailing zeros after the point do not count ("1.500" fits scale 2).
 */
export function assertDecimalFits(owner: string, property: PropertyModel, value: unknown): void {
  if (property.type !== "decimal" || property.precision === undefined || value === null || value === undefined) return;
  const match = decimalParameter(value).match(DECIMAL_TEXT)!;
  const whole = match[2]!.replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  const scale = property.scale ?? 0;
  const where = `${owner}.${property.propertyName}`;
  if (fraction.length > scale) throw new OrmError(`${where}: "${value}" has ${fraction.length} digits after the point; numeric(${property.precision}, ${scale}) keeps ${scale}. Round it in the code.`);
  if ((whole === "0" ? 0 : whole.length) > property.precision - scale) throw new OrmError(`${where}: "${value}" does not fit numeric(${property.precision}, ${scale}): at most ${property.precision - scale} digits before the point.`);
}
