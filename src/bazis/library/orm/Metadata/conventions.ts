/**
 * Default conventions. Applied in `ModelBuilder`; explicit decorator settings
 * always override what a convention infers.
 */

import type { ColumnOptionsType, ColumnType, PropertyConvention } from "./types";

/**
 * Plural form for a table name (simplified English rules).
 * Case is preserved: `User` -> `Users`, `Category` -> `Categories`.
 */
export function pluralize(name: string): string {
  if (name.length === 0) {
    return name;
  }
  if (/[^aeiou]y$/i.test(name)) {
    return `${name.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/i.test(name)) {
    return `${name}es`;
  }
  return `${name}s`;
}

/** Default table name. */
export function defaultTableName(className: string): string {
  return pluralize(className);
}

/**
 * Whether the property is the primary key by convention: `id` or
 * `<ClassName>Id` (case-insensitive).
 */
export function isConventionalKey(propertyName: string, className: string): boolean {
  const lower = propertyName.toLowerCase();
  return lower === "id" || lower === `${className.toLowerCase()}id`;
}

/** Splits a semantic `@Column({ type })` into a physical type and a convention. */
export function resolveColumnType(
  optionsType: ColumnOptionsType | undefined,
  isKey: boolean,
): { storageType: ColumnType; convention?: PropertyConvention; impliedRequired?: boolean } {
  switch (optionsType) {
    case "uuid":
      return { storageType: "text", convention: "uuid", impliedRequired: isKey };
    case "createdAt":
      return { storageType: "datetime", convention: "createdAt", impliedRequired: true };
    case "updatedAt":
      return { storageType: "datetime", convention: "updatedAt", impliedRequired: true };
    default:
      return { storageType: optionsType ?? (isKey ? "integer" : "text") };
  }
}
