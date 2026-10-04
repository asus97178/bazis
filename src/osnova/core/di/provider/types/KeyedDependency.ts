import type { Token } from "../../token";
import type { ServiceKey } from "../../types";

export interface KeyedDependency<T> {
  readonly token: Token<T>;
  readonly key: ServiceKey;
}

export function keyedDependency<T>(token: Token<T>, key: ServiceKey): KeyedDependency<T> {
  return { token, key };
}

export function isKeyedDependency(value: unknown): value is KeyedDependency<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "token" in (value as Record<string, unknown>) &&
      "key" in (value as Record<string, unknown>),
  );
}
