import { renderCheck } from "./CheckExpression";
import type { OrmExpectedSchema, ExpectedColumn, ExpectedTable } from "./ExpectedSchema";
import type { IntrospectedSchema } from "./introspection";
import type { SchemaDifference, SchemaVerificationResult } from "./ExactSchemaVerifier";

export type SafeAdditiveSchemaOperation =
  | { readonly kind: "createSchema"; readonly schema: string }
  | { readonly kind: "createTable"; readonly table: ExpectedTable }
  | { readonly kind: "addColumn"; readonly table: ExpectedTable; readonly column: ExpectedColumn }
  | { readonly kind: "addCheck"; readonly table: ExpectedTable; readonly check: ExpectedTable["checks"][number] }
  | { readonly kind: "addForeignKey"; readonly table: ExpectedTable; readonly foreignKey: ExpectedTable["foreignKeys"][number] }
  | { readonly kind: "createIndex"; readonly table: ExpectedTable; readonly index: ExpectedTable["indexes"][number] };

export interface SafeAdditivePreflight { readonly verification: SchemaVerificationResult; readonly hardDifferences: readonly SchemaDifference[]; readonly plan?: readonly SafeAdditiveSchemaOperation[] }

/** Classifies a complete catalog snapshot before any DDL is rendered or executed. */
export function classifySafeAdditive(expected: OrmExpectedSchema, actual: IntrospectedSchema, verification: SchemaVerificationResult): SafeAdditivePreflight {
  const hard = verification.differences.filter((difference) => !isPotentialAddition(difference));
  const plan: SafeAdditiveSchemaOperation[] = [];
  const existingSchemas = new Set(actual.schemas ?? ["public"]);
  for (const table of expected.tables) {
    const found = actual.tables.get(`${table.schema}.${table.table}`);
    if (!found) {
      if (table.schema !== "public" && !existingSchemas.has(table.schema)) { plan.push({ kind: "createSchema", schema: table.schema }); existingSchemas.add(table.schema); }
      plan.push({ kind: "createTable", table });
      for (const foreignKey of table.foreignKeys) plan.push({ kind: "addForeignKey", table, foreignKey });
      for (const index of table.indexes) plan.push({ kind: "createIndex", table, index });
      continue;
    }
    for (const column of table.columns) if (!found.columns.has(column.column)) {
      if (column.generation !== "none" || (!column.nullable && (column.default.kind === "none" || column.default.kind === "null"))) {
        hard.push(...verification.differences.filter((d) => d.schema === table.schema && d.table === table.table && d.code === "column.missing" && d.objectName === column.column));
      } else plan.push({ kind: "addColumn", table, column });
    }
    for (const check of table.checks) if (!(found.checks ?? []).some((item) => item.name === check.name)) plan.push({ kind: "addCheck", table, check });
    for (const foreignKey of table.foreignKeys) if (!(found.foreignKeys ?? []).some((item) => item.name === foreignKey.name)) plan.push({ kind: "addForeignKey", table, foreignKey });
    for (const index of table.indexes) if (!found.indexes.some((item) => !item.backingConstraint && item.name === index.name)) plan.push({ kind: "createIndex", table, index });
  }
  const uniqueHard = deduplicate(hard);
  if (uniqueHard.length) return { verification, hardDifferences: uniqueHard };
  return { verification, hardDifferences: [], plan: Object.freeze(plan.sort(compareOperation)) };
}

