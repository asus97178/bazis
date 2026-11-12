import type { AttributeSpec, PermissionSpec } from "../catalog/permissions";
import type { AccessValue, CompareTest, Condition, Grant, Scope, ValueTest } from "../contracts/types";
import { compareDecimals, decimalOf } from "./decimal";

export const MAX_DEPTH = 8;
export const MAX_NODES = 200;

/** Why a grant cannot be used for the permission, or `undefined` (ACCESS-001 §4.2). */
export function grantProblem(spec: PermissionSpec, grant: Grant, maxInList: number): string | undefined {
  if (typeof grant !== "object" || grant === null) return "a grant must be an object";
  if (grant.scopes !== "all" && (!Array.isArray(grant.scopes) || !grant.scopes.every(isScope))) return 'scopes must be "all" or a list of strings and null';
  if (grant.fields !== undefined) {
    if (spec.fields !== true) return "the permission has no field lists";
    for (const side of ["read", "write"] as const) {
      const list = grant.fields[side];
      if (list !== undefined && list !== "all" && !(Array.isArray(list) && list.every((field) => typeof field === "string"))) return `fields.${side} must be "all" or a list of field names`;
    }
  }
  if (grant.where === undefined) return undefined;
  const counter = { nodes: 0 };
  return conditionProblem(spec, grant.where, 1, counter, maxInList);
}

