import { describe, expect, test } from "bun:test";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";
import type { IntrospectedSchema } from "../Schema/introspection";
import { classifySafeAdditive, renderSafeAdditivePostgres } from "../Schema/SafeAdditiveSchema";

const expected: OrmExpectedSchema = { tables: [{ schema: "owned", table: "items", columns: [
  { property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "none" }, generation: "none" },
  { property: "state", column: "state", physicalType: "text", nullable: false, default: { kind: "string", value: "new" }, generation: "none" },
], primaryKey: { name: "pk_items", columns: ["id"] }, indexes: [{ name: "ix_items_state", columns: ["state"], unique: false, method: "btree" }], foreignKeys: [], checks: [{ name: "ck_items_state", expression: { kind: "compare", left: "id", op: ">=", right: 0 } }] }] };
const existing: IntrospectedSchema = { schemas: new Set(["owned"]), tables: new Map([["owned.items", { name: "items", columns: new Map([["id", { name: "id", notNull: true, isPrimaryKey: true, physicalType: "integer", default: { kind: "none" }, generation: "none" }]]), primaryKey: { name: "pk_items", columns: ["id"] }, indexes: [], checks: [], foreignKeys: [] }]]) };

describe("safe additive PostgreSQL plan", () => {
  test("plans only closed additive operations in deterministic stages", () => {
    const verification = { compatible: false, differences: [
      { code: "column.missing" as const, schema: "owned", table: "items", objectName: "state" },
      { code: "check.missing" as const, schema: "owned", table: "items", objectName: "ck_items_state" },
      { code: "index.missing" as const, schema: "owned", table: "items", objectName: "ix_items_state" },
    ] };
    const plan = classifySafeAdditive(expected, existing, verification).plan!;
    expect(plan.map((operation) => operation.kind)).toEqual(["addColumn", "addCheck", "createIndex"]);
    const sql = plan.map(renderSafeAdditivePostgres);
    expect(sql.join("\n")).not.toMatch(/IF NOT EXISTS|CONCURRENTLY|UPDATE /);
    expect(sql[0]).toContain("DEFAULT 'new' NOT NULL");
  });
  test("rejects an unsafe missing NOT NULL/generated column and never returns a mixed plan", () => {
    const unsafe: OrmExpectedSchema = { tables: [{ ...expected.tables[0]!, columns: [...expected.tables[0]!.columns, { property: "must", column: "must", physicalType: "text", nullable: false, default: { kind: "none" }, generation: "none" }] }] };
    const verification = { compatible: false, differences: [{ code: "column.missing" as const, schema: "owned", table: "items", objectName: "must" }, { code: "index.missing" as const, schema: "owned", table: "items", objectName: "ix_items_state" }] };
    const result = classifySafeAdditive(unsafe, existing, verification);
    expect(result.plan).toBeUndefined();
    expect(result.hardDifferences.map((difference) => difference.objectName)).toEqual(["must"]);
    expect(result.verification.differences.map((difference) => difference.objectName)).toEqual(["must", "ix_items_state"]);
  });
  test("renders JSON scalar and datetime defaults as typed PostgreSQL literals", () => {
    const table = expected.tables[0]!;
    for (const [column, fragment] of [
      [{ property: "jsonText", column: "json_text", physicalType: "json", nullable: true, default: { kind: "string" as const, value: "ok" }, generation: "none" as const }, "DEFAULT '\"ok\"'::jsonb"],
      [{ property: "jsonNumber", column: "json_number", physicalType: "json", nullable: true, default: { kind: "number" as const, value: 7 }, generation: "none" as const }, "DEFAULT '7'::jsonb"],
      [{ property: "jsonBool", column: "json_bool", physicalType: "json", nullable: true, default: { kind: "boolean" as const, value: true }, generation: "none" as const }, "DEFAULT 'true'::jsonb"],
      [{ property: "at", column: "at", physicalType: "datetime", nullable: true, default: { kind: "string" as const, value: "2026-08-06T00:00:00Z" }, generation: "none" as const }, "DEFAULT '2026-08-06T00:00:00Z'"],
    ] as const) expect(renderSafeAdditivePostgres({ kind: "addColumn", table, column })).toContain(fragment);
  });
});
