/**
 * Универсальный list-запрос в стиле спецификации JSON:API.
 *
 * Чистая библиотека (только Web-API, ноль зависимостей от ядра/среды),
 * совместима с компиляцией в бинарник. Состоит из:
 * - {@link parseListQuery} — разбор query-параметров (`sort`/`filter`/`page`/
 *   `include`/`fields`) в типизированный {@link ListQuery} с валидацией;
 * - {@link buildListDocument} — сборка ответа коллекции (`data`/`meta`/`links`);
 * - {@link ListQueryError} — ошибка разбора (слой HTTP маппит её в 400).
 *
 * Применение запроса к источнику данных — отдельный слой интеграции:
 * мост к ORM — `paginate(...)` в `@/core/orm`, биндинг — `List(...)`
 * в `@/core/http`.
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
