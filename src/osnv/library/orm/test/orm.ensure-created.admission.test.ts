import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, OrmModel, SchemaMigrationRequiredError, SchemaVerificationError, type DatabaseProvider, type DbExecutor, type IntrospectedSchema } from "../index";
import { SchemaAdmissionEngine } from "../Schema/SchemaAdmission";

@Entity({ table: "admission_recording" })
class AdmissionRecording { @Key() @Column({ type: "integer" }) id = 0; }

describe("ensure-created admission", () => {
  test("explains an unexpected column and rejects it before executing DDL", async () => {
    const table = compatibleTable().tables.get("public.admission_recording")!;
    const actual: IntrospectedSchema = { tables: new Map([["public.admission_recording", {
      ...table,
      columns: new Map(table.columns).set("manual_column", { name: "manual_column", physicalType: "text", notNull: false, isPrimaryKey: false }),
    }]]) };
    const log: string[] = [];
    const provider = recordingProvider({
      query: async () => [], introspectExpected: async () => actual,
      execute: async (sql) => { log.push(sql); return { changes: 0, lastInsertId: 0 }; },
    }, log);
    const error = await new SchemaAdmissionEngine(provider, new OrmModel([AdmissionRecording])).ensureCreated().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SchemaMigrationRequiredError);
    if (!(error instanceof SchemaMigrationRequiredError)) throw new Error("Expected a migration diagnostic");
    expect(error.code).toBe("ORM_SCHEMA_MIGRATION_REQUIRED");
    expect(error.message).toContain('Table "public"."admission_recording", object "manual_column"');
    expect(error.message).toContain("column exists in the database but is absent from the ORM model");
    expect(error.message).toContain("expected (ORM): absent; actual (database): present");
    expect(error.message).toContain("Check the application version and target database");
    expect(error.verification.differences).toMatchObject([{ code: "column.unexpected", objectName: "manual_column" }]);
    expect(log).toEqual(["scope"]);
  });
  test("reports each incompatible detail but keeps literal defaults out of diagnostics", async () => {
    const table = compatibleTable().tables.get("public.admission_recording")!;
    const actual: IntrospectedSchema = { tables: new Map([["public.admission_recording", {
      ...table,
      columns: new Map(table.columns).set("id", {
        ...table.columns.get("id")!, physicalType: "text", notNull: false,
        default: { kind: "string", value: "private-default-literal" },
      }),
    }]]) };
    const provider = recordingProvider({
      query: async () => [], introspectExpected: async () => actual,
      execute: async () => { throw new Error("Rejected schema must not execute DDL"); },
    }, []);
    const error = await new SchemaAdmissionEngine(provider, new OrmModel([AdmissionRecording])).ensureCreated().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SchemaMigrationRequiredError);
    if (!(error instanceof SchemaMigrationRequiredError)) throw new Error("Expected a migration diagnostic");
    expect(error.message).toContain('column type differs (column.type); expected (ORM): "integer"; actual (database): "text"');
    expect(error.message).toContain("expected (ORM): NOT NULL; actual (database): NULL allowed");
    expect(error.message).toContain("column default differs (column.default)");
    expect(error.message).toContain("canonicalDefault fingerprint");
    expect(error.message).toContain("sha256:");
    expect(JSON.stringify(error)).not.toContain("private-default-literal");
  });
  test("also explains a mismatch discovered by final verification", async () => {
    let reads = 0;
    const provider = recordingProvider({
      query: async () => [],
      introspectExpected: async () => ++reads === 1 ? compatibleTable() : { tables: new Map() },
      execute: async () => { throw new Error("An already compatible schema needs no DDL"); },
    }, []);
    const error = await new SchemaAdmissionEngine(provider, new OrmModel([AdmissionRecording])).ensureCreated().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SchemaVerificationError);
    if (!(error instanceof SchemaVerificationError)) throw new Error("Expected a verification diagnostic");
    expect(error.code).toBe("ORM_SCHEMA_DRIFT");
    expect(error.message).toContain('Table "public"."admission_recording"');
    expect(error.message).toContain("table is missing (table.missing); expected (ORM): present; actual (database): absent");
  });
  test("preflights before DDL and uses only the supplied admission scope", async () => {
    const log: string[] = [];
    let created = false;
    const scope: DbExecutor & { introspectExpected: () => Promise<IntrospectedSchema> } = {
      query: async () => [],
      execute: async (sql) => { log.push(sql); created = true; return { changes: 0, lastInsertId: 0 }; },
      introspectExpected: async () => created ? compatibleTable() : { tables: new Map() },
    };
    const provider = recordingProvider(scope, log);
    await new SchemaAdmissionEngine(provider, new OrmModel([AdmissionRecording])).ensureCreated();
    expect(log[0]).toBe("scope");
    expect(log.some((sql) => /IF NOT EXISTS/i.test(sql))).toBeFalse();
    expect(log.some((sql) => sql.startsWith("CREATE TABLE"))).toBeTrue();
  });
  test("maps every trusted PostgreSQL data SQLSTATE without exposing driver detail", async () => {
    for (const errno of ["23502", "23503", "23505", "23514"]) {
      const scope: DbExecutor & { introspectExpected: () => Promise<IntrospectedSchema> } = {
        query: async () => [], execute: async () => { throw { errno, message: "raw duplicate detail" }; }, introspectExpected: async () => ({ tables: new Map() }),
      };
      const error = await new SchemaAdmissionEngine(recordingProvider(scope, []), new OrmModel([AdmissionRecording])).ensureCreated().catch((cause) => cause as Error);
      expect(error).toMatchObject({ code: "ORM_SCHEMA_ADDITIVE_DATA_VIOLATION" });
      expect(String(error)).not.toContain("raw duplicate detail");
    }
  });
  test("uses the internal schema-admission trace boundary instead of raw rendered DDL", async () => {
    const trace: Array<{ readonly operation: string; readonly sql: string }> = [];
    let created = false;
    const scope: DbExecutor & { introspectExpected: () => Promise<IntrospectedSchema>; executeSchemaAdmission: (sql: string, operation: string) => Promise<{ changes: number; lastInsertId: number }> } = {
      query: async () => [],
      execute: async () => { throw new Error("ordinary executor must not receive admission DDL"); },
      executeSchemaAdmission: async (sql, operation) => { trace.push({ sql, operation }); created = true; return { changes: 0, lastInsertId: 0 }; },
      introspectExpected: async () => created ? compatibleTable() : { tables: new Map() },
    };
    await new SchemaAdmissionEngine(recordingProvider(scope, []), new OrmModel([AdmissionRecording])).ensureCreated();
    expect(trace.map(({ operation }) => `osnv.schema-admission:${operation}`)).toEqual(["osnv.schema-admission:createTable"]);
    expect(trace[0]!.sql).toContain("CREATE TABLE");
  });
  test("maps raw reserve/lock/transaction/catalog/finalization failures to one safe admission boundary", async () => {
    for (const stage of ["reserve", "lock", "begin", "catalog", "final", "commit", "unlock", "release"]) {
      const provider = recordingProvider({ query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), introspectExpected: async () => ({ tables: new Map() }) }, []);
      (provider.schemaAdmissionCapability as any).withSchemaAdmission = async () => { throw new Error(`postgres://secret/${stage} SELECT raw`); };
      const error = await new SchemaAdmissionEngine(provider, new OrmModel([AdmissionRecording])).ensureCreated().catch((cause) => cause as Error);
      expect(error).toMatchObject({ code: "ORM_SCHEMA_ATOMICITY_UNAVAILABLE" });
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("SELECT raw");
    }
  });
});

function recordingProvider(scope: DbExecutor & { introspectExpected: () => Promise<IntrospectedSchema>; executeSchemaAdmission?: (sql: string, operation: string) => Promise<{ changes: number; lastInsertId: number }> }, log: string[]): DatabaseProvider {
  return {
    name: "postgres",
    dialect: { name: "postgres" } as DatabaseProvider["dialect"],
    query: scope.query,
    execute: scope.execute,
    transaction: async (work) => work(scope),
    ping: async () => true,
    close: async () => undefined,
    introspect: async () => ({ tables: new Map() }),
    schemaAdmissionCapability: {
      version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true,
      withSchemaAdmission: async (_schemas, work) => { log.push("scope"); return work(scope); },
    },
  };
}

function compatibleTable(): IntrospectedSchema {
  return { tables: new Map([["public.admission_recording", {
    name: "admission_recording",
    columns: new Map([["id", { name: "id", notNull: true, isPrimaryKey: true, physicalType: "integer", default: { kind: "none" }, generation: "identityByDefault" }]]),
    indexes: [], primaryKey: { name: "pk_admission_recording", columns: ["id"] }, foreignKeys: [], checks: [],
  }]]) };
}
