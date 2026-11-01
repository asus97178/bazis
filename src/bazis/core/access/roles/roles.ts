import type { Condition, Grant, GrantFields, Scope } from "../contracts/types";

/**
 * A permission of a role: its key, `"<key>:own"` for «only one's own», or a
 * grant with conditions.
 */
export type RoleGrant =
  | string
  | {
      readonly permission: string;
      readonly scopes?: "all" | readonly Scope[];
      readonly where?: Condition;
      readonly fields?: GrantFields;
    };

/** Role → `"all"` (everything) or its permissions. */
export type RoleDeclarations = Readonly<Record<string, "all" | readonly RoleGrant[]>>;

const DECLARED = new WeakSet<object>();

/**
 * Roles of the default rights system (ACCESS-001 §8), for an application
 * without its own one: the subject's roles come from the token, their
 * permissions from here. The result goes to `@Module({ roles })`.
 *
 * ```ts
 * export const appRoles = defineRoles({
 *   admin: "all",
 *   manager: ["workflow.instances.start", "workflow.instances.read"],
 *   user: ["workflow.instances.read:own", "workflow.tasks.work"],
 * });
 * ```
 */
export function defineRoles<const T extends RoleDeclarations>(roles: T): T {
  const frozen = Object.freeze({ ...roles });
  DECLARED.add(frozen);
  return frozen;
}

export function isDeclaredRoles(value: unknown): value is RoleDeclarations {
  return typeof value === "object" && value !== null && DECLARED.has(value);
}

/** One permission of a role as a grant. */
export interface RolePermission {
  readonly permission: string;
  readonly grant: Grant;
}

/** `"orders.read:own"` → `orders.read` with `{ own: true }`. */
export function rolePermission(item: RoleGrant): RolePermission {
  if (typeof item === "string") {
    if (item.endsWith(":own")) return { permission: item.slice(0, -4), grant: { scopes: "all", where: { own: true } } };
    return { permission: item, grant: { scopes: "all" } };
  }
  const grant: Grant = {
    scopes: item.scopes ?? "all",
    ...(item.where === undefined ? {} : { where: item.where }),
    ...(item.fields === undefined ? {} : { fields: item.fields }),
  };
  return { permission: item.permission, grant };
}
