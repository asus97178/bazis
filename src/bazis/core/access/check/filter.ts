import { Operand, type Predicate } from "../../../library/orm";
import type { Class } from "../../di";
import type { PermissionSpec } from "../catalog/permissions";
import type { AttributeLookup } from "../contracts/AttributeLookup";
import { AccessFilterTooLargeError } from "../contracts/errors";
import type { AccessValue, Condition, Grant, Scope, ValueTest } from "../contracts/types";

/** A condition on the columns of the listed rows. */
export type ColumnCondition =
  | { readonly all: readonly ColumnCondition[] }
  | { readonly any: readonly ColumnCondition[] }
  | { readonly not: ColumnCondition }
  | { readonly column: string; readonly in: readonly AccessValue[] }
  | { readonly column: string; readonly isNull: boolean };

/** Which rows of a list the subject may see (ACCESS-001 §4.3). */
export type AccessFilter =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "where"; readonly where: ColumnCondition };

type Built = ColumnCondition | boolean;

export interface FilterInput {
  readonly permission: string;
  readonly spec: PermissionSpec;
  readonly grants: "all" | readonly Grant[];
  readonly ownerIds: readonly string[];
  /** The partition of the request for a permission with `scope: "request"`. */
  readonly requestScope: Scope | undefined;
  readonly maxInList: number;
  readonly lookup: (type: Class<AttributeLookup>) => AttributeLookup;
}

export async function buildFilter(input: FilterInput): Promise<AccessFilter> {
  if (input.grants === "all") return { kind: "all" };
  if (input.spec.scope === "request" && input.requestScope === undefined) {
    throw new TypeError(`The list filter of "${input.permission}" needs the partition of the request: filter(permission, { scope }).`);
  }
  const parts: Built[] = [];
  for (const grant of input.grants) {
    const scope = await scopeCondition(input, grant);
    parts.push(scope === false ? false : and([scope, grant.where === undefined ? true : await whereCondition(input, grant.where)]));
  }
  const result = or(parts);
  return result === true ? { kind: "all" } : result === false ? { kind: "none" } : { kind: "where", where: result };
}

async function scopeCondition(input: FilterInput, grant: Grant): Promise<Built> {
  const source = input.spec.scope ?? "none";
  if (grant.scopes === "all") return true;
  if (source === "none") return grant.scopes.includes(null);
  if (source === "request") return grant.scopes.includes(input.requestScope!);
  if ("column" in source) return inColumn(source.column, grant.scopes);
  return await fromLookup(input, source.lookup, grant.scopes);
}

async function whereCondition(input: FilterInput, condition: Condition): Promise<Built> {
  if ("all" in condition && Array.isArray(condition.all)) return and(await Promise.all((condition.all as readonly Condition[]).map((inner) => whereCondition(input, inner))));
  if ("any" in condition && Array.isArray(condition.any)) return or(await Promise.all((condition.any as readonly Condition[]).map((inner) => whereCondition(input, inner))));
  if ("not" in condition && typeof condition.not === "object" && condition.not !== null) return not(await whereCondition(input, condition.not as Condition));
  if ("own" in condition && condition.own === true) return inColumn(input.spec.owner!, input.ownerIds);
  const [name, test] = Object.entries(condition)[0] as [string, ValueTest];
  const attribute = input.spec.on![name]!;
  if (attribute.lookup !== undefined) {
    const lookup = attribute.lookup;
    if ("isNull" in test) return test.isNull ? await fromLookup(input, lookup, [null]) : not(await fromLookup(input, lookup, [null]));
    if ("eq" in test) return await fromLookup(input, lookup, [test.eq]);
    if ("in" in test) return await fromLookup(input, lookup, test.in);
    return not(await fromLookup(input, lookup, test.notIn));
  }
  const column = attribute.column ?? name;
  if ("isNull" in test) return { column, isNull: test.isNull };
  if ("eq" in test) return { column, in: [test.eq] };
  if ("in" in test) return test.in.length === 0 ? false : { column, in: test.in };
  return test.notIn.length === 0 ? { column, isNull: false } : not({ column, in: test.notIn });
}

async function fromLookup(input: FilterInput, type: Class<AttributeLookup>, values: readonly AccessValue[]): Promise<Built> {
  const found = await input.lookup(type).toColumn(values);
  if (found.in.length > input.maxInList) {
    throw new AccessFilterTooLargeError(`The list filter of "${input.permission}": ${type.name} gave ${found.in.length} values of "${found.column}", more than access.maxInList (${input.maxInList}).`);
  }
  return inColumn(found.column, found.in);
}

/** `column in values`; `null` among them means an empty column. */
function inColumn(column: string, values: readonly AccessValue[]): Built {
  const known = values.filter((value) => value !== null);
  return or([known.length === 0 ? false : { column, in: known }, values.includes(null) ? { column, isNull: true } : false]);
}

function and(parts: readonly Built[]): Built {
  if (parts.includes(false)) return false;
  const rest = parts.filter((part): part is ColumnCondition => part !== true);
  return rest.length === 0 ? true : rest.length === 1 ? rest[0]! : { all: rest };
}

function or(parts: readonly Built[]): Built {
  if (parts.includes(true)) return true;
  const rest = parts.filter((part): part is ColumnCondition => part !== false);
  return rest.length === 0 ? false : rest.length === 1 ? rest[0]! : { any: rest };
}

function not(part: Built): Built {
  return typeof part === "boolean" ? !part : { not: part };
}

/**
 * The filter as an ORM condition: `"all"` — no restriction, `"none"` — no rows
 * at all (answer an empty page without a query).
 *
 * ```ts
 * const where = grantsToWhere(await access.filter("orders.read"));
 * if (where === "none") return { items: [], total: 0 };
 * let query = db.orders.asNoTracking();
 * if (where !== "all") query = query.where(() => where);
 * ```
 */
export function grantsToWhere(filter: AccessFilter): Predicate | "all" | "none" {
  if (filter.kind !== "where") return filter.kind;
  return toPredicate(filter.where);
}

function toPredicate(condition: ColumnCondition): Predicate {
  if ("all" in condition) return condition.all.map(toPredicate).reduce((left, right) => left.and(right));
  if ("any" in condition) return condition.any.map(toPredicate).reduce((left, right) => left.or(right));
  if ("not" in condition) return toPredicate(condition.not).not();
  const column = new Operand(condition.column);
  if ("isNull" in condition) return condition.isNull ? column.isNull() : column.isNotNull();
  return condition.in.length === 1 ? column.eq(condition.in[0]) : column.in(condition.in);
}
