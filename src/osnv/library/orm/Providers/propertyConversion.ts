import type { PropertyModel } from "../Metadata/types";
import type { SqlDialect, SqlParam } from "./types";

/** Кодирует значение свойства: конвертер -> диалект. */
export function encodeProperty(property: PropertyModel, value: unknown, dialect: SqlDialect): SqlParam {
  const modelValue = property.converter ? property.converter.toProvider(value) : value;
  return dialect.encode(modelValue, property.type);
}

/** Декодирует значение колонки: диалект -> конвертер. */
export function decodeProperty(property: PropertyModel, value: unknown, dialect: SqlDialect): unknown {
  const providerValue = dialect.decode(value, property.type);
  return property.converter ? property.converter.fromProvider(providerValue) : providerValue;
}
