import type { PermissionSpec } from "../catalog/permissions";
import type { AccessValue, Condition, Grant, Scope, ValueTest } from "../contracts/types";

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
  if (spec.on?.[key] === undefined) return `unknown attribute "${key}"`;
  return testProblem(key, value, maxInList);
}

function testProblem(attribute: string, test: unknown, maxInList: number): string | undefined {
  if (typeof test !== "object" || test === null || Array.isArray(test)) return `the test of "${attribute}" must be an object`;
  const keys = Object.keys(test);
  if (keys.length !== 1) return `the test of "${attribute}" must have exactly one of eq, in, notIn, isNull`;
  const [op] = keys;
  const value = (test as Record<string, unknown>)[op!];
  switch (op) {
    case "eq":
      return isValue(value) && value !== null ? undefined : `${attribute}.eq must be a string, number or boolean (an empty value is tested with isNull)`;
    case "in":
    case "notIn":
      if (!Array.isArray(value) || !value.every((item) => isValue(item) && item !== null)) return `${attribute}.${op} must be a list of strings, numbers or booleans (an empty value is tested with isNull)`;
      return value.length > maxInList ? `${attribute}.${op} has more than ${maxInList} values` : undefined;
    case "isNull":
      return typeof value === "boolean" ? undefined : `${attribute}.isNull must be true or false`;
    default:
      return `unknown test "${op}" of "${attribute}"`;
  }
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
  return testValue(object[attribute], test);
}

function testValue(raw: unknown, test: ValueTest): boolean | undefined {
  if (raw === undefined) return undefined;
  if ("isNull" in test) return (raw === null) === test.isNull;
  if (raw === null) return undefined;
  if ("eq" in test) return same(raw, test.eq);
  const found = ("in" in test ? test.in : test.notIn).some((value) => same(raw, value));
  return "in" in test ? found : !found;
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
