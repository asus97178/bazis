import type { ListQuery } from "./types";

/** Метаданные коллекции (счётчики страниц) — кладутся в `meta` ответа. */
export interface ListMeta {
  /** Общее число записей с учётом фильтров (без пагинации). */
  readonly total: number;
  /** Номер текущей страницы (1-based). */
  readonly page: number;
  /** Размер страницы. */
  readonly size: number;
  /** Всего страниц = `ceil(total / size)`. */
  readonly pageCount: number;
}

/** Ссылки пагинации в стиле JSON:API (`links`). */
export interface ListLinks {
  readonly self: string;
  readonly first: string;
  readonly last: string;
  readonly prev?: string;
  readonly next?: string;
}

/**
 * Документ-ответ коллекции. `data` — сами элементы (сущности или DTO), `meta`
 * — счётчики, `links` — навигация по страницам (если задан `basePath`).
 */
export interface ListDocument<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
  readonly links?: ListLinks;
}

/** Опции сборки {@link ListDocument}. */
export interface BuildListDocumentOptions {
  /**
   * Базовый путь для ссылок пагинации, например `"/api/users"`. Если не задан,
   * `links` не строятся (полезно, когда ссылки не нужны).
   */
  readonly basePath?: string;
}

/**
 * Собирает JSON:API-подобный документ коллекции из элементов страницы, исходного
 * запроса и общего числа записей.
 *
 * ```ts
 * const { items, total } = await paginate(repo.query(), query);
 * return buildListDocument(items, query, total, { basePath: "/api/users" });
 * ```
 */
export function buildListDocument<T>(
  items: readonly T[],
  query: ListQuery,
  total: number,
  options: BuildListDocumentOptions = {},
): ListDocument<T> {
  const size = query.page.size;
  const pageCount = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  const meta: ListMeta = { total, page: query.page.number, size, pageCount };

  if (options.basePath === undefined) {
    return { data: items, meta };
  }
  return { data: items, meta, links: buildLinks(query, options.basePath, meta) };
}

/**
 * Сериализует запрос в query-строку JSON:API (без ведущего `?`). Полезно для
 * построения ссылок и для round-trip в тестах.
 */
export function serializeListQuery(query: ListQuery, pageNumber?: number): string {
  return toSearchParams(query, pageNumber).toString();
}

function buildLinks(query: ListQuery, basePath: string, meta: ListMeta): ListLinks {
  const link = (page: number): string => `${basePath}?${serializeListQuery(query, page)}`;
  const links: ListLinks = {
    self: link(meta.page),
    first: link(1),
    last: link(meta.pageCount),
    ...(meta.page > 1 ? { prev: link(meta.page - 1) } : {}),
    ...(meta.page < meta.pageCount ? { next: link(meta.page + 1) } : {}),
  };
  return links;
}

function toSearchParams(query: ListQuery, pageNumber?: number): URLSearchParams {
  const params = new URLSearchParams();

  if (query.sort.length > 0) {
    params.set("sort", query.sort.map((s) => `${s.dir === "desc" ? "-" : ""}${s.field}`).join(","));
  }

  for (const rule of query.filters) {
    const key = rule.op === "eq" ? `filter[${rule.field}]` : `filter[${rule.field}][${rule.op}]`;
    const value = Array.isArray(rule.value) ? rule.value.join(",") : (rule.value as string);
    params.append(key, value);
  }

  query.or.forEach((group, index) => {
    for (const rule of group) {
      const key =
        rule.op === "eq"
          ? `filter[or][${index}][${rule.field}]`
          : `filter[or][${index}][${rule.field}][${rule.op}]`;
      const value = Array.isArray(rule.value) ? rule.value.join(",") : (rule.value as string);
      params.append(key, value);
    }
  });

  params.set("page[number]", String(pageNumber ?? query.page.number));
  params.set("page[size]", String(query.page.size));

  if (query.include.length > 0) {
    params.set("include", query.include.join(","));
  }
  for (const [type, list] of Object.entries(query.fields)) {
    if (list.length > 0) {
      params.set(`fields[${type}]`, list.join(","));
    }
  }
  return params;
}