function isPotentialAddition(difference: SchemaDifference): boolean {
  return difference.code === "table.missing" || difference.code === "column.missing" || difference.code === "index.missing" || difference.code === "foreignKey.missing" || difference.code === "check.missing";
}
function deduplicate(differences: readonly SchemaDifference[]): readonly SchemaDifference[] {
  const seen = new Set<string>();
  return differences.filter((value) => { const key = `${value.schema}\0${value.table}\0${value.code}\0${value.objectName ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
const stage: Record<SafeAdditiveSchemaOperation["kind"], number> = { createSchema: 0, createTable: 1, addColumn: 2, addCheck: 3, addForeignKey: 4, createIndex: 5 };
function compareOperation(a: SafeAdditiveSchemaOperation, b: SafeAdditiveSchemaOperation): number {
  const stageDifference = stage[a.kind] - stage[b.kind];
  if (stageDifference) return stageDifference;
  return bytes(operationIdentity(a), operationIdentity(b));
}
function operationIdentity(operation: SafeAdditiveSchemaOperation): string {
  if (operation.kind === "createSchema") return operation.schema;
  const table = operation.table;
  const name = operation.kind === "createTable" ? table.table : operation.kind === "addColumn" ? operation.column.column : operation.kind === "addCheck" ? operation.check.name : operation.kind === "addForeignKey" ? operation.foreignKey.name : operation.index.name;
  return `${table.schema}\0${table.table}\0${name}`;
}
function bytes(a: string, b: string): number { return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }

/** Pure PostgreSQL renderer. Parameters/rows/raw fragments never enter the plan. */
export function renderSafeAdditivePostgres(operation: SafeAdditiveSchemaOperation): string {
  switch (operation.kind) {
    case "createSchema": return `CREATE SCHEMA ${q(operation.schema)}`;
    case "createTable": return createTable(operation.table);
    case "addColumn": return `ALTER TABLE ${tableName(operation.table)} ADD COLUMN ${column(operation.column)}`;
    case "addCheck": return `ALTER TABLE ${tableName(operation.table)} ADD CONSTRAINT ${q(operation.check.name)} CHECK (${renderCheck(operation.check.expression as never, q)})`;
    case "addForeignKey": return `ALTER TABLE ${tableName(operation.table)} ADD CONSTRAINT ${q(operation.foreignKey.name)} FOREIGN KEY (${operation.foreignKey.columns.map(q).join(", ")}) REFERENCES ${q(operation.foreignKey.target.schema)}.${q(operation.foreignKey.target.table)} (${operation.foreignKey.targetColumns.map(q).join(", ")}) ON DELETE ${action(operation.foreignKey.onDelete)} ON UPDATE ${action(operation.foreignKey.onUpdate)}`;
    case "createIndex": return `CREATE ${operation.index.unique ? "UNIQUE " : ""}INDEX ${q(operation.index.name)} ON ${tableName(operation.table)} (${operation.index.columns.map(q).join(", ")})`;
  }
}
function createTable(table: ExpectedTable): string {
  const parts = table.columns.map(column);
  parts.push(`CONSTRAINT ${q(table.primaryKey.name)} PRIMARY KEY (${table.primaryKey.columns.map(q).join(", ")})`);
  for (const check of table.checks) parts.push(`CONSTRAINT ${q(check.name)} CHECK (${renderCheck(check.expression as never, q)})`);
  return `CREATE TABLE ${tableName(table)} (${parts.join(", ")})`;
}
function column(value: ExpectedColumn): string {
  const pieces = [q(value.column), type(value.physicalType)];
  if (value.generation === "identityByDefault") pieces.push("GENERATED BY DEFAULT AS IDENTITY");
  if (value.default.kind !== "none") pieces.push(`DEFAULT ${literal(value.default, value.physicalType)}`);
  if (!value.nullable) pieces.push("NOT NULL");
  return pieces.join(" ");
}
function literal(value: ExpectedColumn["default"], physicalType: string): string {
  if (physicalType === "json") {
    const json = value.kind === "null" ? "null" : value.kind === "boolean" || value.kind === "number" ? String(value.value) : value.kind === "string" ? JSON.stringify(value.value) : undefined;
    if (json === undefined) throw new Error("Unrenderable PostgreSQL JSON schema default.");
    return `'${json.replaceAll("'", "''")}'::jsonb`;
  }
  switch (value.kind) { case "null": return "NULL"; case "boolean": return value.value ? "TRUE" : "FALSE"; case "number": return String(value.value); case "string": return `'${value.value.replaceAll("'", "''")}'`; case "uuidV4": return "gen_random_uuid()"; default: throw new Error("Unrenderable PostgreSQL schema default."); }
}
function type(value: string): string { return value === "integer" ? "bigint" : value === "real" ? "double precision" : value === "datetime" ? "timestamptz" : value === "json" ? "jsonb" : value; }
function q(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function tableName(table: Pick<ExpectedTable, "schema" | "table">): string { return `${q(table.schema)}.${q(table.table)}`; }
function action(value: string): string { return value === "noAction" ? "NO ACTION" : value === "setNull" ? "SET NULL" : value.toUpperCase(); }
