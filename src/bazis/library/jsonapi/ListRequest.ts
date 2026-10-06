import type { FilterGroup, FilterRule, ListQuery, PageParams, SortField } from "./types";

const EMPTY_PAGE: PageParams = { number: 1, size: 20, offset: 0, limit: 20 };

/**
 * Base class of a typed list request. A subclass declares the allowed "request
 * surface" with field decorators (`@Sortable`, `@Filterable`) and limits
 * (`@ListOptions`); the kernel recognizes such a controller parameter by its
 * `ListRequest` base and fills the instance with the parsed
 * `sort`/`filters`/`page`, **by signature**.
 *
 * Implements {@link ListQuery}, so it is passed straight to `paginate(...)`.
 *
 * ```ts
 * @ListOptions({ defaultSize: 20, maxSize: 100 })
 * class UserListQuery extends ListRequest<User> {
 *   @Sortable() @Filterable("eq", "contains") name!: string;
 *   @Sortable() @Filterable("gte", "lte", "in") age!: number;
 * }
 *
 * // controller, by signature:
 * list(query: UserListQuery) { return this.users.list(query); }
 * ```
 *
 * The type parameter `T` is a phantom entity marker for readability; it is not
 * used at runtime.
 */
export class ListRequest<T = unknown> implements ListQuery {
  declare readonly __entity?: T;

  sort: readonly SortField[] = [];
  filters: readonly FilterRule[] = [];
  or: readonly FilterGroup[] = [];
  page: PageParams = EMPTY_PAGE;
  include: readonly string[] = [];
  fields: Readonly<Record<string, readonly string[]>> = {};
}
