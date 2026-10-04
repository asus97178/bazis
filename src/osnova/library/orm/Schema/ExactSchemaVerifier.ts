import type { OrmExpectedSchema } from "./ExpectedSchema";
import type { IntrospectedSchema, IntrospectedTable } from "./introspection";
import { createHash } from "node:crypto";
export type SchemaDifferenceCode = "table.missing" | "column.missing" | "column.unexpected" | "column.type" | "column.nullability" | "column.default" | "column.generation" | "primaryKey.missing" | "primaryKey.unexpected" | "primaryKey.name" | "primaryKey.columns" | "index.missing" | "index.unexpected" | "index.name" | "index.columns" | "index.uniqueness" | "index.method" | "index.unsupportedShape" | "foreignKey.missing" | "foreignKey.unexpected" | "foreignKey.name" | "foreignKey.columns" | "foreignKey.target" | "foreignKey.actions" | "foreignKey.deferrable" | "foreignKey.match" | "check.missing" | "check.unexpected" | "check.name" | "check.expression" | "catalog.unsupported";
export interface SafeSchemaDescriptor {
  readonly kind: "absent" | "present" | "canonicalType" | "canonicalDefault" | "canonicalGeneration" | "canonicalExpression" | "orderedColumns" | "referentialActions" | "unsupported";
  readonly value?: string;
  readonly values?: readonly string[];
  readonly hash?: `sha256:${string}`;
}
export interface SchemaDifference {
  readonly code: SchemaDifferenceCode;
  readonly schema: string;
  readonly table: string;
  readonly objectName?: string;
  readonly expected?: SafeSchemaDescriptor;
  readonly actual?: SafeSchemaDescriptor;
}
export interface SchemaVerificationResult {
  readonly compatible: boolean;
  readonly differences: readonly SchemaDifference[];
}
const absent: SafeSchemaDescriptor = { kind: "absent" };
const present: SafeSchemaDescriptor = { kind: "present" };
const unsupported: SafeSchemaDescriptor = { kind: "unsupported" };
const value = (kind: SafeSchemaDescriptor["kind"], raw: unknown): SafeSchemaDescriptor => {
  if (kind === "canonicalDefault" || kind === "canonicalExpression")
    return {
      kind, hash: `sha256:${createHash("sha256").update(`osnova.orm.schema-diagnostic/${kind}/v1\0${stable(raw)}`).digest("hex")}`
    };
  if (Array.isArray(raw))
    return { kind, values: raw.map(String) };
  return { kind, value: String(raw) };
};
/** Owner-scoped, deterministic comparison. Ordinary physical column order is deliberately ignored. */
export class ExactSchemaVerifier {
  verify(expected: OrmExpectedSchema, actual: IntrospectedSchema, allowMissing = false): SchemaVerificationResult {
    const differences: SchemaDifference[] = [];
    const add = (code: SchemaDifferenceCode, schema: string, table: string, objectName?: string, expectedValue?: SafeSchemaDescriptor, actualValue?: SafeSchemaDescriptor) => differences.push({ code, schema, table, objectName, expected: expectedValue, actual: actualValue });
    for (const table of expected.tables) {
      const name = `${table.schema}.${table.table}`;
      const found = actual.tables.get(name);
      if (!found) {
        if (!allowMissing)
          add("table.missing", table.schema, table.table, name, present, absent);
        continue;
      }
      this.table(table, found, table.table, (code, _table, objectName, expectedValue, actualValue) => add(code, table.schema, table.table, objectName, expectedValue, actualValue));
    }
    differences.sort((a, b) => Buffer.compare(Buffer.from(`${a.schema}\0${a.table}\0${a.code}\0${a.objectName ?? ""}`, "utf8"), Buffer.from(`${b.schema}\0${b.table}\0${b.code}\0${b.objectName ?? ""}`, "utf8")));
    return { compatible: differences.length === 0, differences };
  }
  private table(expected: OrmExpectedSchema["tables"][number], actual: IntrospectedTable, table: string, add: (code: SchemaDifferenceCode, table: string, objectName?: string, expected?: SafeSchemaDescriptor, actual?: SafeSchemaDescriptor) => void): void {
    if (actual.unsupported)
      add("catalog.unsupported", table, table, undefined, unsupported);
    const columns = new Map(expected.columns.map((column) => [column.column, column]));
    for (const name of actual.columns.keys())
      if (!columns.has(name))
        add("column.unexpected", table, name, absent, present);
    for (const [name, column] of columns) {
      const found = actual.columns.get(name);
      if (!found) {
        add("column.missing", table, name, present, absent);
        continue;
      }
      if (found.unsupported)
        add("catalog.unsupported", table, name, undefined, unsupported);
      if (found.physicalType !== column.physicalType)
        add("column.type", table, name, value("canonicalType", column.physicalType), value("canonicalType", found.physicalType ?? "unknown"));
      if (found.notNull === column.nullable)
        add("column.nullability", table, name, value("present", String(!column.nullable)), value("present", String(found.notNull)));
      if (stable(found.default) !== stable(column.default))
        add("column.default", table, name, value("canonicalDefault", column.default), value("canonicalDefault", found.default ?? { kind: "unknown" }));
      if (found.generation !== column.generation)
        add("column.generation", table, name, value("canonicalGeneration", column.generation), value("canonicalGeneration", found.generation ?? "unknown"));
    }
    if (!actual.primaryKey)
      add("primaryKey.missing", table, expected.primaryKey.name, present, absent);
    else {
      if (actual.primaryKey.name !== expected.primaryKey.name)
        add("primaryKey.name", table, expected.primaryKey.name, value("present", expected.primaryKey.name), value("present", actual.primaryKey.name));
      if (!same(actual.primaryKey.columns, expected.primaryKey.columns))
        add("primaryKey.columns", table, expected.primaryKey.name, value("orderedColumns", expected.primaryKey.columns), value("orderedColumns", actual.primaryKey.columns));
    }
    const ordinary = actual.indexes.filter((index) => !index.backingConstraint);
    const expectedIndexes = new Map(expected.indexes.map((index) => [index.name, index]));
    for (const index of ordinary) {
      if (index.unsupported || index.method !== "btree" || index.predicate || index.columns.length === 0)
        add("index.unsupportedShape", table, index.name, undefined, unsupported);
      else if (!expectedIndexes.has(index.name))
        add("index.unexpected", table, index.name, absent, present);
    }
    for (const [name, index] of expectedIndexes) {
      const found = ordinary.find((item) => item.name === name) ?? (ordinary.length === 1 ? ordinary[0] : undefined);
      if (!found) {
        add("index.missing", table, name, present, absent);
        continue;
      }
      if (found.name !== name)
        add("index.name", table, name, value("present", name), value("present", found.name));
      if (found.unsupported || found.predicate || found.columns.length === 0) {
        add("catalog.unsupported", table, name, undefined, unsupported);
        continue;
      }
      if (found.unique !== index.unique)
        add("index.uniqueness", table, name, value("present", String(index.unique)), value("present", String(found.unique)));
      if (!same(found.columns, index.columns))
        add("index.columns", table, name, value("orderedColumns", index.columns), value("orderedColumns", found.columns));
      if (found.method !== "btree")
        add("index.method", table, name, value("present", "btree"), value("present", found.method ?? "unknown"));
    }
    const foreignKeys = actual.foreignKeys ?? [];
    const expectedForeignKeys = new Map(expected.foreignKeys.map((foreignKey) => [foreignKey.name, foreignKey]));
    for (const foreignKey of foreignKeys)
      if (foreignKey.unsupported)
        add("catalog.unsupported", table, foreignKey.name, undefined, unsupported);
      else if (foreignKey.deferrable)
        add("foreignKey.deferrable", table, foreignKey.name, absent, present);
      else if (!expectedForeignKeys.has(foreignKey.name))
        add("foreignKey.unexpected", table, foreignKey.name, absent, present);
    for (const [name, foreignKey] of expectedForeignKeys) {
      const found = foreignKeys.find((item) => item.name === name) ?? (foreignKeys.length === 1 ? foreignKeys[0] : undefined);
      if (!found) {
        add("foreignKey.missing", table, name, present, absent);
        continue;
      }
      const targetSchema = found.targetSchema ?? "public";
      if (found.name !== name)
        add("foreignKey.name", table, name, value("present", name), value("present", found.name));
      if (!same(found.columns, foreignKey.columns))
        add("foreignKey.columns", table, name, value("orderedColumns", foreignKey.columns), value("orderedColumns", found.columns));
      if (found.targetTable !== foreignKey.target.table || targetSchema !== foreignKey.target.schema || !same(found.targetColumns, foreignKey.targetColumns))
        add("foreignKey.target", table, name, value("orderedColumns", [foreignKey.target.schema, foreignKey.target.table, ...foreignKey.targetColumns]), value("orderedColumns", [targetSchema, found.targetTable, ...found.targetColumns]));
      if (found.onDelete !== foreignKey.onDelete || found.onUpdate !== foreignKey.onUpdate)
        add("foreignKey.actions", table, name, value("referentialActions", [foreignKey.onDelete, foreignKey.onUpdate]), value("referentialActions", [found.onDelete, found.onUpdate]));
    }
    const checks = actual.checks ?? [];
    const expectedChecks = new Map(expected.checks.map((check) => [check.name, check]));
    for (const check of checks)
      if (check.unsupported)
        add("catalog.unsupported", table, check.name, undefined, unsupported);
      else if (!expectedChecks.has(check.name))
        add("check.unexpected", table, check.name, absent, present);
    for (const [name, check] of expectedChecks) {
      const found = checks.find((item) => item.name === name) ?? (checks.length === 1 ? checks[0] : undefined);
      if (!found)
        add("check.missing", table, name, present, absent);
      else {
        if (found.name !== name)
          add("check.name", table, name, value("present", name), value("present", found.name));
        if (stable(found.expression) !== stable(check.expression))
          add("check.expression", table, name, value("canonicalExpression", check.expression), value("canonicalExpression", found.expression));
      }
    }
  }
}
function same<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((entry, index) => stable(entry) === stable(b[index]));
}
function stable(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
