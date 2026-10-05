/**
 * Соглашения по умолчанию. Применяются в `ModelBuilder`, где явные настройки
 * декораторов всегда переопределяют выведенное по соглашению.
 */

import type { ColumnOptionsType, ColumnType, PropertyConvention } from "./types";

/**
 * Множественное число для имени таблицы (упрощённые правила английского).
 * Регистр сохраняется: `User` -> `Users`, `Category` -> `Categories`.
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

/** Имя таблицы по умолчанию. */
export function defaultTableName(className: string): string {
  return pluralize(className);
}

/**
 * Является ли свойство первичным ключом по соглашению: `id` или
 * `<ClassName>Id` (регистронезависимо).
 */
export function isConventionalKey(propertyName: string, className: string): boolean {
  const lower = propertyName.toLowerCase();
  return lower === "id" || lower === `${className.toLowerCase()}id`;
}

/** Раскладывает семантический `@Column({ type })` на физический тип и соглашение. */
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
