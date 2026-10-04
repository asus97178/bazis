import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, ModelBuilder, PostgresDialect, Schema } from "@/library/orm";

@Schema("billing")
@Entity({ migrate: true })
class InSchema {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";
}

@Schema()
@Entity({ migrate: true })
class EmptySchema {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";
}

@Entity({ migrate: true })
class NoSchema {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";
}

describe("@Schema()", () => {
  test("sets schema name when provided", () => {
    const model = ModelBuilder.build(InSchema);
    expect(model.schema).toBe("billing");
    expect(new PostgresDialect().qualifyTable(model)).toBe('"billing"."InSchemas"');
  });

  test("empty decorator leaves schema undefined", () => {
    expect(ModelBuilder.build(EmptySchema).schema).toBeUndefined();
  });

  test("missing decorator leaves schema undefined", () => {
    expect(ModelBuilder.build(NoSchema).schema).toBeUndefined();
    expect(new PostgresDialect().qualifyTable(ModelBuilder.build(NoSchema))).toBe('"NoSchemas"');
  });
});
