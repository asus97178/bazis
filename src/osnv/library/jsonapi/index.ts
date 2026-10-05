/**
 * Universal list request in the style of the JSON:API specification.
 *
 * A pure library (Web APIs only, zero dependencies on the kernel/environment),
 * compatible with binary compilation. It consists of:
 * - {@link parseListQuery}: parses query parameters (`sort`/`filter`/`page`/
 *   `include`/`fields`) into a typed, validated {@link ListQuery};
 * - {@link buildListDocument}: builds the collection response (`data`/`meta`/`links`);
 * - {@link ListQueryError}: the parsing error (the HTTP layer maps it to 400).
 *
 * Applying the request to a data source is a separate integration layer:
 * the ORM bridge is `paginate(...)` in `@/core/orm`, the binding is `ListRequest`
 * in `@/core/http`.
 */
export { parseListQuery } from "./parseListQuery";
export { buildListDocument, serializeListQuery } from "./document";
export type { BuildListDocumentOptions, ListDocument, ListLinks, ListMeta } from "./document";
export { ListQueryError, type ListQueryProblem } from "./ListQueryError";
export { ListRequest } from "./ListRequest";
export {
  Filterable,
  ListOptions,
  Sortable,
  listSchemaOf,
  optionsFromSchema,
  type FieldSchema,
  type ListOptionsConfig,
  type ListSchema,
} from "./decorators";
export type {
  FilterGroup,
  FilterOperator,
  FilterRule,
  ListQuery,
  ListQueryOptions,
  PageOptions,
  PageParams,
  SortDirection,
  SortField,
} from "./types";
