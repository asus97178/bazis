import type { FilterGroup, FilterRule, ListQuery, PageParams, SortField } from "./types";

const EMPTY_PAGE: PageParams = { number: 1, size: 20, offset: 0, limit: 20 };

/**
 * Базовый класс типизированного list-запроса. Наследник декларирует
 * разрешённую «поверхность запроса» декораторами полей (`@Sortable`,
 * `@Filterable`) и лимиты (`@ListOptions`); ядро распознаёт такой параметр
 * контроллера по наследованию от `ListRequest` и наполняет инстанс разобранными
 * `sort`/`filters`/`page` — **по сигнатуре**.
 *
 * Реализует {@link ListQuery}, поэтому передаётся прямо в `paginate(...)`.
 *
 * ```ts
 * @ListOptions({ defaultSize: 20, maxSize: 100 })
 * class UserListQuery extends ListRequest<User> {
 *   @Sortable() @Filterable("eq", "contains") name!: string;
 *   @Sortable() @Filterable("gte", "lte", "in") age!: number;
 * }
 *
 * // контроллер — по сигнатуре:
 * list(query: UserListQuery) { return this.users.list(query); }
 * ```
 *
 * Параметр-тип `T` — фантомный маркер сущности (для читаемости и будущих
 * типобезопасных хелперов); в рантайме не используется.
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
