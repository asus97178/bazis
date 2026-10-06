import { OrmError } from "../errors";
import { renderPostgresOnConflictDoNothing, renderPostgresSkipLocked } from "../Providers/PostgresDialect";
import type { EntityModel, PropertyModel } from "../Metadata/types";
import type { SqlDialect, SqlParam } from "../Providers/types";
import { encodeProperty } from "../Providers/propertyConversion";
import type { Condition } from "./conditions";
import type { QueryPlan } from "./QueryPlan";

export interface CompiledSql {
  readonly sql: string;
  readonly params: SqlParam[];
}
type ConditionValueEncoder = (property: PropertyModel, value: unknown) => SqlParam;

/** Cache of the quoted column list per (model, dialect), built once. */
const columnListCache = new WeakMap<EntityModel, Map<string, string>>();

/** Quoted `"a", "b", ...` list of all entity columns (memoized). */
export function quotedColumnList(model: EntityModel, dialect: SqlDialect): string {
  let byDialect = columnListCache.get(model);
  if (!byDialect) {
    byDialect = new Map();
    columnListCache.set(model, byDialect);
  }
  let list = byDialect.get(dialect.name);
  if (list === undefined) {
    list = model.properties.map((property) => dialect.quoteId(property.columnName)).join(", ");
    byDialect.set(dialect.name, list);
  }
  return list;
}

/**
 * Translates a query plan into parameterized SQL. Values go only into the
 * parameter array (no concatenation of user data).
 */
export class SqlTranslator {
  constructor(
    private readonly model: EntityModel,
    private readonly dialect: SqlDialect,
  ) {}

  /** SELECT of all columns (or a projection) with WHERE/ORDER/LIMIT/OFFSET. */
  selectAll(plan: QueryPlan): CompiledSql {
    const params: SqlParam[] = [];
    const columns =
      plan.projections.length > 0
        ? plan.projections
            .map(({ alias, property }) => {
              const prop = this.requireProperty(property);
              return `${this.dialect.quoteId(prop.columnName)} AS ${this.dialect.quoteId(alias)}`;
            })
            .join(", ")
        : quotedColumnList(this.model, this.dialect);
    let sql = `SELECT ${columns} FROM ${this.dialect.qualifyTable(this.model)}`;
    sql += this.whereClause(plan, params);
    sql += this.orderClause(plan);
    sql += this.limitClause(plan, params);
    if (plan.rowLock) {
      sql += this.dialect.rowLockClause(plan.rowLock);
      if (plan.skipLocked) sql += renderPostgresSkipLocked(this.dialect);
    }
    return { sql, params };
  }

  /** SELECT COUNT(*) with the same filters (without order/limit). */
  selectCount(plan: QueryPlan): CompiledSql {
    const params: SqlParam[] = [];
    let sql = `SELECT COUNT(*) AS count FROM ${this.dialect.qualifyTable(this.model)}`;
    sql += this.whereClause(plan, params);
    return { sql, params };
  }

  /** Private immediate-DML renderers; the public query DSL remains unchanged. */
  immediateUpdate(values: readonly { readonly property: PropertyModel; readonly value: SqlParam }[], conditions: readonly Condition[], encode: ConditionValueEncoder): CompiledSql {
    const params: SqlParam[] = values.map((value) => value.value);
    const assignments = values.map((value, index) => `${this.dialect.quoteId(value.property.columnName)} = ${this.dialect.parameter(index)}`).join(", ");
    return { sql: `UPDATE ${this.dialect.qualifyTable(this.model)} SET ${assignments}${this.immediateWhere(conditions, params, encode)}`, params };
  }

  immediateDelete(conditions: readonly Condition[], encode: ConditionValueEncoder): CompiledSql {
    const params: SqlParam[] = [];
    return { sql: `DELETE FROM ${this.dialect.qualifyTable(this.model)}${this.immediateWhere(conditions, params, encode)}`, params };
  }

  private immediateWhere(conditions: readonly Condition[], params: SqlParam[], encode: ConditionValueEncoder): string {
    if (conditions.length === 0) return "";
    return ` WHERE ${conditions.map((condition) => this.condition(condition, params, encode)).join(" AND ")}`;
  }

