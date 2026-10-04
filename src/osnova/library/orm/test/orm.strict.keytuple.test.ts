import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, KeyTuple, ModelBuilder } from "../index";

@Entity({ table: "strict_key_tuples" })
class StrictKeyTupleRow {
  @Key(["tenantId", "entryId"]) @Column({ type: "text" }) tenantId = "";
  @Column({ type: "integer" }) entryId = 0;
  @Column({ type: "text" }) value = "";
}


describe("strict KeyTuple", () => {
  test("rejects incomplete, null, undefined and extra composite inputs before provider access", () => {
    const model = ModelBuilder.build(StrictKeyTupleRow);
    for (const input of [{ tenantId: "a" }, { tenantId: "a", entryId: null }, { tenantId: "a", entryId: undefined }, { tenantId: "a", entryId: 1, extra: true }, ["a", 1]]) {
      expect(() => KeyTuple.fromInput(model, input)).toThrow();
    }
  });

  test("uses typed structural identity rather than joined-string encoding", () => {
    const model = ModelBuilder.build(StrictKeyTupleRow);
    const first = KeyTuple.fromInput(model, { tenantId: "a:1", entryId: 2 });
    const second = KeyTuple.fromInput(model, { tenantId: "a", entryId: 12 });
    const typedString = KeyTuple.fromInput(model, { tenantId: "1", entryId: 2 });
    const typedNumber = KeyTuple.fromInput(model, { tenantId: "1", entryId: 2 });
    expect(first.equals(second)).toBeFalse();
    expect(first.toString()).not.toBe(second.toString());
    expect(typedString.equals(typedNumber)).toBeTrue();
  });

});
