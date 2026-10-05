import { entityStorageKey } from "./tableKey";
import type { EntityModel, IndexModel, PropertyModel } from "../Metadata/types";
import type { IntrospectedSchema, IntrospectedTable } from "./introspection";

/**
 * Аддитивная операция изменения схемы. Деструктив (drop/смена типа) сюда не
 * попадает — он фиксируется как предупреждение, чтобы не терять данные.
 */
export type AdditiveSchemaOperation =
  | { readonly kind: "createTable"; readonly model: EntityModel }
  | { readonly kind: "addColumn"; readonly model: EntityModel; readonly property: PropertyModel }
  | { readonly kind: "createIndex"; readonly model: EntityModel; readonly index: IndexModel };

export interface SchemaDiff {
  readonly operations: readonly AdditiveSchemaOperation[];
  /** Найденные деструктивные расхождения, которые авто-режим не трогает. */
  readonly warnings: readonly string[];
}

/**
 * Сравнивает целевую модель (сущности контекста) с фактической схемой
 * БД и выдаёт список аддитивных операций. Текущее состояние берётся из
 * интроспекции — отдельный снапшот-файл не нужен.
 */
export class SchemaDiffer {
  diff(targets: readonly EntityModel[], schema: IntrospectedSchema): SchemaDiff {
    const operations: AdditiveSchemaOperation[] = [];
    const warnings: string[] = [];

    for (const model of targets) {
      const table =
        schema.tables.get(entityStorageKey(model)) ?? schema.tables.get(model.tableName);
      if (!table) {
        // Таблицы нет — создаём её целиком (вместе с индексами и FK).
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
    // Деструктив: колонки есть в БД, но нет в модели — не удаляем автоматически.
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
