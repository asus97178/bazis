import type { ColumnType } from "../Metadata/types";
import type { SqlParam } from "./types";

/**
 * Конвертация значения свойства в параметр запроса.
 * Конвертация централизована, чтобы привязка всегда была
 * параметризованной (никакой конкатенации).
 */
export function toDbValue(value: unknown, type: ColumnType): SqlParam {
  if (value === undefined || value === null) {
    return null;
  }
  switch (type) {
    case "boolean":
      return value ? 1 : 0;
    case "datetime":
      return value instanceof Date ? value.toISOString() : String(value);
    case "json":
      return JSON.stringify(value);
    case "integer":
    case "real":
      return typeof value === "bigint" ? value : Number(value);
    case "text":
      return typeof value === "string" ? value : String(value);
  }
}

/** Обратная конвертация значения колонки в значение свойства. */
export function fromDbValue(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  switch (type) {
    case "boolean":
      return value === 1 || value === true || value === "1";
    case "datetime":
      return typeof value === "string" || typeof value === "number" ? new Date(value) : value;
    case "json":
      return typeof value === "string" ? safeParse(value) : value;
    case "integer":
      return typeof value === "bigint" ? value : Number(value);
    case "real":
      return Number(value);
    case "text":
      return typeof value === "string" ? value : String(value);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
