import type { EntityModel } from "../Metadata/types";
import type { Row, SqlDialect } from "../Providers/types";
import { decodeProperty } from "../Providers/propertyConversion";

/**
 * Hydrates a result row into an entity instance. A real class instance is
 * created (the constructor is called without arguments), then columns are
 * mapped to properties with reverse type conversion (through the dialect).
 */
export function materialize<T extends object>(model: EntityModel, row: Row, dialect: SqlDialect): T {
  const entity = new model.ctor() as Record<string, unknown>;
  for (const property of model.properties) {
    if (property.columnName in row) {
      entity[property.propertyName] = decodeProperty(property, row[property.columnName], dialect);
    }
  }
  return entity as T;
}

/** Projects a row into a plain object by the alias -> property list. */
export function materializeProjection(
  model: EntityModel,
  row: Row,
  dialect: SqlDialect,
  projections: readonly { readonly alias: string; readonly property: string }[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { alias, property: propertyName } of projections) {
    const property = model.propertyByName(propertyName);
    if (!property) {
      continue;
    }
    const column = alias in row ? alias : property.columnName;
    if (column in row) {
      result[alias] = decodeProperty(property, row[column], dialect);
    }
  }
  return result;
}
