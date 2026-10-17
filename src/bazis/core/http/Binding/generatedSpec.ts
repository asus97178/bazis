/**
 * Format of the generated binding conventions (`bazis codegen`).
 *
 * Plain data without class references: the body model is given **by name** and
 * resolved at startup through the class index of the generated target.
 * The spec stores the name; a separate generated target supplies the constructors.
 */
export interface GeneratedBindingSpec {
  readonly source: "route" | "query" | "header" | "body" | "queryModel" | "headerModel" | "context" | "request" | "response" | "list";
  /** Name of the route/query parameter, or the header (`FromHeader<string, "x-request-id">`). */
  readonly name?: string;
  /** Primitive conversion (for query, and route params without a constraint in the template). */
  readonly type?: "int" | "number" | "bool" | "string";
  /** The parameter is declared with `?` or a default value. */
  readonly optional?: boolean;
  /** A query array (`tag: string[]`): every `?tag=` value, each converted by `type`. */
  readonly array?: boolean;
  /** Body, query or header model class name (resolved through the generated target; `@RequestModel()` classes are the fallback). */
  readonly model?: string;
}
