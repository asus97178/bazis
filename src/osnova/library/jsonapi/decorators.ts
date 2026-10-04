import type { FilterOperator, ListQueryOptions, PageOptions } from "./types";

// Полифилл: Bun исполняет TC39-декораторы нативно, но Symbol.metadata может
// отсутствовать в рантайме. Symbol.for даёт общий символ для всех копий модуля.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** Ключ, под которым схема list-запроса лежит в метаданных класса. */
const LIST_SCHEMA = Symbol.for("osnova:listing:schema");

/** Разрешения одного поля: можно ли сортировать и какими операторами фильтровать. */
export interface FieldSchema {
  sortable: boolean;
  readonly filterOps: FilterOperator[];
}

/** Схема класса-запроса целиком (поля + лимиты пагинации + разрешённые include). */
export interface ListSchema {
  readonly fields: Record<string, FieldSchema>;
  page?: PageOptions;
  include?: readonly string[];
}

interface SchemaMetadata {
  [LIST_SCHEMA]?: ListSchema;
}

/** Параметры декоратора {@link ListOptions} (на уровне класса). */
export interface ListOptionsConfig {
  /** Размер страницы по умолчанию. */
  readonly defaultSize?: number;
  /** Максимально допустимый размер страницы. */
  readonly maxSize?: number;
  /** Разрешённые пути include (`?include=`). */
  readonly include?: readonly string[];
}

/**
 * Метаданные TC39-декораторов наследуются прототипно: метадата подкласса имеет
 * прототипом метадату родителя. При первой записи в конкретный класс делаем
 * copy-on-write, чтобы не мутировать схему родителя.
 */
function ensureOwnSchema(metadata: SchemaMetadata): ListSchema {
  if (!Object.prototype.hasOwnProperty.call(metadata, LIST_SCHEMA)) {
    const inherited = metadata[LIST_SCHEMA];
    metadata[LIST_SCHEMA] = inherited
      ? { fields: cloneFields(inherited.fields), page: inherited.page, include: inherited.include }
      : { fields: {} };
  }
  return metadata[LIST_SCHEMA]!;
}

function cloneFields(fields: Record<string, FieldSchema>): Record<string, FieldSchema> {
  const out: Record<string, FieldSchema> = {};
  for (const [name, schema] of Object.entries(fields)) {
    out[name] = { sortable: schema.sortable, filterOps: [...schema.filterOps] };
  }
  return out;
}

function fieldOf(schema: ListSchema, name: string): FieldSchema {
  return (schema.fields[name] ??= { sortable: false, filterOps: [] });
}

function assertInstanceField(context: ClassFieldDecoratorContext, decorator: string): void {
  if (context.static) {
    throw new Error(`${decorator}: статическое поле "${String(context.name)}" не поддерживается.`);
  }
  if (context.private) {
    throw new Error(`${decorator}: приватное поле "${String(context.name)}" не поддерживается.`);
  }
}

/**
 * Разрешает сортировку по полю (`?sort=field` / `?sort=-field`).
 *
 * ```ts
 * class UserListQuery extends ListRequest<User> {
 *   @Sortable() name!: string;
 * }
 * ```
 */
export function Sortable() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    assertInstanceField(context, "@Sortable");
    fieldOf(ensureOwnSchema(context.metadata as SchemaMetadata), String(context.name)).sortable = true;
  };
}

/**
 * Разрешает фильтрацию по полю перечисленными операторами
 * (`?filter[field][op]=value`).
 *
 * ```ts
 * class UserListQuery extends ListRequest<User> {
 *   @Filterable("eq", "contains") name!: string;
 *   @Filterable("gte", "lte", "in") age!: number;
 * }
 * ```
 */
export function Filterable(...operators: FilterOperator[]) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    assertInstanceField(context, "@Filterable");
    const field = fieldOf(ensureOwnSchema(context.metadata as SchemaMetadata), String(context.name));
    for (const operator of operators) {
      if (!field.filterOps.includes(operator)) {
        field.filterOps.push(operator);
      }
    }
  };
}

/**
 * Лимиты пагинации и разрешённые include для класса-запроса.
 *
 * ```ts
 * @ListOptions({ defaultSize: 20, maxSize: 100, include: ["posts"] })
 * class UserListQuery extends ListRequest<User> { ... }
 * ```
 */
export function ListOptions(config: ListOptionsConfig) {
  return (_value: unknown, context: ClassDecoratorContext): void => {
    const schema = ensureOwnSchema(context.metadata as SchemaMetadata);
    schema.page = { defaultSize: config.defaultSize, maxSize: config.maxSize };
    if (config.include !== undefined) {
      schema.include = config.include;
    }
  };
}

/** Схема класса-запроса (включая унаследованную) или `undefined`. */
export function listSchemaOf(ctor: unknown): ListSchema | undefined {
  if (typeof ctor !== "function") {
    return undefined;
  }
  const metadata = (ctor as unknown as { [key: symbol]: unknown })[Symbol.metadata as symbol] as
    | SchemaMetadata
    | undefined;
  return metadata?.[LIST_SCHEMA];
}

/**
 * Собирает {@link ListQueryOptions} (белый список для {@link parseListQuery})
 * из декларативной схемы класса-запроса.
 */
export function optionsFromSchema(ctor: unknown): ListQueryOptions {
  const schema = listSchemaOf(ctor);
  if (schema === undefined) {
    return {};
  }
  const sort: string[] = [];
  const filter: Record<string, readonly FilterOperator[]> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.sortable) {
      sort.push(name);
    }
    if (field.filterOps.length > 0) {
      filter[name] = field.filterOps;
    }
  }
  return { sort, filter, include: schema.include, page: schema.page };
}
