/**
 * Формат сгенерированных конвенций привязки (`bun run di:generate`).
 *
 * Чистые данные без ссылок на классы: модель тела указана **именем** и
 * разрешается на старте через индекс классов generated target.
 * Спецификация хранит имя; отдельный generated target передаёт конструкторы.
 */
export interface GeneratedBindingSpec {
  readonly source: "route" | "query" | "body" | "context" | "request" | "response" | "list";
  /** Имя route-/query-параметра. */
  readonly name?: string;
  /** Конверсия примитива (для query и route без ограничения в шаблоне). */
  readonly type?: "int" | "number" | "bool" | "string";
  /** Параметр объявлен с `?` или default-значением. */
  readonly optional?: boolean;
  /** Имя класса DTO (разрешается через generated target; старый реестр — fallback). */
  readonly model?: string;
}

export type GeneratedBindingsMap = Readonly<Record<string, Readonly<Record<string, readonly GeneratedBindingSpec[]>>>>;
