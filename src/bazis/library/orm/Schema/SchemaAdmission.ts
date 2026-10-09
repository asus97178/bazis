import type { DatabaseProvider, SchemaAdmissionScope } from "../Providers/types";
import { SchemaAdmissionError, SchemaMigrationRequiredError, SchemaVerificationError } from "../errors";
import type { OrmModel } from "../Metadata/OrmModel";
import { compileExpectedSchema, type OrmExpectedSchema } from "./ExpectedSchema";
import { ExactSchemaVerifier, type SchemaVerificationResult } from "./ExactSchemaVerifier";
import { classifySafeAdditive, renderSafeAdditivePostgres } from "./SafeAdditiveSchema";

/** PostgreSQL-private trace boundary; deliberately absent from public capability types. */
type TraceableSchemaAdmissionScope = SchemaAdmissionScope & {
  readonly executeSchemaAdmission?: (sql: string, operation: string) => ReturnType<SchemaAdmissionScope["execute"]>;
};

/** Result of `ensureCreated`: tolerated differences the application should know about. */
export interface EnsureCreatedResult {
  readonly warnings: readonly string[];
}

/** PostgreSQL-only create-missing-whole-tables and exact admission. */
export class SchemaAdmissionEngine {
  constructor(private readonly provider: DatabaseProvider, private readonly models: OrmModel) {}
  async ensureCreated(): Promise<EnsureCreatedResult> {
    let expected: OrmExpectedSchema;
    try {
      expected = compileExpectedSchema(this.models);
    } catch {
      throw new SchemaAdmissionError("ORM_SCHEMA_MODEL_INVALID", "The declared ORM model cannot be admitted.");
    }
    const capability = this.provider.schemaAdmissionCapability;
    if (!capability || this.provider.name !== "postgres" || capability.provider !== "postgres") throw new SchemaAdmissionError("ORM_SCHEMA_PROVIDER_UNSUPPORTED", "PostgreSQL schema admission capability is unavailable.");
    if (capability.version !== 1 || !capability.distributedLock || !capability.transactionalDdl || !capability.exactIntrospection) {
      throw new SchemaAdmissionError("ORM_SCHEMA_ATOMICITY_UNAVAILABLE", "PostgreSQL schema admission cannot guarantee atomic exact verification.");
    }
    let warnings: readonly string[] = [];
    try {
      await capability.withSchemaAdmission([...new Set(expected.tables.map((table) => table.schema))], async (scope) => { warnings = await this.admit(scope, expected); });
    } catch (error) {
      if (error instanceof SchemaAdmissionError) throw error;
      throw new SchemaAdmissionError("ORM_SCHEMA_ATOMICITY_UNAVAILABLE", "PostgreSQL schema admission could not complete safely.");
    }
    return { warnings };
  }
  private async admit(scope: SchemaAdmissionScope, expected: OrmExpectedSchema): Promise<readonly string[]> {
    const before = await scope.introspectExpected(expected);
    const { verification: initial, warnings } = tolerateNameDrift(new ExactSchemaVerifier().verify(expected, before, true));
    const preflight = classifySafeAdditive(expected, before, initial);
    if (preflight.hardDifferences.length) {
      if (preflight.hardDifferences.some((difference) => difference.code === "catalog.unsupported")) throw new SchemaAdmissionError("ORM_SCHEMA_CATALOG_UNSUPPORTED", "PostgreSQL catalog contains a schema form unsupported by exact admission.");
      throw new SchemaMigrationRequiredError(preflight.verification);
    }
    for (const operation of preflight.plan ?? []) {
      try {
        const sql = renderSafeAdditivePostgres(operation);
        const traceable = scope as TraceableSchemaAdmissionScope;
        if (traceable.executeSchemaAdmission) await traceable.executeSchemaAdmission(sql, operation.kind);
        else await scope.execute(sql, []);
      }
      catch (error) { throw this.mapDdlError(operation.kind, error); }
    }
    const { verification: final } = tolerateNameDrift(new ExactSchemaVerifier().verify(expected, await scope.introspectExpected(expected)));
    if (!final.compatible) throw new SchemaVerificationError(final);
    return warnings;
  }
  private mapDdlError(kind: string, error: unknown): SchemaAdmissionError {
    const sqlState = typeof error === "object" && error !== null
      ? String((error as { code?: unknown; sqlState?: unknown; errno?: unknown }).sqlState ?? (error as { errno?: unknown }).errno ?? (error as { code?: unknown }).code ?? "")
      : "";
    if (["23502", "23503", "23505", "23514"].includes(sqlState)) return new SchemaAdmissionError("ORM_SCHEMA_ADDITIVE_DATA_VIOLATION", "Existing PostgreSQL data violates the declared additive schema change.");
    return new SchemaAdmissionError(kind === "createSchema" || kind === "createTable" ? "ORM_SCHEMA_CREATE_FAILED" : "ORM_SCHEMA_ADDITIVE_DDL_FAILED", "PostgreSQL additive schema admission failed.");
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
