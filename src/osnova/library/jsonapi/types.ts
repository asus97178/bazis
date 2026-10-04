/**
 * Типы универсального list-запроса в стиле спецификации JSON:API.
 *
 * Запрос описывается query-параметрами:
 * - `?sort=name,-createdAt` — сортировка (минус = по убыванию);
 * - `?filter[age][gte]=18&filter[name]=Bob` — фильтрация (без оператора = `eq`),
 *   условия верхнего уровня объединяются через AND;
 * - `?filter[or][0][age][lte]=19&filter[or][1][age][gte]=41` — OR-группы:
 *   внутри группы AND, между группами OR (`filters AND (g0 OR g1 ...)`);
 * - `?page[number]=2&page[size]=20` или `?page[offset]=40&page[limit]=20` — пагинация;
 * - `?include=posts,author` — жадная загрузка связей;
 * - `?fields[users]=name,age` — разреженные наборы полей (проекция).
 *
 * Тип чистый (никаких зависимостей от ядра/среды): парсер и сборка ответа
 * работают только с Web-API (`URLSearchParams`).
 */

/** Направление сортировки. */
export type SortDirection = "asc" | "desc";

/** Один ключ сортировки. */
export interface SortField {
  readonly field: string;
  readonly dir: SortDirection;
}

/**
 * Оператор фильтра. Имена совпадают с операторами сравнения большинства ORM:
 * - `eq`/`ne` — равно/не равно (значение `null` трактуется как IS [NOT] NULL);
 * - `gt`/`gte`/`lt`/`lte` — сравнения;
 * - `like` — LIKE с пользовательским шаблоном; `contains`/`startsWith`/`endsWith`
 *   — LIKE с экранированными джокерами;
 * - `in`/`nin` — вхождение/невхождение в список (значение через запятую);
 * - `isNull`/`isNotNull` — проверка на NULL (значение не требуется).
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

/** Одно условие фильтра по полю. */
export interface FilterRule {
  readonly field: string;
  readonly op: FilterOperator;
  /** Для `in`/`nin` — массив; для `isNull`/`isNotNull` — пустая строка. */
  readonly value: string | readonly string[];
}

/**
 * Группа условий, объединённых через **AND** — одна ветка OR-выражения.
 * Несколько групп объединяются через **OR** (см. {@link ListQuery.or}).
 */
export type FilterGroup = readonly FilterRule[];

/**
 * Нормализованная пагинация. Любой из стилей JSON:API (`page[number]/size`
 * или `page[offset]/limit`) приводится к единому виду: для БД используем
 * `offset`/`limit`, для ответа — `number`/`size`.
 */
export interface PageParams {
  /** Номер страницы (1-based). */
  readonly number: number;
  /** Размер страницы. */
  readonly size: number;
  /** Смещение (0-based) = `(number - 1) * size`. */
  readonly offset: number;
  /** Лимит = `size`. */
  readonly limit: number;
}

/** Полностью разобранный и провалидированный list-запрос. */
export interface ListQuery {
  readonly sort: readonly SortField[];
  /**
   * Условия верхнего уровня (`filter[field][op]=v`), объединённые через **AND**.
   * Применяются всегда.
   */
  readonly filters: readonly FilterRule[];
  /**
   * OR-группы (`filter[or][N][field][op]=v`): внутри группы условия объединяются
   * через AND, разные группы — через OR. Всё OR-выражение объединяется с
   * {@link filters} через AND: `filters AND (group0 OR group1 OR ...)`. Пусто —
   * OR-логика не применяется.
   */
  readonly or: readonly FilterGroup[];
  readonly page: PageParams;
  readonly include: readonly string[];
  /** Разреженные наборы полей по типу ресурса (`fields[type]=a,b`). */
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

/** Пределы и дефолты пагинации. */
export interface PageOptions {
  /** Размер страницы по умолчанию (если клиент не задал). По умолчанию 20. */
  readonly defaultSize?: number;
  /** Максимально допустимый размер страницы. По умолчанию 100. */
  readonly maxSize?: number;
}

/**
 * Контракт разрешённого для запроса. Безопасность по умолчанию: всё, что не
 * перечислено явно, запрещено (сортировка/фильтр/include по неуказанным полям
 * приводят к 400). Так клиент не может обратиться к внутренним колонкам.
 */
export interface ListQueryOptions {
  /** Поля, по которым разрешена сортировка (`?sort=`). Не задано — сортировка запрещена. */
  readonly sort?: readonly string[];
  /** Поля → разрешённые операторы фильтра. Не задано — фильтрация запрещена. */
  readonly filter?: Readonly<Record<string, readonly FilterOperator[]>>;
  /** Разрешённые пути include (`?include=`). Не задано — include запрещён. */
  readonly include?: readonly string[];
  /** Пределы пагинации. */
  readonly page?: PageOptions;
}
