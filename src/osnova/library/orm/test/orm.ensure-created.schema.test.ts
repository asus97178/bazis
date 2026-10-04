import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, ModelBuilder, OrmModel, Schema, UUID } from "../index";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";

@Schema("admission")
@Entity({ table: "schema_vectors" })
class SchemaVectors {
  @Key({ name: "pk_schema_vectors" }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "datetime" }) createdAt = new Date();
}
@Entity({ table: "schema_uuid_vectors" })
class SchemaUuidVectors { @UUID() id = ""; }

describe("ensure-created expected schema", () => {
  test("normalizes PostgreSQL types and key constraint names", () => {
    const expected = compileExpectedSchema(new OrmModel([SchemaVectors, SchemaUuidVectors]));
    expect(expected.tables[0]).toMatchObject({ schema: "admission", table: "schema_vectors", primaryKey: { name: "pk_schema_vectors", columns: ["id"] } });
    expect(expected.tables[0]!.columns.map((column) => column.physicalType)).toEqual(["integer", "datetime"]);
    expect(expected.tables[1]!.columns[0]).toMatchObject({ physicalType: "uuid", default: { kind: "uuidV4" }, generation: "uuidDefault" });
  });
});
