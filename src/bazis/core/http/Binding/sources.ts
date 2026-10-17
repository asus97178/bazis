// Standard TC39 decorators have no parameter decorators, so the source of a
// controller argument is part of its type: `size: FromQuery<number, "page_size">`.
// The types are erased at runtime; `bazis codegen` reads them from the method
// signature. On a field of a query or header model the same names are field
// decorators that set the name on the wire: `@FromQuery("page_size") pageSize = 20`.

// Bun runs standard decorators natively, but Symbol.metadata may be missing.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const QUERY_NAMES = Symbol.for("bazis:http:query-names");
const HEADER_NAMES = Symbol.for("bazis:http:header-names");

/**
 * From the query string. A primitive (`FromQuery<number>`, optionally with the
 * name on the wire: `FromQuery<number, "page_size">`) or a class whose fields
 * are bound and validated like a request body: `FromQuery<SearchQuery>`.
 */
export type FromQuery<T, Name extends string = never> = [Name] extends [never] ? T : T;
/** From a request header: `FromHeader<string, "x-request-id">` or a header model `FromHeader<TenantHeaders>`. */
export type FromHeader<T, Name extends string = never> = [Name] extends [never] ? T : T;
/** From the JSON body: a request-model class, bound and validated before the action runs. */
export type FromBody<T> = T;
/** From a route parameter: `FromRoute<number>` or `FromRoute<string, "slug">`. */
export type FromRoute<T, Name extends string = never> = [Name] extends [never] ? T : T;

/** Query parameter name of a query-model field: `@FromQuery("page_size") pageSize = 20`. */
export function FromQuery(name: string): (value: undefined, context: ClassFieldDecoratorContext) => void {
  return (_value, context) => setWireName(context, QUERY_NAMES, "FromQuery", checkedName(name, "FromQuery", QUERY_NAME));
}

/** Header name of a header-model field: `@FromHeader("x-tenant-id") tenantId!: string`. */
export function FromHeader(name: string): (value: undefined, context: ClassFieldDecoratorContext) => void {
  return (_value, context) => setWireName(context, HEADER_NAMES, "FromHeader", checkedName(name, "FromHeader", HEADER_NAME).toLowerCase());
}

/** Wire names of a query or header model: field name → name in the request. */
export function wireNamesOf(model: object, source: "query" | "header"): ReadonlyMap<string, string> {
  const metadata = (model as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as WireNameMetadata | undefined;
  return metadata?.[source === "query" ? QUERY_NAMES : HEADER_NAMES] ?? EMPTY;
}

interface WireNameMetadata {
  [QUERY_NAMES]?: Map<string, string>;
  [HEADER_NAMES]?: Map<string, string>;
}

const EMPTY: ReadonlyMap<string, string> = new Map();
/** Printable ASCII without spaces; `[]` stay allowed for names like `ids[]`. */
const QUERY_NAME = /^[\x21-\x7e]{1,256}$/;
/** RFC 9110 token: the characters a header name may contain. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

function checkedName(name: string, decorator: string, pattern: RegExp): string {
  if (typeof name !== "string" || !pattern.test(name)) {
    throw new TypeError(`@${decorator}: invalid name ${JSON.stringify(name)}.`);
  }
  return name;
}

function setWireName(context: ClassFieldDecoratorContext, key: typeof QUERY_NAMES | typeof HEADER_NAMES, decorator: string, name: string): void {
  if (context.static || context.private || typeof context.name !== "string") {
    throw new TypeError(`@${decorator}: "${String(context.name)}" must be a public instance field.`);
  }
  const metadata = context.metadata as WireNameMetadata;
  // Metadata is inherited prototypically: copy on the first write to this class.
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
    metadata[key] = new Map(metadata[key] ?? []);
  }
  const names = metadata[key]!;
  for (const [field, existing] of names) {
    if (existing === name && field !== context.name) {
      throw new TypeError(`@${decorator}: "${name}" is used by both "${field}" and "${context.name}".`);
    }
  }
  names.set(context.name, name);
}
