import type { Class } from "../../di";
import type { ListQueryOptions } from "../../../library/jsonapi";
import type { ValueType } from "./convert";

/** Internal descriptors resolved from generated action signatures. */
export type BindingSource = "route" | "query" | "body" | "request" | "response" | "context" | "list";

export interface ParameterBinding {
  readonly source: BindingSource;
  readonly name?: string;
  readonly type?: ValueType;
  readonly defaultValue?: unknown;
  readonly optional?: boolean;
  /** Body model class (instantiated, sanitized and validated). */
  readonly model?: Class<object>;
  /** Whitelist/limits for the class-based list binding (JSON:API list query). */
  readonly listOptions?: ListQueryOptions;
}

