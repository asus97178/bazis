import { describe, expect, test } from "bun:test";
import type { IntrospectedSchema } from "../index";
import { ExactSchemaVerifier } from "../Schema/ExactSchemaVerifier";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";

const expected: OrmExpectedSchema = { tables: [{ schema: "public", table: "catalog", columns: [{ property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "none" }, generation: "none" }], primaryKey: { name: "pk_catalog", columns: ["id"] }, indexes: [{ name: "ix_catalog", columns: ["id"], unique: false, method: "btree" }], foreignKeys: [], checks: [] }] };
const base = (): IntrospectedSchema => ({ tables: new Map([["public.catalog", { name: "catalog", columns: new Map([["id", { name: "id", notNull: true, isPrimaryKey: true, physicalType: "integer", default: { kind: "none" }, generation: "none" }]]), primaryKey: { name: "pk_catalog", columns: ["id"] }, indexes: [{ name: "ix_catalog", columns: ["id"], unique: false, method: "btree" }], foreignKeys: [], checks: [] }]]) });
const verify = (schema: IntrospectedSchema) => new ExactSchemaVerifier().verify(expected, schema).differences.map((item) => item.code);

describe("strict PostgreSQL catalog normalization", () => {
  test("normalizes constraint backing indexes while rejecting all unsupported ordinary index shapes", () => {
    const schema = base(); const table = schema.tables.get("public.catalog")! as any;
    table.indexes = [...table.indexes, { name: "pk_catalog", columns: ["id"], unique: true, method: "btree", backingConstraint: true }, { name: "uq_catalog", columns: ["id"], unique: true, method: "btree", backingConstraint: true }];
    expect(verify(schema)).toEqual([]);
    // 0.115.0: a readable partial index condition is compared, not refused.
    const partial = base(); const partialTable = partial.tables.get("public.catalog")! as any; partialTable.indexes = [{ ...partialTable.indexes[0]!, predicate: { kind: "null", left: "id", not: false } }];
    expect(verify(partial)).toEqual(["index.predicate"]);
    for (const patch of [{ unsupported: true }, { method: undefined }, { columns: [], unique: false, method: "btree" as const }]) {
      const malformed = base(); const malformedTable = malformed.tables.get("public.catalog")! as any; malformedTable.indexes = [{ ...malformedTable.indexes[0]!, ...patch }];
      expect(verify(malformed)).toContain("index.unsupportedShape");
    }
  });
  test("reports missing and unexpected named constraints/indexes/checks and unsupported FK match form", () => {
    const schema = base(); const table = schema.tables.get("public.catalog")! as any;
    table.indexes = []; expect(verify(schema)).toContain("index.missing");
    table.indexes = [{ name: "noise", columns: ["id"], unique: false, method: "btree" }]; expect(verify(schema)).toContain("index.unexpected");
    table.foreignKeys = [{ name: "fk_noise", columns: ["id"], targetSchema: null, targetTable: "noise", targetColumns: ["id"], onDelete: "noAction", onUpdate: "noAction", unsupported: true }]; expect(verify(schema)).toContain("catalog.unsupported");
    table.checks = [{ name: "ck_noise", expression: { kind: "unsupported" }, unsupported: true }]; expect(verify(schema)).toContain("catalog.unsupported");
  });
  test("treats PostgreSQL's legacy null public FK target as public only at verification", () => {
    const publicExpected: OrmExpectedSchema = { tables: [{ ...expected.tables[0]!, foreignKeys: [{ name: "fk_catalog_parent", columns: ["id"], target: { schema: "public", table: "parents" }, targetColumns: ["id"], onDelete: "noAction", onUpdate: "noAction" }] }] };
    const schema = base();
    (schema.tables.get("public.catalog")! as any).foreignKeys = [{ name: "fk_catalog_parent", columns: ["id"], targetSchema: null, targetTable: "parents", targetColumns: ["id"], onDelete: "noAction", onUpdate: "noAction" }];
    expect(new ExactSchemaVerifier().verify(publicExpected, schema).differences).toEqual([]);
  });
});
