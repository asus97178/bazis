import { describe, expect, test } from "bun:test";
import {
  Column,
  Entity,
  Key,
  ModelBuilder,
  UUID,
} from "@/library/orm";

@Entity()
class AuditedEntity {
  @Key()
  @Column({ type: "uuid" })
  id = "";

  @Column({ type: "text" })
  name = "";

  @Column({ type: "createdAt" })
  createdAt!: Date;

  @Column({ type: "updatedAt" })
  updatedAt!: Date;
}

@Entity()
class UuidEntity {
  @UUID()
  id = "";
}

describe("ORM conventions (@UUID, @CreatedAt, @UpdatedAt)", () => {
  test("@Key + @Column({ type: 'uuid' }) builds DB-generated uuid key", () => {
    const model = ModelBuilder.build(AuditedEntity);
    expect(model.key[0].type).toBe("text");
    expect(model.key[0].generation).toBe("uuid");
    expect(model.key[0].convention).toBeUndefined();
    expect(model.propertyByName("createdAt")?.type).toBe("datetime");
    expect(model.propertyByName("createdAt")?.convention).toBe("createdAt");
    expect(model.propertyByName("updatedAt")?.convention).toBe("updatedAt");
  });

  test("@UUID() marks key as DB-generated (generation uuid)", () => {
    const model = ModelBuilder.build(UuidEntity);
    expect(model.key[0].generation).toBe("uuid");
    expect(model.key[0].convention).toBeUndefined();
  });

});
