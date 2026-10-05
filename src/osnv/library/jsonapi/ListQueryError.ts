/** Одна проблема разбора list-запроса (привязана к конкретному параметру). */
export interface ListQueryProblem {
  /** Имя query-параметра, например `sort`, `filter[age]`, `page[size]`. */
  readonly parameter: string;
  /** Человекочитаемое описание проблемы. */
  readonly message: string;
}

/**
 * Ошибка разбора/валидации list-запроса. Собирает все проблемы сразу, чтобы
 * клиент увидел полный список, а не первую попавшуюся.
 *
 * Библиотека намеренно не знает про HTTP — слой интеграции маппит её в 400
 * (см. биндинг `List(...)` в `@/core/http`).
 */
export class ListQueryError extends Error {
  constructor(readonly problems: readonly ListQueryProblem[]) {
    super(
      problems.length > 0
        ? problems.map((problem) => `${problem.parameter}: ${problem.message}`).join("; ")
        : "Invalid list query",
    );
    this.name = "ListQueryError";
  }
}