  immediateInsert(values: readonly { readonly property: PropertyModel; readonly value: SqlParam }[], conflictColumns: readonly string[]): CompiledSql {
    const params = values.map((value) => value.value);
    const columns = values.map((value) => this.dialect.quoteId(value.property.columnName)).join(", ");
    const placeholders = values.map((_value, index) => this.dialect.parameter(index)).join(", ");
    return { sql: `INSERT INTO ${this.dialect.qualifyTable(this.model)} (${columns}) VALUES (${placeholders})${renderPostgresOnConflictDoNothing(this.dialect, conflictColumns)}`, params };
  }

  private whereClause(plan: QueryPlan, params: SqlParam[], encode: ConditionValueEncoder = (property, value) => encodeProperty(property, value, this.dialect)): string {
    const parts: string[] = [];
    if (!plan.ignoreQueryFilters) {
      for (const filter of this.model.queryFilters) {
        parts.push(this.condition(filter, params, encode));
      }
      if (this.model.softDeleteProperty) {
        parts.push(this.condition({ kind: "null", property: this.model.softDeleteProperty, negated: false }, params, encode));
      }
    }
    for (const condition of plan.conditions) {
      parts.push(this.condition(condition, params, encode));
    }
    if (parts.length === 0) {
      return "";
    }
    return ` WHERE ${parts.join(" AND ")}`;
  }

  private orderClause(plan: QueryPlan): string {
    if (plan.orders.length === 0) {
      return "";
    }
    const parts = plan.orders.map((order) => {
      const column = this.requireProperty(order.property).columnName;
      return `${this.dialect.quoteId(column)}${order.descending ? " DESC" : " ASC"}`;
    });
    return ` ORDER BY ${parts.join(", ")}`;
  }

  private limitClause(plan: QueryPlan, params: SqlParam[]): string {
    let sql = "";
    if (plan.limit !== undefined) {
      sql += ` LIMIT ${this.dialect.parameter(params.length)}`;
      params.push(plan.limit);
    }
    if (plan.offset !== undefined) {
      sql += ` OFFSET ${this.dialect.parameter(params.length)}`;
      params.push(plan.offset);
    }
    return sql;
  }

  private condition(condition: Condition, params: SqlParam[], encode: ConditionValueEncoder): string {
    switch (condition.kind) {
      case "compare": {
        const property = this.requireProperty(condition.property);
        const placeholder = this.dialect.parameter(params.length);
        params.push(encode(property, condition.value));
        // startsWith/endsWith/contains escape wildcards with `\`; this works
        // only with an explicit `ESCAPE '\'` (otherwise `%`/`_` stay wildcards).
        const escape = condition.escaped ? " ESCAPE '\\'" : "";
        return `${this.dialect.quoteId(property.columnName)} ${condition.op} ${placeholder}${escape}`;
      }
      case "in": {
        const property = this.requireProperty(condition.property);
        if (condition.values.length === 0) {
          return "0 = 1"; // an empty IN is always false
        }
        const placeholders = condition.values.map((value) => {
          const placeholder = this.dialect.parameter(params.length);
          params.push(encode(property, value));
          return placeholder;
        });
        return `${this.dialect.quoteId(property.columnName)} IN (${placeholders.join(", ")})`;
      }
      case "tuples": {
        if (condition.properties.length === 0 || condition.values.length === 0) return "0 = 1";
        return `(${condition.values.map((tuple) => {
          if (tuple.length !== condition.properties.length) throw new OrmError("Tuple predicate component count mismatch.");
          return `(${tuple.map((value, index) => { const property = this.requireProperty(condition.properties[index]!); const placeholder = this.dialect.parameter(params.length); params.push(encode(property, value)); return `${this.dialect.quoteId(property.columnName)} = ${placeholder}`; }).join(" AND ")})`;
        }).join(" OR ")})`;
      }
      case "null": {
        const property = this.requireProperty(condition.property);
        return `${this.dialect.quoteId(property.columnName)} IS ${condition.negated ? "NOT " : ""}NULL`;
      }
      case "and":
      case "or": {
        const left = this.condition(condition.left, params, encode);
        const right = this.condition(condition.right, params, encode);
        return `(${left} ${condition.kind === "and" ? "AND" : "OR"} ${right})`;
      }
      case "not":
        return `NOT (${this.condition(condition.inner, params, encode)})`;
    }
  }

  private requireProperty(propertyName: string): PropertyModel {
    const property = this.model.propertyByName(propertyName);
    if (!property) {
      throw new OrmError(
        `Property "${propertyName}" is not mapped on entity "${this.model.name}". Did you forget @Column()?`,
      );
    }
    return property;
  }
}
