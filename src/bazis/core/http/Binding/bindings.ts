import type { Class } from "../../di";
import type { ListQueryOptions } from "../../../library/jsonapi";
import type { ValueType } from "./convert";

/** Internal descriptors resolved from generated action signatures. */
export type BindingSource = "route" | "query" | "header" | "body" | "queryModel" | "headerModel" | "request" | "response" | "context" | "list";

/** One field of a query or header model, resolved once at startup. */
export interface SourceModelField {
  /** Property on the model instance. */
  readonly property: string;
  /** Name in the request: the query parameter, or the lower-case header name. */
  readonly wire: string;
  readonly type: "string" | "number" | "boolean";
  /** Every value of a repeated query parameter (`?tag=a&tag=b`). */
  readonly array: boolean;
}

export interface ParameterBinding {
  readonly source: BindingSource;
  readonly name?: string;
  readonly type?: ValueType;
  readonly defaultValue?: unknown;
  readonly optional?: boolean;
  /** Query array: all values of the name (`?tag=a&tag=b`), each converted by `type`. */
  readonly array?: boolean;
  /** Body, query or header model class (instantiated and validated). */
  readonly model?: Class<object>;
  /** Fields of a query or header model with their wire names and types. */
  readonly fields?: readonly SourceModelField[];
  /** Whitelist/limits for the class-based list binding (JSON:API list query). */
  readonly listOptions?: ListQueryOptions;
}

