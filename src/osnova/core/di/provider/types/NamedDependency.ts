export interface NamedDependency<T = unknown> {
  readonly name: string;
}

export function namedDependency<T = unknown>(name: string): NamedDependency<T> {
  return { name };
}

export function isNamedDependency(value: unknown): value is NamedDependency<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).name === "string",
  );
}
