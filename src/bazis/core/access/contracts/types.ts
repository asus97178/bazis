/** A text for people: one string, or a text per language (`{ ru: "…", en: "…" }`). */
export type LocalizedText = string | Readonly<Record<string, string>>;

/** A value an attribute of an object can have in a condition. */
export type AccessValue = string | number | boolean | null;

/** A partition of the application (a CMS space, a tenant); `null` — no partition. */
export type Scope = string | null;

/** A test of one attribute. */
export type ValueTest =
  | { readonly eq: AccessValue }
  | { readonly in: readonly AccessValue[] }
  | { readonly notIn: readonly AccessValue[] }
  | { readonly isNull: boolean };

/**
 * A condition of a grant (ACCESS-001 §4.2): a tree over the attributes the
 * permission declares in `on`. `{ own: true }` — the object belongs to the
 * subject. Values are final: the rights system substitutes "my organization"
 * and the like itself.
 */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly own: true }
  | { readonly [attribute: string]: ValueTest };

/** Field lists of a grant for a permission with `fields: true`. */
export interface GrantFields {
  readonly read?: readonly string[] | "all";
  readonly write?: readonly string[] | "all";
}

/** What a subject is given by one permission: in these partitions, on these conditions. */
export interface Grant {
  readonly scopes: "all" | readonly Scope[];
  readonly where?: Condition;
  readonly fields?: GrantFields;
}

/** `"all"` — everything without conditions (a superuser); `[]` — nothing. Grants add up with "or". */
export type Grants = "all" | readonly Grant[];

/**
 * Who acts: `sub` is `"<account kind>:<id>"` so that accounts of different
 * tables with one id do not merge; `act` — on whose behalf (an organization).
 * A rights system may add its own fields: the framework hands the same object
 * back to it.
 */
export interface AccessSubject {
  readonly sub: string;
  readonly act?: string;
}

/**
 * What is checked: the attribute values of the object, its partition (one or
 * several) under `scope`, and the owner column under the name the permission
 * declares in `owner`. Without an object `can` answers whether the subject has
 * the permission anywhere.
 */
export interface AccessObject {
  readonly scope?: Scope | readonly Scope[];
  readonly [attribute: string]: unknown;
}
