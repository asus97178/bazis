import { describe, expect, test } from "bun:test";
import { Column, Entity, Key, ModelBuilder, Required } from "../index";

@Entity({ table: "default_vectors" })
class DefaultVectors {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "text", default: "new" }) state = "";
  @Required() @Column({ type: "integer", default: 7 }) attempts = 0;
}

describe("PostgreSQL physical column defaults", () => {
  test("compile as physical literals without changing field initializers", () => {
    const model = ModelBuilder.build(DefaultVectors);
    expect(model.propertyByName("state")?.databaseDefault).toEqual({ kind: "string", value: "new" });
    expect(model.propertyByName("attempts")?.databaseDefault).toEqual({ kind: "number", value: 7 });
    expect(new DefaultVectors()).toMatchObject({ state: "", attempts: 0 });
  });
  test("rejects incompatible literal defaults before provider access", () => {
    expect(() => {
      @Entity({ table: "bad_default" })
      class BadDefault { @Key() @Column({ type: "integer" }) id = 0; @Required() @Column({ type: "text", default: null }) value = ""; }
      ModelBuilder.build(BadDefault);
    }).toThrow(/NULL database default/);
    expect(() => {
      @Entity({ table: "bad_key_default" })
      class BadKeyDefault { @Key() @Column({ type: "integer", default: 1 }) id = 0; }
      ModelBuilder.build(BadKeyDefault);
    }).toThrow(/not allowed/);
  });
  test("accepts 1024 code units and rejects hostile or oversized default authoring", () => {
    expect(() => {
      @Entity({ table: "default_1024" }) class Boundary { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text", default: "x".repeat(1024) }) value = ""; }
      ModelBuilder.build(Boundary);
    }).not.toThrow();
    expect(() => {
      @Entity({ table: "default_1025" }) class Oversized { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text", default: "x".repeat(1025) }) value = ""; }
      ModelBuilder.build(Oversized);
    }).toThrow(/1024/);
    expect(() => {
      @Entity({ table: "default_hostile" }) class Hostile { @Key() @Column({ type: "integer" }) id = 0; @Column({ type: "text", default: {} as never }) value = ""; }
      ModelBuilder.build(Hostile);
    }).toThrow();
  });
  test("accepts only calendar-valid RFC3339 datetime defaults with a timezone", () => {
    for (const value of ["2026-08-09T14:30:45Z", "2026-08-09T14:30:45+03:00", "2026-08-09T14:30:45-05:30"]) {
      expect(() => buildDatetimeDefault(value)).not.toThrow();
    }
    for (const value of ["2026-08-09T14:30:45", "2026-08-09T14:30:45+24:00", "2026-08-09T14:30:45-03:60", "2026-02-29T14:30:45Z", "2026-08-09 14:30:45Z"]) {
      expect(() => buildDatetimeDefault(value)).toThrow(/canonical RFC3339 with timezone/);
    }
  });
});

function buildDatetimeDefault(value: string): void {
  @Entity({ table: "datetime_default_vector" })
  class DatetimeDefaultVector {
    @Key() @Column({ type: "integer" }) id = 0;
    @Column({ type: "datetime", default: value }) createdAt = new Date(0);
  }
  ModelBuilder.build(DatetimeDefaultVector);
}
