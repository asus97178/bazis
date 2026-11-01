import type { Class } from "../../di";
import type { AttributeLookup } from "../contracts/AttributeLookup";
import type { LocalizedText } from "../contracts/types";

/** An attribute of the object of a permission: what a condition may test (ACCESS-001 §3). */
export interface AttributeSpec {
  /** A reference kind (`"workflow.process"`): the administrator picks values from it. */
  readonly ref?: string;
  /** A plain value instead of a reference. */
  readonly type?: "string" | "number" | "boolean";
  /** The column of the listed rows; by default the attribute's name. */
  readonly column?: string;
  /** For an attribute that is not a column: turns its condition into a column condition. */
  readonly lookup?: Class<AttributeLookup>;
}

/**
 * Where the partition of an object comes from: a column of the row, a lookup
 * (several partitions are possible), the request (the caller passes it), or
 * nowhere — the permission has no partition.
 */
export type ScopeSource =
  | "none"
  | "request"
  | { readonly column: string }
  | { readonly lookup: Class<AttributeLookup> };

export interface PermissionSpec {
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  /** By default `"none"`. */
  readonly scope?: ScopeSource;
  readonly on?: Readonly<Record<string, AttributeSpec>>;
  /** The owner column: makes `{ own: true }` possible. */
  readonly owner?: string;
  /** Grants may carry field lists. */
  readonly fields?: boolean;
}

export type PermissionDeclarations = Readonly<Record<string, PermissionSpec>>;

const DECLARED = new WeakSet<object>();

/**
 * Declares what a module lets the administrator allow or deny (ACCESS-001 §3);
 * the result goes to `@Module({ permissions })`. Only describes: the checks run
 * when the application is built.
 *
 * ```ts
 * export const orderPermissions = definePermissions({
 *   "orders.read": { title: "See orders", scope: { column: "shopId" }, owner: "customerId" },
 * });
 * ```
 */
export function definePermissions<const T extends PermissionDeclarations>(permissions: T): T {
  const frozen = deepFreeze({ ...permissions });
  DECLARED.add(frozen);
  return frozen;
}

export function isDeclaredPermissions(value: unknown): value is PermissionDeclarations {
  return typeof value === "object" && value !== null && DECLARED.has(value);
}

const KEY = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Words of conditions; `scope` is the partition. */
const RESERVED = new Set(["all", "any", "not", "own", "scope"]);

/** The problems of one permission, before the reference kinds are known. */
export function permissionProblems(key: string, spec: PermissionSpec): string[] {
  const problems: string[] = [];
  const at = `permission "${key}"`;
  if (!KEY.test(key) || key.length > 128) problems.push(`${at}: the key must look like "<module>.<object>.<action>" in lower case`);
  if (!isText(spec.title, 200)) problems.push(`${at}: title must be a non-empty text up to 200 characters`);
  if (spec.description !== undefined && !isText(spec.description, 2000)) problems.push(`${at}: description must be a non-empty text up to 2000 characters`);
  const scope = spec.scope;
  if (scope !== undefined && scope !== "none" && scope !== "request") {
    const column = (scope as { column?: unknown }).column;
    const lookup = (scope as { lookup?: unknown }).lookup;
    if ((column === undefined) === (lookup === undefined)) problems.push(`${at}: scope must be "none", "request", { column } or { lookup }`);
    else if (column !== undefined && !isName(column)) problems.push(`${at}: scope.column must be a column name`);
    else if (lookup !== undefined && typeof lookup !== "function") problems.push(`${at}: scope.lookup must be an AttributeLookup class`);
  }
  for (const [name, attribute] of Object.entries(spec.on ?? {})) {
    if (!NAME.test(name)) problems.push(`${at}: attribute "${name}" must be a name of letters, digits and _`);
    else if (RESERVED.has(name)) problems.push(`${at}: attribute "${name}" is a reserved word of conditions`);
    if ((attribute.ref === undefined) === (attribute.type === undefined)) problems.push(`${at}: attribute "${name}" needs exactly one of ref and type`);
    if (attribute.ref !== undefined && !KEY.test(attribute.ref)) problems.push(`${at}: attribute "${name}": ref must be a reference kind like "<module>.<kind>"`);
    if (attribute.type !== undefined && !["string", "number", "boolean"].includes(attribute.type)) problems.push(`${at}: attribute "${name}": type must be string, number or boolean`);
    if (attribute.column !== undefined && attribute.lookup !== undefined) problems.push(`${at}: attribute "${name}" has both column and lookup`);
    if (attribute.column !== undefined && !isName(attribute.column)) problems.push(`${at}: attribute "${name}": column must be a column name`);
    if (attribute.lookup !== undefined && typeof attribute.lookup !== "function") problems.push(`${at}: attribute "${name}": lookup must be an AttributeLookup class`);
  }
  if (spec.owner !== undefined && !isName(spec.owner)) problems.push(`${at}: owner must be a column name`);
  if (spec.fields !== undefined && typeof spec.fields !== "boolean") problems.push(`${at}: fields must be true or false`);
  return problems;
}

/** The lookup classes a permission needs registered. */
export function lookupsOf(spec: PermissionSpec): Class<AttributeLookup>[] {
  const lookups: Class<AttributeLookup>[] = [];
  if (typeof spec.scope === "object" && "lookup" in spec.scope) lookups.push(spec.scope.lookup);
  for (const attribute of Object.values(spec.on ?? {})) if (attribute.lookup !== undefined) lookups.push(attribute.lookup);
  return lookups;
}

export function isReferenceKind(value: string): boolean {
  return KEY.test(value) && value.length <= 128;
}

function isText(value: unknown, max: number): boolean {
  if (typeof value === "string") return value.trim() !== "" && value.length <= max;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([language, text]) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language) && typeof text === "string" && text.trim() !== "" && text.length <= max);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) if (typeof item === "object") deepFreeze(item);
  return Object.freeze(value);
}
