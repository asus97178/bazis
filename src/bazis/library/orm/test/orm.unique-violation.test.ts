import { expect, test } from "bun:test";
import { databaseHttpError } from "@/core/orm";
import { Column, Entity, Index, ModelBuildError, OrmModel, UniqueViolationError, UUID, Nullable } from "@/library/orm";
import { describeViolation } from "@/library/orm/errors";

@Index(["shopId", "code"], { unique: true })
@Entity({ table: "uv_products" })
class Product {
  @UUID() id = "";
  @Index({ unique: true, conflict: "A product with this name already exists" })
  @Nullable() @Column({ type: "text", name: "product_name" }) name = "";
  @Nullable() @Column({ type: "text" }) shopId = "";
  @Nullable() @Column({ type: "text" }) code = "";
}

const models = new OrmModel([Product]);
const violation = (constraint: string | undefined, table = "uv_products") => new UniqueViolationError({ errno: "23505", ...(constraint === undefined ? {} : { constraint }), table });

test("a unique violation names the properties of its index and carries the text", () => {
  const error = describeViolation(violation("ix_uv_products_product_name"), models) as UniqueViolationError;
  expect(error.properties).toEqual(["name"]);
  expect(error.conflict).toBe("A product with this name already exists");
  const composite = describeViolation(violation("ix_uv_products_shopId_code"), models) as UniqueViolationError;
  expect(composite.properties).toEqual(["shopId", "code"]);
  expect(composite.conflict).toBeUndefined();
  expect((describeViolation(violation("pk_uv_products"), models) as UniqueViolationError).properties).toEqual(["id"]);
});

test("a constraint the model does not know stays as it came", () => {
  expect((describeViolation(violation("ix_other"), models) as UniqueViolationError).properties).toEqual([]);
  expect((describeViolation(violation("ix_uv_products_product_name", "another_table"), models) as UniqueViolationError).properties).toEqual([]);
  expect((describeViolation(violation(undefined), models) as UniqueViolationError).properties).toEqual([]);
  const other = new Error("x");
  expect(describeViolation(other, models)).toBe(other);
});

test("over HTTP it is 409 with the text and the fields, never the values", () => {
  const named = databaseHttpError(describeViolation(violation("ix_uv_products_product_name"), models));
  expect(named).toMatchObject({ status: 409, message: "A product with this name already exists", details: { code: "unique", fields: ["name"] } });
  const plain = databaseHttpError(describeViolation(violation("ix_uv_products_shopId_code"), models));
  expect(plain).toMatchObject({ status: 409, message: "Conflict", details: { code: "unique", fields: ["shopId", "code"] }, localized: { key: "conflict" } });
  expect(databaseHttpError(new Error("x"))).toBeUndefined();
});

test("conflict is only for a unique index", () => {
  @Entity({ table: "uv_bad" })
  class Bad {
    @UUID() id = "";
    @Index({ conflict: "taken" })
    @Nullable() @Column({ type: "text" }) name = "";
  }
  expect(() => new OrmModel([Bad])).toThrow(ModelBuildError);
});
