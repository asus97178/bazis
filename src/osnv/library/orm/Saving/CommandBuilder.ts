import type { EntityModel, PropertyModel } from "../Metadata/types";
import type { SqlDialect, SqlParam } from "../Providers/types";
import { encodeProperty } from "../Providers/propertyConversion";
import { EntityState } from "../Tracking/EntityState";
import type { TrackedEntry } from "../Tracking/ChangeTracker";

export interface DbCommand {
  readonly sql: string;
  readonly params: SqlParam[];
  /**
   * Column of the generated key to read from the result row (identity INSERT
   * through `RETURNING`), or `undefined`. The calling code takes the key
   * property from the model.
   */
  readonly returnsGeneratedKey?: { readonly column: string; readonly property: string; readonly type: PropertyModel["type"] };
}

/**
 * Builds parameterized SQL commands for tracked entities.
 * All values go only into the parameter array.
 */
export class CommandBuilder {
  constructor(private readonly dialect: SqlDialect) {}

  build(entry: TrackedEntry): DbCommand {
    switch (entry.state) {
      case EntityState.Added:
        return this.insert(entry.entity as Record<string, unknown>, entry.model);
      case EntityState.Modified:
        return this.update(entry.entity as Record<string, unknown>, entry.model, entry.modifiedProperties);
      case EntityState.Deleted:
        if (entry.model.softDeleteProperty) {
          return this.softDelete(entry.entity as Record<string, unknown>, entry.model);
        }
        return this.delete(entry.entity as Record<string, unknown>, entry.model);
      default:
        throw new Error(`No command for entity state "${entry.state}".`);
    }
  }

  private insert(entity: Record<string, unknown>, model: EntityModel): DbCommand {
    return this.insertMany([entity], model);
  }

  /**
   * Batch insert into one table: `INSERT ... VALUES (..),(..),...`. For identity
   * keys it adds `RETURNING`; keys are read in row order. The columns are the
   * same for all Added entries of one entity, so the batch is safe.
   */
  insertMany(entities: readonly Record<string, unknown>[], model: EntityModel): DbCommand {
    const scalarKey = model.key.length === 1 ? model.key[0] : undefined;
    const dbGeneratedKey = scalarKey?.generation === "identity" || scalarKey?.generation === "uuid";
    const columns = model.properties.filter((property) => !isDatabaseGenerated(property.generation));
    const columnList = columns.map((property) => this.dialect.quoteId(property.columnName)).join(", ");
    const params: SqlParam[] = [];
    const tuples = entities.map((entity) => {
      const placeholders = columns.map((property) => {
        const placeholder = this.dialect.parameter(params.length);
        params.push(encodeProperty(property, entity[property.propertyName], this.dialect));
        return placeholder;
      });
      return `(${placeholders.join(", ")})`;
    });
    const returning =
      dbGeneratedKey && this.dialect.supportsReturning
        ? ` RETURNING ${this.dialect.quoteId(scalarKey!.columnName)}`
        : "";

    if (columns.length === 0) {
      if (entities.length !== 1) {
        throw new Error(
          `Batch insert into "${model.tableName}" with only a DB-generated key supports one row at a time.`,
        );
      }
      const sql = `INSERT INTO ${this.dialect.qualifyTable(model)} DEFAULT VALUES${returning}`;
      return {
        sql,
        params: [],
        returnsGeneratedKey: dbGeneratedKey
          ? { column: scalarKey!.columnName, property: scalarKey!.propertyName, type: scalarKey!.type }
          : undefined,
      };
    }

    const sql = `INSERT INTO ${this.dialect.qualifyTable(model)} (${columnList}) VALUES ${tuples.join(", ")}${returning}`;
    return {
      sql,
      params,
      returnsGeneratedKey: dbGeneratedKey
        ? { column: scalarKey!.columnName, property: scalarKey!.propertyName, type: scalarKey!.type }
        : undefined,
    };
  }

  private update(entity: Record<string, unknown>, model: EntityModel, changed: ReadonlySet<string>): DbCommand {
    const columns = model.properties.filter(
      (property) => !property.isKey && (changed.size === 0 || changed.has(property.propertyName)),
    );
    const params: SqlParam[] = [];
    const assignments = columns.map((property) => {
      const placeholder = this.dialect.parameter(params.length);
      params.push(encodeProperty(property, entity[property.propertyName], this.dialect));
      return `${this.dialect.quoteId(property.columnName)} = ${placeholder}`;
    });
    const where = this.keyPredicate(model, entity, params);
    const sql = `UPDATE ${this.dialect.qualifyTable(model)} SET ${assignments.join(
      ", ",
    )} WHERE ${where}`;
    return { sql, params };
  }

  private delete(entity: Record<string, unknown>, model: EntityModel): DbCommand {
    const params: SqlParam[] = [];
    const sql = `DELETE FROM ${this.dialect.qualifyTable(model)} WHERE ${this.keyPredicate(model, entity, params)}`;
    return { sql, params };
  }

  /** Soft delete: an UPDATE of the timestamp instead of DELETE. */
  private softDelete(entity: Record<string, unknown>, model: EntityModel): DbCommand {
    const propName = model.softDeleteProperty!;
    const property = model.propertyByName(propName)!;
    const deletedAt = new Date();
    entity[propName] = deletedAt;
    const placeholder = this.dialect.parameter(0);
    const params: SqlParam[] = [encodeProperty(property, deletedAt, this.dialect)];
    const sql = `UPDATE ${this.dialect.qualifyTable(model)} SET ${this.dialect.quoteId(
      property.columnName,
    )} = ${placeholder} WHERE ${this.keyPredicate(model, entity, params)}`;
    return { sql, params };
  }

  private keyPredicate(model: EntityModel, entity: Record<string, unknown>, params: SqlParam[]): string {
    return model.key.map((key) => {
      const placeholder = this.dialect.parameter(params.length);
      params.push(encodeProperty(key, entity[key.propertyName], this.dialect));
      return `${this.dialect.quoteId(key.columnName)} = ${placeholder}`;
    }).join(" AND ");
  }
}

function isDatabaseGenerated(generation: "identity" | "uuid" | "none"): boolean {
  return generation === "identity" || generation === "uuid";
}
