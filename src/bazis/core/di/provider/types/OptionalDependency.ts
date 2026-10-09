import type { Token } from "../../token";
import type { KeyedDependency } from "./KeyedDependency";
import type { NamedDependency } from "./NamedDependency";

/**
 * Optional dependency: resolved when the token is registered, `undefined`
 * otherwise. Codegen emits it for an optional constructor parameter
 * (`cache?: ICache`, or one with a default value).
 */
export interface OptionalDependency<T> {
  readonly optional: true;
  readonly inner: Token<T> | KeyedDependency<T> | NamedDependency<T>;
}

export function optionalDependency<T>(inner: Token<T> | KeyedDependency<T> | NamedDependency<T>): OptionalDependency<T> {
  return { optional: true, inner };
}

export function isOptionalDependency(value: unknown): value is OptionalDependency<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).optional === true &&
      "inner" in (value as Record<string, unknown>),
  );
}
