import type { Condition } from "./ProcessDocument";
import { isPath, readPath, type InstanceData } from "./paths";

/** Evaluates a flow condition. Pure: no calls, no side effects. */
export function evaluateCondition(condition: Condition, data: InstanceData): boolean {
  if ("all" in condition) return condition.all.every((item) => evaluateCondition(item, data));
  if ("any" in condition) return condition.any.some((item) => evaluateCondition(item, data));
  if ("not" in condition) return !evaluateCondition(condition.not, data);
  const actual = readPath(data, condition.path);
  const expected = isPath(condition.value) ? readPath(data, condition.value) : condition.value;
  switch (condition.op) {
    case "eq": return same(actual, expected);
    case "ne": return !same(actual, expected);
    case "gt": return compare(actual, expected, (a, b) => a > b);
    case "gte": return compare(actual, expected, (a, b) => a >= b);
    case "lt": return compare(actual, expected, (a, b) => a < b);
    case "lte": return compare(actual, expected, (a, b) => a <= b);
    case "in": return Array.isArray(expected) && expected.some((item) => same(actual, item));
    case "contains":
      if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
      return Array.isArray(actual) && actual.some((item) => same(item, expected));
    case "empty": return isEmpty(actual);
    case "notEmpty": return !isEmpty(actual);
  }
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "string" || typeof a === "string" && typeof b === "number") return Number(a) === Number(b);
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
