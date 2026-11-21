import type { ListQueryOptions } from "./types";

/**
 * The options with sorting and filtering left only for `fields`: the fields the
 * caller may read in every row of the list. A filter or a sort by a closed
 * field tells its values, so the request gets the usual answer of
 * {@link parseListQuery}: `filtering by "total" is not allowed`. A `defaultSort`
 * that names a closed field is taken off: the order of rows tells the values too.
 *
 * ```ts
 * const fields = await access.filterableFields("orders.read");
 * const query = parseListQuery(params, restrictListOptions(optionsFromSchema(OrderList), fields));
 * ```
 */
export function restrictListOptions(options: ListQueryOptions, fields: "all" | readonly string[]): ListQueryOptions {
  if (fields === "all") return options;
  const open = new Set(fields);
  const { sort, filter, defaultSort, ...rest } = options;
  return {
    ...rest,
    ...(sort === undefined ? {} : { sort: sort.filter((field) => open.has(field)) }),
    ...(filter === undefined ? {} : { filter: Object.fromEntries(Object.entries(filter).filter(([field]) => open.has(field))) }),
    ...(defaultSort === undefined || !sortFields(defaultSort).every((field) => open.has(field)) ? {} : { defaultSort }),
  };
}

/** The field names of a `sort` value: `"-createdAt,name"` → `createdAt`, `name`. */
function sortFields(sort: string): readonly string[] {
  return sort.split(",").map((token) => token.trim().replace(/^[-+]/, "")).filter((field) => field !== "");
}
