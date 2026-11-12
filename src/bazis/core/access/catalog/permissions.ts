import type { Class } from "../../di";
import type { AttributeLookup } from "../contracts/AttributeLookup";
import type { LocalizedText } from "../contracts/types";
import type { BazisPermissions, BazisPermissionSources } from "../index";

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

/** The declarations of `definePermissions(...)` as a part of {@link BazisPermissions}. */
export type PermissionsOf<T extends PermissionDeclarations> = { readonly [K in keyof T]: T[K] };

/** A declared permission. */
export type PermissionKey = Extract<keyof BazisPermissions, string>;

/**
 * A permission of a source (ACCESS-001 §3.1): any key under a prefix of
 * `@Module({ permissionSources })`. Whether it exists is known only while the
 * application runs; a key the source does not give is a permission nobody has.
 */
export type SourcePermissionKey = `${Extract<keyof BazisPermissionSources, string>}.${string}`;

/** What `can`, `access.can`, `access.filter` and `access.fields` accept. */
export type AnyPermissionKey = PermissionKey | SourcePermissionKey;

/** A permission with an `owner`: the only kind `"<key>:own"` makes sense for. */
export type OwnPermissionKey = { [K in keyof BazisPermissions]: BazisPermissions[K] extends { readonly owner: string } ? Extract<K, string> : never }[keyof BazisPermissions];

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
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return [`${at}: must be an object with a title`];
  if (spec.on !== undefined && (typeof spec.on !== "object" || spec.on === null || Array.isArray(spec.on))) return [`${at}: on must map attribute names to their descriptions`];
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
    if (typeof attribute !== "object" || attribute === null) {
      problems.push(`${at}: attribute "${name}" must be an object with ref or type`);
      continue;
    }
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

const PREFIX = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/** A prefix of a permission source: one or several segments of a key (`data`, `dm.records`). */
export function isSourcePrefix(value: string): boolean {
  return PREFIX.test(value) && value.length <= 64;
}

/** Whether the key lies under the prefix: `data.orders.read` under `data`. */
export function underPrefix(key: string, prefix: string): boolean {
  return key.startsWith(`${prefix}.`);
}

/** A frozen copy of a specification a source gave: the catalog keeps it, the source may change its own. */
export function frozenSpec(spec: PermissionSpec): PermissionSpec {
  const scope = typeof spec.scope === "object" ? { ...spec.scope } : spec.scope;
  const on = spec.on === undefined ? undefined : Object.fromEntries(Object.entries(spec.on).map(([name, attribute]) => [name, { ...attribute }]));
  const title = typeof spec.title === "object" ? { ...spec.title } : spec.title;
  const description = typeof spec.description === "object" ? { ...spec.description } : spec.description;
  return deepFreeze({
    title,
    ...(description === undefined ? {} : { description }),
    ...(scope === undefined ? {} : { scope }),
    ...(on === undefined ? {} : { on }),
    ...(spec.owner === undefined ? {} : { owner: spec.owner }),
    ...(spec.fields === undefined ? {} : { fields: spec.fields }),
  } as PermissionSpec);
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
  // A lookup is a class: a function, left as it is.
  for (const item of Object.values(value)) if (typeof item === "object") deepFreeze(item);
  return Object.freeze(value);
}