function conditionProblem(spec: PermissionSpec, condition: Condition, depth: number, counter: { nodes: number }, maxInList: number): string | undefined {
  if (depth > MAX_DEPTH) return `the condition is deeper than ${MAX_DEPTH}`;
  if (++counter.nodes > MAX_NODES) return `the condition has more than ${MAX_NODES} nodes`;
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) return "a condition must be an object";
  const keys = Object.keys(condition);
  if (keys.length !== 1) return `a condition must have exactly one key, got ${keys.length === 0 ? "none" : keys.join(", ")}`;
  const key = keys[0]!;
  const value = (condition as Record<string, unknown>)[key];
  if (key === "all" || key === "any") {
    if (!Array.isArray(value) || value.length === 0) return `${key} must be a non-empty list`;
    for (const inner of value) {
      const problem = conditionProblem(spec, inner as Condition, depth + 1, counter, maxInList);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (key === "not") return conditionProblem(spec, value as Condition, depth + 1, counter, maxInList);
  if (key === "own") {
    if (value !== true) return "own must be true";
    return spec.owner === undefined ? "the permission declares no owner, own cannot be used" : undefined;
  }
  const attribute = spec.on?.[key];
  if (attribute === undefined) return `unknown attribute "${key}"`;
  return testProblem(key, attribute, value, maxInList);
}

function testProblem(attribute: string, spec: AttributeSpec, test: unknown, maxInList: number): string | undefined {
  if (typeof test !== "object" || test === null || Array.isArray(test)) return `the test of "${attribute}" must be an object`;
  const keys = Object.keys(test);
  if (keys.length !== 1) return `the test of "${attribute}" must have exactly one of eq, in, notIn, isNull, gt, gte, lt, lte`;
  const [op] = keys;
  const value = (test as Record<string, unknown>)[op!];
  const numeric = spec.type === "number";
  switch (op) {
    case "eq":
      if (numeric) return isNumeric(value) ? undefined : `${attribute}.eq must be a number: the attribute is a number`;
      return isValue(value) && value !== null ? undefined : `${attribute}.eq must be a string, number or boolean (an empty value is tested with isNull)`;
    case "in":
    case "notIn":
      if (numeric) {
        if (!Array.isArray(value) || !value.every(isNumeric)) return `${attribute}.${op} must be a list of numbers: the attribute is a number`;
      } else if (!Array.isArray(value) || !value.every((item) => isValue(item) && item !== null)) {
        return `${attribute}.${op} must be a list of strings, numbers or booleans (an empty value is tested with isNull)`;
      }
      return value.length > maxInList ? `${attribute}.${op} has more than ${maxInList} values` : undefined;
    case "isNull":
      return typeof value === "boolean" ? undefined : `${attribute}.isNull must be true or false`;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (!comparable(spec)) return `${attribute}.${op}: only an attribute of type "number" with a column can be compared${spec.lookup !== undefined ? " (this one has a lookup)" : ""}`;
      return typeof value === "number" && Number.isFinite(value) ? undefined : `${attribute}.${op} must be a number`;
    default:
      return `unknown test "${op}" of "${attribute}"`;
  }
}

/** Whether `gt`, `gte`, `lt`, `lte` may test the attribute: a number in a column of the listed rows. */
export function comparable(attribute: AttributeSpec): boolean {
  return attribute.type === "number" && attribute.lookup === undefined;
}

/** A number, or a decimal string for a value a `double` cannot hold. */
function isNumeric(value: unknown): boolean {
  return (typeof value === "number" || typeof value === "string") && decimalOf(value) !== undefined;
}

/**
 * The value of a condition on an object, in SQL's three-valued logic so that a
 * check and a list filter agree: an attribute the object does not carry, or a
 * `null` compared with a value, is unknown; unknown at the top denies.
 */
export function evaluate(condition: Condition, object: Readonly<Record<string, unknown>>, spec: PermissionSpec, ownerIds: readonly string[]): boolean | undefined {
  if ("all" in condition && Array.isArray(condition.all)) {
    let result: boolean | undefined = true;
    for (const inner of condition.all as readonly Condition[]) {
      const value = evaluate(inner, object, spec, ownerIds);
      if (value === false) return false;
      if (value === undefined) result = undefined;
    }
    return result;
  }
  if ("any" in condition && Array.isArray(condition.any)) {
    let result: boolean | undefined = false;
    for (const inner of condition.any as readonly Condition[]) {
      const value = evaluate(inner, object, spec, ownerIds);
      if (value === true) return true;
      if (value === undefined) result = undefined;
    }
    return result;
  }
  if ("not" in condition && isCondition(condition.not)) {
    const value = evaluate(condition.not, object, spec, ownerIds);
    return value === undefined ? undefined : !value;
  }
  if ("own" in condition && condition.own === true) {
    const owner = object[spec.owner!];
    if (owner === undefined) return undefined;
    if (owner === null) return false;
    return ownerIds.includes(String(owner));
  }
  const [attribute, test] = Object.entries(condition)[0] as [string, ValueTest];
  return testValue(object[attribute], test, spec.on?.[attribute]?.type === "number");
}

const COMPARE: Readonly<Record<CompareTest, (order: number) => boolean>> = {
  gt: (order) => order > 0,
  gte: (order) => order >= 0,
  lt: (order) => order < 0,
  lte: (order) => order <= 0,
};

function testValue(raw: unknown, test: ValueTest, numeric: boolean): boolean | undefined {
  if (raw === undefined) return undefined;
  if ("isNull" in test) return (raw === null) === test.isNull;
  if (raw === null) return undefined;
  if (numeric) return testNumber(raw, test);
  if ("eq" in test) return same(raw, test.eq);
  if ("in" in test || "notIn" in test) {
    const found = ("in" in test ? test.in : test.notIn).some((value) => same(raw, value));
    return "in" in test ? found : !found;
  }
  // A comparison of an attribute that is not a number: such a grant is dropped before it gets here.
  return undefined;
}

/**
 * A number attribute is compared as a number, the way the database does it:
 * `"100000.00"` of a `numeric` column equals `100000`. The comparison is exact
 * and decimal, so a check and a list filter agree. Not a number — unknown.
 */
function testNumber(raw: unknown, test: Exclude<ValueTest, { readonly isNull: boolean }>): boolean | undefined {
  const left = decimalOf(raw);
  if (left === undefined) return undefined;
  const order = (value: unknown): number | undefined => {
    const right = decimalOf(value);
    return right === undefined ? undefined : compareDecimals(left, right);
  };
  if ("in" in test || "notIn" in test) {
    const found = ("in" in test ? test.in : test.notIn).some((value) => order(value) === 0);
    return "in" in test ? found : !found;
  }
  const [op, value] = Object.entries(test)[0] as ["eq" | CompareTest, unknown];
  const result = order(value);
  if (result === undefined) return undefined;
  return op === "eq" ? result === 0 : COMPARE[op](result);
}

/** Ids come as numbers from one side and as strings from the other. */
function same(raw: unknown, value: AccessValue): boolean {
  if (typeof raw === typeof value) return raw === value;
  if ((typeof raw === "number" || typeof raw === "string") && (typeof value === "number" || typeof value === "string")) return String(raw) === String(value);
  return false;
}

export function isValue(value: unknown): value is AccessValue {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isScope(value: unknown): value is Scope {
  return value === null || typeof value === "string";
}

function isCondition(value: unknown): value is Condition {
  return typeof value === "object" && value !== null;
}
