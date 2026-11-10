import { expect, test } from "bun:test";
import { Column, CreatedAt, Entity, Index, Key, ModelBuildError, Nullable, OrmModel, Required, SoftDelete, UpdatedAt, UUID } from "@/library/orm";

const requiredOf = (entity: new () => object) => Object.fromEntries(new OrmModel([entity]).entities[0]!.properties.map((property) => [property.propertyName, property.required]));
const problem = (entity: new () => object) => {
  try {
    new OrmModel([entity]);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelBuildError);
    return (error as Error).message;
  }
  return undefined;
};

test("every column says whether it may be empty; keys, timestamps and soft delete need no mark", () => {
  @Entity({ table: "cm_tasks" })
  class Task {
    @UUID() id = "";
    @Required() @Column({ type: "text" }) title = "";
    @Nullable() @Column({ type: "text" }) note: string | null = null;
    @Index() @Required() ownerId = "";
    @Column({ type: "createdAt" }) createdAt = new Date(0);
    @CreatedAt() madeAt = new Date(0);
    @UpdatedAt() updatedAt = new Date(0);
    @SoftDelete() deletedAt: Date | null = null;
  }
  expect(requiredOf(Task)).toEqual({ id: true, title: true, note: false, ownerId: true, createdAt: true, madeAt: true, updatedAt: true, deletedAt: false });
});

test("a column without a mark stops the build and names the two marks", () => {
  @Entity({ table: "cm_silent" })
  class Silent {
    @UUID() id = "";
    @Column({ type: "text" }) title = "";
  }
  expect(problem(Silent)).toBe('Entity "Silent": property "title" does not say whether it may be empty. Mark it @Required() (NOT NULL) or @Nullable().');

  @Entity({ table: "cm_plain_uuid" })
  class PlainUuid {
    @UUID() id = "";
    @Column({ type: "uuid" }) ownerId = "";
  }
  expect(problem(PlainUuid)).toContain('property "ownerId" does not say whether it may be empty');

  @Entity({ table: "cm_indexed" })
  class Indexed {
    @UUID() id = "";
    @Index() code = "";
  }
  expect(problem(Indexed)).toContain('property "code" does not say whether it may be empty');
});

test("both marks, or @Nullable() on what is always NOT NULL, are refused", () => {
  @Entity({ table: "cm_both" })
  class Both {
    @UUID() id = "";
    @Required() @Nullable() @Column({ type: "text" }) title = "";
  }
  expect(problem(Both)).toBe('Entity "Both": property "title" is marked both @Required() and @Nullable(). Keep one.');

  @Entity({ table: "cm_key" })
  class NullableKey {
    @Key() @Nullable() @Column({ type: "integer" }) id = 0;
  }
  expect(problem(NullableKey)).toBe('Entity "NullableKey": property "id" is a key and cannot be @Nullable().');

  @Entity({ table: "cm_stamp" })
  class NullableStamp {
    @UUID() id = "";
    @Nullable() @Column({ type: "updatedAt" }) updatedAt = new Date(0);
  }
  expect(problem(NullableStamp)).toBe('Entity "NullableStamp": property "updatedAt" is a creation or change timestamp and cannot be @Nullable().');
});

test("@Required() on a key is allowed: it says what is already true", () => {
  @Entity({ table: "cm_marked_key" })
  class MarkedKey {
    @Key() @Required() @Column({ type: "integer" }) id = 0;
    @Required() @Column({ type: "text" }) name = "";
  }
  expect(requiredOf(MarkedKey)).toEqual({ id: true, name: true });
});
