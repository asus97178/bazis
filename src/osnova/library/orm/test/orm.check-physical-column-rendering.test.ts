import { describe, expect, test } from "bun:test";
import { Check, Column, Entity, Key, ModelBuildError, ModelBuilder, OrmModel, PostgresDialect, buildDynamicModel } from "../index";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";
import { renderSafeAdditivePostgres } from "../Schema/SafeAdditiveSchema";

@Entity({ table: "aliased_check_rows" })
@Check<AliasedCheckRow>("ck_aliased_tenant", (row) => row.tenantKey.eq("default"))
@Check<AliasedCheckRow>("ck_aliased_columns", (row) => row.leftValue.eq(row.rightValue))
@Check<AliasedCheckRow>("ck_aliased_in", (row) => row.stateCode.in(["ready", "sealed"]))
@Check<AliasedCheckRow>("ck_aliased_null", (row) => row.optionalNote.isNull().or(row.optionalNote.isNotNull()))
@Check<AliasedCheckRow>("ck_aliased_nested", (row) => row.tenantKey.ne("default").and(row.leftValue.gte(0)).or(row.stateCode.eq("blocked")).not())
class AliasedCheckRow {
  @Key({ generated: false }) @Column({ name: "row_id", type: "integer" }) id = 0;
  @Column({ name: "tenant_key", type: "text" }) tenantKey = "";
  @Column({ name: "left_value", type: "integer" }) leftValue = 0;
  @Column({ name: "right_value", type: "integer" }) rightValue = 0;
  @Column({ name: "state_code", type: "text" }) stateCode = "";
  @Column({ name: "optional_note", type: "text" }) optionalNote = "";
}

@Entity({ table: "invalid_aliased_check_rows" })
@Check<InvalidAliasedCheckRow>("ck_invalid_aliased", (row) => row.missingValue.eq("x"))
class InvalidAliasedCheckRow {
  @Key({ generated: false }) @Column({ name: "row_id", type: "integer" }) id = 0;
  missingValue = "";
}

describe("CHECK physical-column projection", () => {
  test("preserves property-keyed model checks while PostgreSQL physical boundaries render aliased columns", () => {
    const staticModel = ModelBuilder.build(AliasedCheckRow);
    expect(staticModel.checks.find((check) => check.name === "ck_aliased_tenant")?.expression).toMatchObject({ left: "tenantKey" });
    expect(staticModel.checks.find((check) => check.name === "ck_aliased_columns")?.expression).toMatchObject({ left: "leftValue", right: "\0rightValue" });

    const dynamicModel = buildDynamicModel({
      name: "AliasedDynamicCheckRow",
      tableName: "aliased_dynamic_check_rows",
      fields: [
        { name: "id", columnName: "row_id", type: "int", isKey: true },
        { name: "tenantKey", columnName: "tenant_key", type: "string" },
        { name: "leftValue", columnName: "left_value", type: "int" },
        { name: "rightValue", columnName: "right_value", type: "int" },
        { name: "stateCode", columnName: "state_code", type: "string" },
        { name: "optionalNote", columnName: "optional_note", type: "string" },
      ],
      checks: [
        { name: "ck_dynamic_compare", predicate: (row) => row.leftValue!.eq(row.rightValue!) },
        { name: "ck_dynamic_nested", predicate: (row) => row.tenantKey!.eq("default").and(row.stateCode!.in(["ready"])).or(row.optionalNote!.isNull()).not() },
      ],
    });
    expect(dynamicModel.checks[0]?.expression).toMatchObject({ left: "leftValue", right: "\0rightValue" });

    const expected = compileExpectedSchema(new OrmModel([AliasedCheckRow]));
    const expressions = JSON.stringify(expected.tables[0]!.checks);
    expect(expressions).toContain("tenant_key");
    expect(expressions).toContain("\\u0000right_value");
    for (const property of ["tenantKey", "leftValue", "rightValue", "stateCode", "optionalNote"]) expect(expressions).not.toContain(property);
    const dynamicRegistry = new OrmModel([]);
    dynamicRegistry.registerModel(dynamicModel);
    const dynamicExpected = compileExpectedSchema(dynamicRegistry);
    expect(JSON.stringify(dynamicExpected.tables[0]!.checks)).toContain("left_value");
    expect(JSON.stringify(dynamicExpected.tables[0]!.checks)).toContain("\\u0000right_value");

    const sql = new PostgresDialect().createTableSql(staticModel, []);
    for (const column of ["tenant_key", "left_value", "right_value", "state_code", "optional_note"]) expect(sql).toContain(`\"${column}\"`);
    for (const property of ["tenantKey", "leftValue", "rightValue", "stateCode", "optionalNote"]) expect(sql).not.toContain(`\"${property}\"`);
    const table = expected.tables[0]!;
    expect(renderSafeAdditivePostgres({ kind: "createTable", table })).toContain('"tenant_key"');
    const columnCheck = table.checks.find((check) => check.name === "ck_aliased_columns")!;
    expect(renderSafeAdditivePostgres({ kind: "addCheck", table, check: columnCheck })).toContain('"left_value"');

  });

  test("continues to reject unknown property identifiers before provider access", () => {
    expect(() => ModelBuilder.build(InvalidAliasedCheckRow)).toThrow(ModelBuildError);
  });
});
