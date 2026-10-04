import { describe, expect, test } from "bun:test";
import { Column, Entity, Index, Key, ModelBuilder } from "@/core/orm";

@Entity()
class ConventionUser {
  @Key()
  id = 0;

  @Index({ unique: true })
  @Column({ type: "text" })
  email = "";
}

describe("ORM metadata and conventions", () => {
  test("builds table name, generated key and indexes without a provider", () => {
    const model = ModelBuilder.build(ConventionUser);
    expect(model.tableName).toBe("ConventionUsers");
    expect(model.key[0]).toMatchObject({ propertyName: "id", generation: "identity" });
    expect(model.indexes).toEqual([expect.objectContaining({ columns: ["email"], unique: true })]);
  });
});
