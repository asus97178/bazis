import type { EntityModel } from "../Metadata/types";
import type { DatabaseProvider, ForeignKeyConstraint } from "../Providers/types";
import type { AdditiveSchemaOperation } from "./SchemaDiffer";
import { physicalTableIdentity } from "./tableKey";

/** Schema migration outcome. */
export interface MigrationResult {
  /** Number of applied operations. */
  readonly applied: number;
  /** Human-readable description of the applied operations. */
  readonly operations: readonly string[];
  /** Destructive differences left untouched. */
  readonly warnings: readonly string[];
}

/**
 * Applies additive schema change operations in one transaction.
 * FK constraints for `createTable` are computed by the given resolver
 * (column/table names already resolved).
 */
export class Migrator {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly foreignKeysFor: (model: EntityModel) => readonly ForeignKeyConstraint[],
  ) {}

  async apply(operations: readonly AdditiveSchemaOperation[]): Promise<string[]> {
    if (operations.length === 0) {
      return [];
    }
    const log: string[] = [];

    await this.provider.transaction(async (tx) => {
      for (const operation of operations) {
        const schema = physicalTableIdentity(operation.model).schema;
        if (operation.kind === "createTable" && schema !== undefined && this.provider.dialect.name === "postgres") {
          await tx.execute(
            `CREATE SCHEMA IF NOT EXISTS ${this.provider.dialect.quoteId(schema)}`,
            [],
          );
        }
        const sql = this.render(operation);
        await tx.execute(sql, []);
        log.push(this.describe(operation));
      }
    });
    return log;
  }

  private render(operation: AdditiveSchemaOperation): string {
    const dialect = this.provider.dialect;
    switch (operation.kind) {
      case "createTable":
        return dialect.createTableSql(operation.model, this.foreignKeysFor(operation.model));
      case "addColumn":
        return dialect.addColumnSql(operation.model, operation.property,
          this.foreignKeysFor(operation.model).find((fk) => (fk.columns ?? [fk.column]).includes(operation.property.columnName)));
      case "createIndex":
        return dialect.createIndexSqlOne(operation.model, operation.index);
    }
  }

  private describe(operation: AdditiveSchemaOperation): string {
    switch (operation.kind) {
      case "createTable":
        return `create table ${operation.model.tableName}`;
      case "addColumn":
        return `add column ${operation.model.tableName}.${operation.property.columnName}`;
      case "createIndex":
        return `create index ${operation.index.name}`;
    }
  }
}
