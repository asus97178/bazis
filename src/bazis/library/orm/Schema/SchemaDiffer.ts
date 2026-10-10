import { entityStorageKey } from "./tableKey";
import type { ColumnType, EntityModel, IndexModel, PropertyModel } from "../Metadata/types";
import type { IntrospectedSchema, IntrospectedTable } from "./introspection";

/**
 * Additive schema change operation. Destructive changes (drop/type change) never
 * get here; they are recorded as warnings so no data is lost.
 */
export type AdditiveSchemaOperation =
  | { readonly kind: "createTable"; readonly model: EntityModel }
  | { readonly kind: "addColumn"; readonly model: EntityModel; readonly property: PropertyModel }
  | { readonly kind: "createIndex"; readonly model: EntityModel; readonly index: IndexModel };

export interface SchemaDiff {
  readonly operations: readonly AdditiveSchemaOperation[];
  /** Destructive differences found, which the auto mode leaves alone. */
  readonly warnings: readonly string[];
}

/**
 * Compares the target model (the context entities) with the actual database
 * schema and returns a list of additive operations. The current state comes
 * from introspection; no separate snapshot file is needed.
 */
export class SchemaDiffer {
  /** `types` are the physical column types (UUID foreign keys follow their keys); without them types are not compared. */
  constructor(private readonly types?: ReadonlyMap<PropertyModel, ColumnType | "uuid">) {}

  diff(targets: readonly EntityModel[], schema: IntrospectedSchema): SchemaDiff {
    const operations: AdditiveSchemaOperation[] = [];
    const warnings: string[] = [];

    for (const model of targets) {
      const table =
        schema.tables.get(entityStorageKey(model)) ?? schema.tables.get(model.tableName);
      if (!table) {
        // No table: create it whole (with indexes and FKs).
        operations.push({ kind: "createTable", model });
        for (const index of model.indexes) {
          operations.push({ kind: "createIndex", model, index });
        }
        continue;
      }
      this.diffColumns(model, table, operations, warnings);
      this.diffIndexes(model, table, operations, warnings);
    }

    return { operations, warnings };
  }

  private diffColumns(
    model: EntityModel,
    table: IntrospectedTable,
    operations: AdditiveSchemaOperation[],
    warnings: string[],
  ): void {
    for (const property of model.properties) {
      const column = table.columns.get(property.columnName);
      if (!column) {
        operations.push({ kind: "addColumn", model, property });
        continue;
      }
      // Changing a type or NULL-ability can lose data or fail on existing rows: report, never apply.
      const expectedType = this.types?.get(property);
      if (expectedType !== undefined && column.physicalType !== undefined && column.physicalType !== expectedType) {
        warnings.push(`table "${model.tableName}": column "${property.columnName}" is ${column.physicalType} in the database but ${expectedType} in the model (left untouched; change it with an explicit migration).`);
      }
      if (!property.isKey && property.required && !column.notNull) {
        warnings.push(`table "${model.tableName}": column "${property.columnName}" allows NULL in the database but is required in the model (left untouched; fill the NULL values and set NOT NULL with an explicit migration).`);
      }
      if (!property.isKey && !property.required && column.notNull) {
        warnings.push(`table "${model.tableName}": column "${property.columnName}" is NOT NULL in the database but nullable in the model (left untouched; drop NOT NULL with an explicit migration).`);
      }
    }
    // Destructive: columns exist in the database but not in the model; never dropped automatically.
    const modelColumns = new Set(model.properties.map((property) => property.columnName));
    for (const columnName of table.columns.keys()) {
      if (!modelColumns.has(columnName)) {
        warnings.push(
          `table "${model.tableName}": column "${columnName}" exists in the database but not in the model (left untouched; drop it with an explicit migration).`,
        );
      }
    }
  }

  private diffIndexes(model: EntityModel, table: IntrospectedTable, operations: AdditiveSchemaOperation[], warnings: string[]): void {
    const existing = new Set(table.indexes.map((index) => index.name));
    const declared = new Set(model.indexes.map((index) => index.name));
    for (const index of model.indexes) {
      if (existing.has(index.name)) continue;
      // The same index under another name (for example from before 0.98.20) is not duplicated.
      const renamed = table.indexes.find((item) => !declared.has(item.name) && !item.backingConstraint && !item.predicate && item.unique === index.unique
        && item.columns.length === index.columns.length && item.columns.every((column, position) => column === index.columns[position]));
      if (renamed) {
        warnings.push(`table "${model.tableName}": index "${renamed.name}" matches "${index.name}" from the model except for its name (left untouched; to align it run: ALTER INDEX "${renamed.name}" RENAME TO "${index.name}";).`);
        continue;
      }
      operations.push({ kind: "createIndex", model, index });
    }
  }
}
