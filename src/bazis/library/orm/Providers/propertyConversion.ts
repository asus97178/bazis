import { OrmError } from "../errors";
import type { PropertyModel } from "../Metadata/types";
import type { SqlDialect, SqlParam } from "./types";

/**
 * Whether the converter of the property applies to the value: `null` and
 * `undefined` stay SQL NULL unless the converter declares `convertsNulls`.
 */
export function convertsValue(property: PropertyModel, value: unknown): boolean {
  return property.converter !== undefined && (property.converter.convertsNulls === true || (value !== null && value !== undefined));
}

/** Encodes a property value: converter -> dialect. */
export function encodeProperty(property: PropertyModel, value: unknown, dialect: SqlDialect): SqlParam {
  const modelValue = convertsValue(property, value) ? property.converter!.toProvider(value) : value;
  return dialect.encode(modelValue, property.type);
}

/** Decodes a column value: dialect -> converter. A converter failure names the entity and the property. */
export function decodeProperty(property: PropertyModel, value: unknown, dialect: SqlDialect, owner?: string): unknown {
  const providerValue = dialect.decode(value, property.type);
  if (!property.converter || !convertsValue(property, providerValue)) return providerValue;
  try {
    return property.converter.fromProvider(providerValue);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OrmError(`Cannot read ${owner ?? "entity"}.${property.propertyName}: ${reason}`, { cause: error });
  }
}

/**
 * A condition or an ordering on a column whose converter stores equal values
 * differently (encryption with a random nonce) cannot work in SQL.
 */
export function assertComparable(property: PropertyModel, owner: string): void {
  if (property.converter?.comparable !== false) return;
  throw new OrmError(
    `${owner}.${property.propertyName} is encrypted with a random nonce: it cannot be compared or sorted in SQL. ` +
      `To find rows by it, store a separate column with a keyed hash of the value (HMAC) and compare that.`,
  );
}
