import { describe, expect, test } from "bun:test";
import { Column, CreatedAt, Entity, HasConversion, Key, UUID } from "../index";
import { ModelBuilder } from "../Metadata/ModelBuilder";
import { ModelBuildError } from "../errors";

// A column without an explicit type maps to text (a key to an integer
// identity). Before 0.98.14 a number property silently became text (loaded
// back as "412"), and a string key became a bigint identity that dropped the
// assigned value. Now the model refuses to build and names the type to set.
describe("column type vs initial value (0.98.14)", () => {
  test("a number, boolean, Date or object without a type is refused", () => {
    @Entity() class Book { @Key() id = 0; @Column() title = ""; @Column() pages = 0; }
    expect(() => ModelBuilder.build(Book)).toThrow(new ModelBuildError(
      'Entity "Book": property "pages" has no column type and maps to text, but its initial value is a number. Set the type: @Column({ type: "integer" }) or @Column({ type: "real" }).',
    ));
    @Entity() class Flag { @Key() id = 0; @Column() on = false; }
    expect(() => ModelBuilder.build(Flag)).toThrow('Set the type: @Column({ type: "boolean" }).');
    @Entity() class Stamp { @Key() id = 0; @Column() at = new Date(0); }
    expect(() => ModelBuilder.build(Stamp)).toThrow('initial value is a Date. Set the type: @Column({ type: "datetime" }).');
    @Entity() class Doc { @Key() id = 0; @Column() body: Record<string, unknown> = {}; }
    expect(() => ModelBuilder.build(Doc)).toThrow('initial value is a object. Set the type: @Column({ type: "json" }).');
  });

  test("a string key without a type is refused", () => {
    @Entity() class Country { @Key() code = ""; @Column({ type: "text" }) name = ""; }
    expect(() => ModelBuilder.build(Country)).toThrow(new ModelBuildError(
      'Entity "Country": key "code" has no column type and maps to an integer identity, but its initial value is a string. For a text key add @Column({ type: "text" }) next to @Key(); for a UUID key use @UUID().',
    ));
  });

  test("explicit types, conventions, converters and matching defaults build as before", () => {
    @Entity() class Country { @Key() @Column({ type: "text" }) code = ""; @Column() name = ""; @Column({ type: "integer" }) population = 0; }
    const country = ModelBuilder.build(Country);
    expect(country.key[0]!.type).toBe("text");
    expect(country.key[0]!.generation).toBe("none");
    @Entity() class Note { @UUID({ version: "v7" }) id = ""; @CreatedAt() createdAt = new Date(0); @Column({ type: "text", nullable: true }) text: string | null = null; }
    expect(() => ModelBuilder.build(Note)).not.toThrow();
    @Entity() class Counter { @Key() id = 0; @HasConversion({ toProvider: (v: number) => String(v), fromProvider: (v: unknown) => Number(v) }) @Column() value = 0; }
    expect(() => ModelBuilder.build(Counter)).not.toThrow();
  });
});
