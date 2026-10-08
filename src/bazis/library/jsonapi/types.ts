/**
 * Types of the universal list request in the style of the JSON:API specification.
 *
 * The request is described by query parameters:
 * - `?sort=name,-createdAt`: sorting (minus = descending);
 * - `?filter[age][gte]=18&filter[name]=Bob`: filtering (no operator = `eq`),
 *   top-level conditions are joined with AND;
 * - `?filter[or][0][age][lte]=19&filter[or][1][age][gte]=41`: OR groups:
 *   AND inside a group, OR between groups (`filters AND (g0 OR g1 ...)`);
 * - `?page[number]=2&page[size]=20` or `?page[offset]=40&page[limit]=20`: paging;
 * - `?include=posts,author`: eager loading of relations;
 * - `?fields[users]=name,age`: sparse fieldsets (projection).
 *
 * The types are pure (no dependencies on the kernel/environment): the parser and
 * the response builder use only Web APIs (`URLSearchParams`).
 */

/** Sort direction. */
export type SortDirection = "asc" | "desc";

/** One sort key. */
export interface SortField {
  readonly field: string;
  readonly dir: SortDirection;
}

/**
 * Filter operator. The names match the comparison operators of most ORMs:
 * - `eq`/`ne`: equal/not equal (a `null` value means IS [NOT] NULL);
 * - `gt`/`gte`/`lt`/`lte`: comparisons;
 * - `like`: LIKE with a user pattern; `contains`/`startsWith`/`endsWith`:
 *   LIKE with escaped wildcards;
 * - `in`/`nin`: in/not in a list (comma-separated value);
 * - `isNull`/`isNotNull`: NULL check (no value needed).
 */
export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "nin"
  | "isNull"
  | "isNotNull";

/** One filter condition on a field. */
export interface FilterRule {
  readonly field: string;
  readonly op: FilterOperator;
  /** An array for `in`/`nin`; an empty string for `isNull`/`isNotNull`. */
  readonly value: string | readonly string[];
}

/**
 * A group of conditions joined with **AND**: one branch of an OR expression.
 * Several groups are joined with **OR** (see {@link ListQuery.or}).
 */
export type FilterGroup = readonly FilterRule[];

/**
 * Normalized paging. Either JSON:API style (`page[number]/size` or
 * `page[offset]/limit`) is brought to one form: `offset`/`limit` for the
 * database, `number`/`size` for the response.
 */
export interface PageParams {
  /** Page number (1-based). */
  readonly number: number;
  /** Page size. */
  readonly size: number;
  /** Offset (0-based) = `(number - 1) * size`. */
  readonly offset: number;
  /** Limit = `size`. */
  readonly limit: number;
}

/** A fully parsed and validated list request. */
export interface ListQuery {
  readonly sort: readonly SortField[];
  /**
   * Top-level conditions (`filter[field][op]=v`) joined with **AND**.
   * Always applied.
   */
  readonly filters: readonly FilterRule[];
  /**
   * OR groups (`filter[or][N][field][op]=v`): conditions inside a group are joined
   * with AND, different groups with OR. The whole OR expression is joined with
   * {@link filters} by AND: `filters AND (group0 OR group1 OR ...)`. Empty means
   * no OR logic.
   */
  readonly or: readonly FilterGroup[];
  readonly page: PageParams;
  readonly include: readonly string[];
  /** Sparse fieldsets per resource type (`fields[type]=a,b`). */
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

/** Paging limits and defaults. */
export interface PageOptions {
  /** Default page size (if the client did not set one). Defaults to 20. */
  readonly defaultSize?: number;
  /** Maximum allowed page size. Defaults to 100. */
  readonly maxSize?: number;
}

/**
 * Contract of what the request may use. Secure by default: anything not listed
 * explicitly is forbidden (sorting/filtering/include by unlisted fields results
 * in 400), so the client cannot reach internal columns.
 */
export interface ListQueryOptions {
  /** Fields that allow sorting (`?sort=`). Not set: sorting is forbidden. */
  readonly sort?: readonly string[];
  /** Fields → allowed filter operators. Not set: filtering is forbidden. */
  readonly filter?: Readonly<Record<string, readonly FilterOperator[]>>;
  /** Allowed include paths (`?include=`). Not set: include is forbidden. */
  readonly include?: readonly string[];
  /** Paging limits. */
  readonly page?: PageOptions;
  /** Sorting when the request has no `sort`, in the same syntax: `"-createdAt,name"`. */
  readonly defaultSort?: string;
}
