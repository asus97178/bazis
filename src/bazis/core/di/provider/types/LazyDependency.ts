import type { Token } from "../../token";
import type { KeyedDependency } from "./KeyedDependency";
import type { NamedDependency } from "./NamedDependency";

/**
 * Deferred dependency: the wrapped service is created on first `.value`
 * access (and cached), not when the consumer is constructed.
 */
export interface Lazy<T> {
  readonly value: T;
  /** True once the underlying service has been created. */
  readonly isCreated: boolean;
}

export interface LazyDependency<T> {
  readonly lazy: true;
  readonly inner: Token<T> | KeyedDependency<T> | NamedDependency<T>;
}

export function lazyDependency<T>(inner: Token<T> | KeyedDependency<T> | NamedDependency<T>): LazyDependency<T> {
  return { lazy: true, inner };
}

export function isLazyDependency(value: unknown): value is LazyDependency<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).lazy === true &&
      "inner" in (value as Record<string, unknown>),
  );
}
