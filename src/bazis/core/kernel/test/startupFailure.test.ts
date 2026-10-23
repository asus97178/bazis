import { expect, test } from "bun:test";
import { formatStartupFailure } from "../startupFailure";
import { StartupFailuresError } from "../errors";

class SchemaError extends Error {
  readonly code = "ORM_SCHEMA_MIGRATION_REQUIRED";
  readonly verification = { differences: [{ table: "products", nested: { deep: true } }] };
  constructor(message: string) { super(message); this.name = "SchemaError"; }
}

test("a startup failure prints name, message, code, frames and causes, not the error object", () => {
  const cause = Object.assign(new Error('relation "nope" does not exist'), { name: "PostgresError", errno: "42P01" });
  const error = new SchemaError("PostgreSQL schema change requires an explicit migration.\n- Table \"public\".\"products\": column type differs.");
  (error as { cause?: unknown }).cause = cause;
  const text = formatStartupFailure(error);
  const lines = text.split("\n");
  expect(lines[0]).toBe("SchemaError [ORM_SCHEMA_MIGRATION_REQUIRED]: PostgreSQL schema change requires an explicit migration.");
  expect(lines[1]).toBe('- Table "public"."products": column type differs.');
  expect(lines[2]).toMatch(/^\s+at /);
  expect(text).toContain('Caused by: PostgresError [42P01]: relation "nope" does not exist');
  expect(text).toMatch(/verification: \{\s*differences: \[\s*\{ table: 'products', nested: \{ deep: true \} \}/);
  expect(text).not.toContain("' +");
  expect(text.match(/explicit migration/g)).toHaveLength(1);
});

test("secrets in a startup failure are redacted and non-errors are inspected", () => {
  expect(formatStartupFailure(new Error("connect failed: password=hunter2"))).not.toContain("hunter2");
  expect(formatStartupFailure({ reason: "x" })).toContain("reason");
});

test("a message that already starts with its code is not prefixed twice", () => {
  const error = Object.assign(new Error("ORM_OWNED_STORE_DRIFT: Owned store \"acme.notes\" differs."), { name: "OrmOwnedStoreAdmissionError", code: "ORM_OWNED_STORE_DRIFT" });
  expect(formatStartupFailure(error).split("\n")[0]).toBe('OrmOwnedStoreAdmissionError: ORM_OWNED_STORE_DRIFT: Owned store "acme.notes" differs.');
});

test("services that failed together are listed once, without kernel frames or an inspected copy", () => {
  const text = formatStartupFailure(new StartupFailuresError([
    { name: "infra:db", error: new Error('Infra connector "postgres": failed to connect — refused') },
    { name: "infra:cache", error: new Error('Infra connector "redis": failed to connect within 5000 ms.') },
  ]));
  expect(text).toBe([
    "StartupFailuresError: 2 services failed to start: infra:db, infra:cache.",
    '  - Error: Infra connector "postgres": failed to connect — refused',
    '  - Error: Infra connector "redis": failed to connect within 5000 ms.',
  ].join("\n"));
});

// 0.117.1: a PostgresError printed where in PostgreSQL's sources it was
// raised (file, line, routine, severity); the hint and detail are what help.
test("a PostgresError keeps hint and detail but not PostgreSQL's source location", () => {
  const error = Object.assign(new Error('relation "nope" does not exist'), { name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "42P01", severity: "ERROR", file: "parse_relation.c", line: "1449", routine: "parserOpenTable", hint: "Check the table name.", detail: "In schema public." });
  const text = formatStartupFailure(error);
  expect(text).toContain('PostgresError [ERR_POSTGRES_SERVER_ERROR, 42P01]: relation "nope" does not exist');
  expect(text).toContain("Check the table name.");
  expect(text).toContain("In schema public.");
  for (const noise of ["parse_relation.c", "1449", "parserOpenTable", "severity"]) expect(text).not.toContain(noise);
});
