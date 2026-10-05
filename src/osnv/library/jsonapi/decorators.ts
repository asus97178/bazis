import type { FilterOperator, ListQueryOptions, PageOptions } from "./types";

// Polyfill: Bun runs TC39 decorators natively, but Symbol.metadata may be
// missing at runtime. Symbol.for gives one shared symbol for all module copies.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** Key under which the list-request schema is stored in the class metadata. */
const LIST_SCHEMA = Symbol.for("osnv:listing:schema");

/** Permissions of one field: whether it is sortable and which filter operators are allowed. */
export interface FieldSchema {
  sortable: boolean;
  readonly filterOps: FilterOperator[];
}

/** The whole request-class schema (fields + paging limits + allowed includes). */
export interface ListSchema {
  readonly fields: Record<string, FieldSchema>;
  page?: PageOptions;
  include?: readonly string[];
}

interface SchemaMetadata {
  [LIST_SCHEMA]?: ListSchema;
}

/** Parameters of the {@link ListOptions} decorator (class level). */
export interface ListOptionsConfig {
  /** Default page size. */
  readonly defaultSize?: number;
  /** Maximum allowed page size. */
  readonly maxSize?: number;
  /** Allowed include paths (`?include=`). */
  readonly include?: readonly string[];
}

/**
 * TC39 decorator metadata is inherited prototypically: a subclass's metadata
 * has the parent's metadata as its prototype. On the first write to a concrete
 * class we copy on write so the parent schema is not mutated.
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
    throw new Error(`${decorator}: static field "${String(context.name)}" is not supported.`);
  }
  if (context.private) {
    throw new Error(`${decorator}: private field "${String(context.name)}" is not supported.`);
  }
}

/**
 * Allows sorting by the field (`?sort=field` / `?sort=-field`).
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
 * Allows filtering by the field with the listed operators
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
 * Paging limits and allowed includes for a request class.
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

/** Schema of a request class (including the inherited one), or `undefined`. */
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
 * Builds {@link ListQueryOptions} (the allow list for {@link parseListQuery})
 * from the declarative schema of a request class.
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
