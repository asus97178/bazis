import { describe, expect, test } from "bun:test";
import type { IntrospectedSchema } from "../index";
import { ExactSchemaVerifier } from "../Schema/ExactSchemaVerifier";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";

const expected: OrmExpectedSchema = { tables: [{ schema: "owned", table: "items", columns: [{ property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "none" }, generation: "identityByDefault" }, { property: "code", column: "code", physicalType: "text", nullable: false, default: { kind: "string", value: "safe-secret" }, generation: "none" }], primaryKey: { name: "pk_items", columns: ["id", "code"] }, indexes: [{ name: "ix_items_code_id", columns: ["code", "id"], unique: false, method: "btree" }], foreignKeys: [{ name: "fk_items_parent", columns: ["id", "code"], target: { schema: "owned", table: "parents" }, targetColumns: ["id", "code"], onDelete: "noAction", onUpdate: "cascade" }], checks: [{ name: "ck_items_code", expression: { kind: "compare", op: ">=", left: "id", right: 0 } }] }] };

function actual(overrides: Partial<Record<string, unknown>> = {}): IntrospectedSchema {
  const table = {
    name: "items",
    columns: new Map([["code", { name: "code", notNull: true, isPrimaryKey: true, physicalType: "text", default: { kind: "string", value: "safe-secret" }, generation: "none" }], ["id", { name: "id", notNull: true, isPrimaryKey: true, physicalType: "integer", default: { kind: "none" }, generation: "identityByDefault" }]]),
    indexes: [{ name: "ix_items_code_id", columns: ["code", "id"], unique: false, method: "btree" as const }],
    primaryKey: { name: "pk_items", columns: ["id", "code"] },
    foreignKeys: [{ name: "fk_items_parent", columns: ["id", "code"], targetSchema: "owned", targetTable: "parents", targetColumns: ["id", "code"], onDelete: "noAction", onUpdate: "cascade" }],
    checks: [{ name: "ck_items_code", expression: { kind: "compare", left: "id", op: ">=", right: 0 } }],
    ...overrides,
  };
  return { tables: new Map([["owned.items", table]]) } as unknown as IntrospectedSchema;
}
const codes = (schema: IntrospectedSchema) => new ExactSchemaVerifier().verify(expected, schema).differences.map((difference) => difference.code);

describe("strict exact schema verifier", () => {
  test("accepts canonical model despite physical column and object-property order; ignores unrelated tables", () => {
    const schema = actual(); (schema.tables as Map<string, unknown>).set("other.noise", { ...schema.tables.get("owned.items")!, name: "noise" });
    expect(new ExactSchemaVerifier().verify(expected, schema)).toMatchObject({ compatible: true });
  });
  test("reports complete core difference matrix deterministically and safely", () => {
    const mutations: readonly [string, IntrospectedSchema][] = [
      ["table.missing", { tables: new Map() }],
      ["column.unexpected", actual({ columns: new Map([...actual().tables.get("owned.items")!.columns, ["leak", { name: "leak", notNull: false, isPrimaryKey: false }]]) })],
      ["column.missing", actual({ columns: new Map([["id", actual().tables.get("owned.items")!.columns.get("id")!]]) })],
      ["column.type", actual({ columns: new Map([["id", { ...actual().tables.get("owned.items")!.columns.get("id")!, physicalType: "text" }], ["code", actual().tables.get("owned.items")!.columns.get("code")!]]) })],
      ["column.nullability", actual({ columns: new Map([["id", { ...actual().tables.get("owned.items")!.columns.get("id")!, notNull: false }], ["code", actual().tables.get("owned.items")!.columns.get("code")!]]) })],
      ["column.default", actual({ columns: new Map([["id", actual().tables.get("owned.items")!.columns.get("id")!], ["code", { ...actual().tables.get("owned.items")!.columns.get("code")!, default: { kind: "string", value: "raw-secret" } }]]) })],
      ["column.generation", actual({ columns: new Map([["id", { ...actual().tables.get("owned.items")!.columns.get("id")!, generation: "none" }], ["code", actual().tables.get("owned.items")!.columns.get("code")!]]) })],
      ["primaryKey.missing", actual({ primaryKey: undefined })], ["primaryKey.name", actual({ primaryKey: { name: "other", columns: ["id", "code"] } })], ["primaryKey.columns", actual({ primaryKey: { name: "pk_items", columns: ["code", "id"] } })],
      ["foreignKey.name", actual({ foreignKeys: [{ ...actual().tables.get("owned.items")!.foreignKeys![0]!, name: "other" }] })], ["foreignKey.columns", actual({ foreignKeys: [{ ...actual().tables.get("owned.items")!.foreignKeys![0]!, columns: ["code", "id"] }] })], ["foreignKey.target", actual({ foreignKeys: [{ ...actual().tables.get("owned.items")!.foreignKeys![0]!, targetTable: "other" }] })], ["foreignKey.actions", actual({ foreignKeys: [{ ...actual().tables.get("owned.items")!.foreignKeys![0]!, onDelete: "cascade" }] })], ["foreignKey.deferrable", actual({ foreignKeys: [{ ...actual().tables.get("owned.items")!.foreignKeys![0]!, deferrable: true }] })],
      ["index.columns", actual({ indexes: [{ ...actual().tables.get("owned.items")!.indexes[0]!, columns: ["id", "code"] }] })], ["index.uniqueness", actual({ indexes: [{ ...actual().tables.get("owned.items")!.indexes[0]!, unique: true }] })], ["index.method", actual({ indexes: [{ ...actual().tables.get("owned.items")!.indexes[0]!, method: undefined }] })], ["index.unsupportedShape", actual({ indexes: [{ ...actual().tables.get("owned.items")!.indexes[0]!, predicate: "partial" }] })],
      ["check.expression", actual({ checks: [{ name: "ck_items_code", expression: { kind: "compare", op: ">=", left: "id", right: 1 } }] })], ["catalog.unsupported", actual({ unsupported: true })],
    ];
    for (const [code, schema] of mutations) expect(codes(schema)).toContain(code as never);
    const differences = new ExactSchemaVerifier().verify(expected, mutations[0]![1]).differences;
    expect(differences).toEqual([...differences].sort((a, b) => `${a.schema}\0${a.table}\0${a.code}\0${a.objectName ?? ""}`.localeCompare(`${b.schema}\0${b.table}\0${b.code}\0${b.objectName ?? ""}`)));
    const defaultDifference = new ExactSchemaVerifier().verify(expected, mutations[5]![1]).differences[0]!;
    expect(defaultDifference.expected).toMatchObject({ kind: "canonicalDefault", hash: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(defaultDifference)).not.toContain("safe-secret");
  });
});
