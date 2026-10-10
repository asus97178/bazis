import type { DatabaseProvider, SchemaAdmissionScope } from "../Providers/types";
import { SchemaAdmissionError, SchemaMigrationRequiredError, SchemaVerificationError } from "../errors";
import type { OrmModel } from "../Metadata/OrmModel";
import { compileExpectedSchema, type OrmExpectedSchema } from "./ExpectedSchema";
import { ExactSchemaVerifier, type SchemaVerificationResult } from "./ExactSchemaVerifier";
import { classifySafeAdditive, renderSafeAdditivePostgres, type SafeAdditiveSchemaOperation } from "./SafeAdditiveSchema";
import type { IntrospectedSchema } from "./introspection";

/** PostgreSQL-private trace boundary; deliberately absent from public capability types. */
type TraceableSchemaAdmissionScope = SchemaAdmissionScope & {
  readonly executeSchemaAdmission?: (sql: string, operation: string) => ReturnType<SchemaAdmissionScope["execute"]>;
};

/** Result of `ensureCreated`: tolerated differences the application should know about. */
export interface EnsureCreatedResult {
  readonly warnings: readonly string[];
  /** Additive changes made by this call, for example `add column products.sku`. */
  readonly applied?: readonly string[];
}

/** PostgreSQL-only create-missing-whole-tables and exact admission. */
export class SchemaAdmissionEngine {
  constructor(private readonly provider: DatabaseProvider, private readonly models: OrmModel) {}
  async ensureCreated(): Promise<EnsureCreatedResult> {
    let expected: OrmExpectedSchema;
    try {
      expected = compileExpectedSchema(this.models);
    } catch (error) {
      if (error instanceof SchemaAdmissionError) throw error;
      throw new SchemaAdmissionError("ORM_SCHEMA_MODEL_INVALID", "The declared ORM model cannot be admitted.");
    }
    const capability = this.provider.schemaAdmissionCapability;
    if (!capability || this.provider.name !== "postgres" || capability.provider !== "postgres") throw new SchemaAdmissionError("ORM_SCHEMA_PROVIDER_UNSUPPORTED", "PostgreSQL schema admission capability is unavailable.");
    if (capability.version !== 1 || !capability.distributedLock || !capability.transactionalDdl || !capability.exactIntrospection) {
      throw new SchemaAdmissionError("ORM_SCHEMA_ATOMICITY_UNAVAILABLE", "PostgreSQL schema admission cannot guarantee atomic exact verification.");
    }
    let result: EnsureCreatedResult = { warnings: [], applied: [] };
    try {
      await capability.withSchemaAdmission([...new Set(expected.tables.map((table) => table.schema))], async (scope) => { result = await this.admit(scope, expected); });
    } catch (error) {
      if (error instanceof SchemaAdmissionError) throw error;
      throw new SchemaAdmissionError("ORM_SCHEMA_ATOMICITY_UNAVAILABLE", "PostgreSQL schema admission could not complete safely.");
    }
    return result;
  }
  private async admit(scope: SchemaAdmissionScope, expected: OrmExpectedSchema): Promise<EnsureCreatedResult> {
    const { schema: before, warnings: indexWarnings } = alignIndexNames(expected, await scope.introspectExpected(expected));
    const { verification: initial, warnings: keyWarnings } = tolerateNameDrift(new ExactSchemaVerifier().verify(expected, before, true));
    const preflight = classifySafeAdditive(expected, before, initial);
    if (preflight.hardDifferences.length) {
      if (preflight.hardDifferences.some((difference) => difference.code === "catalog.unsupported")) throw new SchemaAdmissionError("ORM_SCHEMA_CATALOG_UNSUPPORTED", "PostgreSQL catalog contains a schema form unsupported by exact admission.");
      throw new SchemaMigrationRequiredError(preflight.verification);
    }
    const applied: string[] = [];
    for (const operation of preflight.plan ?? []) {
      try {
        const sql = renderSafeAdditivePostgres(operation);
        const traceable = scope as TraceableSchemaAdmissionScope;
        if (traceable.executeSchemaAdmission) await traceable.executeSchemaAdmission(sql, operation.kind);
        else await scope.execute(sql, []);
      }
      catch (error) { throw this.mapDdlError(operation, error); }
      applied.push(describeOperation(operation));
    }
    const { verification: final } = tolerateNameDrift(new ExactSchemaVerifier().verify(expected, alignIndexNames(expected, await scope.introspectExpected(expected)).schema));
    if (!final.compatible) throw new SchemaVerificationError(final);
    return { warnings: [...keyWarnings, ...indexWarnings], applied };
  }
  private mapDdlError(operation: SafeAdditiveSchemaOperation, error: unknown): SchemaAdmissionError {
    const sqlState = typeof error === "object" && error !== null
      ? String((error as { code?: unknown; sqlState?: unknown; errno?: unknown }).sqlState ?? (error as { errno?: unknown }).errno ?? (error as { code?: unknown }).code ?? "")
      : "";
    // The PostgreSQL message names objects, not row values (those stay in its detail field).
    const reason = `${describeOperation(operation)} failed${sqlState ? ` with PostgreSQL ${sqlState}` : ""}${error instanceof Error && error.message ? `: ${error.message}` : ""}`;
    if (["23502", "23503", "23505", "23514"].includes(sqlState)) return new SchemaAdmissionError("ORM_SCHEMA_ADDITIVE_DATA_VIOLATION", `Existing PostgreSQL data violates the declared additive schema change: ${reason}. Fix the data, then start again.`);
    return new SchemaAdmissionError(operation.kind === "createSchema" || operation.kind === "createTable" ? "ORM_SCHEMA_CREATE_FAILED" : "ORM_SCHEMA_ADDITIVE_DDL_FAILED", `PostgreSQL additive schema admission failed: ${reason}.`);
  }
}

