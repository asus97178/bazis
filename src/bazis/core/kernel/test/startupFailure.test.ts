import { expect, test } from "bun:test";
import { formatStartupFailure } from "../startupFailure";

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
