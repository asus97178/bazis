import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, ModelBuilder, UUID } from "../index";

@Entity({ table: "admission_key_metadata" })
class AdmissionKeyMetadata {
  @Key({ generated: false, name: "pk_admission_key_metadata" }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "text" }) value = "";
}

@Entity({ table: "admission_uuid_metadata" })
class AdmissionUuidMetadata { @UUID({ name: "pk_admission_uuid_metadata" }) id = ""; }

@Entity({ table: "admission_composite_metadata" })
class AdmissionCompositeMetadata {
  @Key(["tenant", "id"], { name: "pk_admission_composite_metadata" }) @Column({ type: "text" }) tenant = "";
  @Column({ type: "text" }) id = "";
}

describe("ensure-created metadata", () => {
  test("preserves the single key authority order and physical constraint name", () => {
    const scalar = ModelBuilder.build(AdmissionKeyMetadata);
    expect(scalar.key.map((key) => key.propertyName)).toEqual(["id"]);
    expect(scalar.key[0]!.generation).toBe("none");
    expect(scalar.keyName).toBe("pk_admission_key_metadata");
    expect(ModelBuilder.build(AdmissionUuidMetadata).keyName).toBe("pk_admission_uuid_metadata");
    expect(ModelBuilder.build(AdmissionCompositeMetadata).key.map((key) => key.propertyName)).toEqual(["tenant", "id"]);
  });
});