/**
 * A primary key that differs only by name (`tasks_pkey` from an older schema vs
 * the model's `pk_tasks`) enforces the same thing, and queries never reference
 * the name (`ON CONFLICT` names columns). It is reported, not refused; the same
 * table passes `migrateOnStart`. Every other difference stays exact.
 */
function tolerateNameDrift(verification: SchemaVerificationResult): { readonly verification: SchemaVerificationResult; readonly warnings: readonly string[] } {
  const tolerated = verification.differences.filter((difference) => difference.code === "primaryKey.name");
  if (tolerated.length === 0) return { verification, warnings: [] };
  const differences = verification.differences.filter((difference) => difference.code !== "primaryKey.name");
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const warnings = tolerated.map((difference) => {
    const table = `${quote(difference.schema)}.${quote(difference.table)}`;
    const actual = difference.actual?.value ?? "";
    const expected = difference.expected?.value ?? difference.objectName ?? "";
    return `table ${table}: primary key is named ${quote(actual)}, the model expects ${quote(expected)}. `
      + `It works as is; to align the name run: ALTER TABLE ${table} RENAME CONSTRAINT ${quote(actual)} TO ${quote(expected)};`;
  });
  return { verification: { compatible: differences.length === 0, differences }, warnings };
}

const tableName = (schema: string, table: string) => schema === "public" ? table : `${schema}.${table}`;

/** Short log form of an additive operation, in the style of `migrateOnStart`. */
function describeOperation(operation: SafeAdditiveSchemaOperation): string {
  switch (operation.kind) {
    case "createSchema": return `create schema ${operation.schema}`;
    case "createTable": return `create table ${tableName(operation.table.schema, operation.table.table)}`;
    case "addColumn": return `add column ${tableName(operation.table.schema, operation.table.table)}.${operation.column.column}`;
    case "addCheck": return `add check ${operation.check.name} on ${tableName(operation.table.schema, operation.table.table)}`;
    case "addForeignKey": return `add foreign key ${operation.foreignKey.name} on ${tableName(operation.table.schema, operation.table.table)}`;
    case "createIndex": return `create ${operation.index.unique ? "unique " : ""}index ${operation.index.name} on ${tableName(operation.table.schema, operation.table.table)} (${operation.index.columns.join(", ")})`;
  }
}

/**
 * An index that differs only by name (same columns, uniqueness and method)
 * enforces the same thing; before 0.98.20 property-level `@Index` names ignored
 * `@Entity({ table })`. Like a renamed primary key it is reported, not refused,
 * and never duplicated.
 */
function alignIndexNames(expected: OrmExpectedSchema, actual: IntrospectedSchema): { readonly schema: IntrospectedSchema; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const tables = new Map(actual.tables);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const table of expected.tables) {
    const key = `${table.schema}.${table.table}`;
    const found = actual.tables.get(key);
    if (!found) continue;
    const expectedNames = new Set(table.indexes.map((index) => index.name));
    let indexes = found.indexes;
    for (const index of table.indexes) {
      if (indexes.some((item) => item.name === index.name)) continue;
      const match = indexes.find((item) => !item.backingConstraint && !item.unsupported && !item.predicate && item.method === "btree" && !expectedNames.has(item.name)
        && item.unique === index.unique && item.columns.length === index.columns.length && item.columns.every((column, position) => column === index.columns[position]));
      if (!match) continue;
      warnings.push(`table ${quote(table.schema)}.${quote(table.table)}: index is named ${quote(match.name)}, the model expects ${quote(index.name)}. `
        + `It works as is; to align the name run: ALTER INDEX ${quote(table.schema)}.${quote(match.name)} RENAME TO ${quote(index.name)};`);
      indexes = indexes.map((item) => item === match ? { ...item, name: index.name } : item);
    }
    if (indexes !== found.indexes) tables.set(key, { ...found, indexes });
  }
  return { schema: { ...actual, tables }, warnings };
}
