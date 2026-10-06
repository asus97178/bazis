import { entityStorageKey } from "./tableKey";
import type { EntityModel, IndexModel, PropertyModel } from "../Metadata/types";
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
      this.diffIndexes(model, table, operations);
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
      if (!table.columns.has(property.columnName)) {
        operations.push({ kind: "addColumn", model, property });
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

  private diffIndexes(model: EntityModel, table: IntrospectedTable, operations: AdditiveSchemaOperation[]): void {
    const existing = new Set(table.indexes.map((index) => index.name));
    for (const index of model.indexes) {
      if (!existing.has(index.name)) {
        operations.push({ kind: "createIndex", model, index });
      }
    }
  }
}
