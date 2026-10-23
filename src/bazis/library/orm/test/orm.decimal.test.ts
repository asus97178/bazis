import { expect, test } from "bun:test";
import { Column, Entity, Key, OrmModel, OrmError } from "../index";
import { PostgresDialect } from "../Providers/PostgresDialect";
import { canonicalPostgresType, exactPostgresType } from "../Providers/PostgresSchema.decoder";
import { assertDecimalFits } from "../Providers/decimalValue";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";

// 0.117.0: an exact decimal type. "real" is a double: 0.1 + 0.2 is stored as
// 0.30000000000000004, which does not suit money.
@Entity({ table: "prices" })
class Price {
  @Key() id = 0;
  @Column({ type: "decimal", precision: 12, scale: 2 }) amount = "0";
  @Column({ type: "decimal" }) rate: string | null = null;
}
const model = new OrmModel([Price]).entities[0]!;
const amount = model.propertyByName("amount")!;

test("decimal maps to numeric(precision, scale) and reads back as the same label", () => {
  expect([amount.type, amount.precision, amount.scale]).toEqual(["decimal", 12, 2]);
  expect(new PostgresDialect().createTableSql(model, [])).toContain('"amount" numeric(12, 2)');
  expect(new PostgresDialect().createTableSql(model, [])).toContain('"rate" numeric');
  expect(compileExpectedSchema(new OrmModel([Price])).tables[0]!.columns.map((column) => column.physicalType)).toEqual(["integer", "decimal(12,2)", "decimal"]);
  expect(canonicalPostgresType("numeric(12,2)")).toBe("decimal(12,2)");
  expect(canonicalPostgresType("numeric")).toBe("decimal");
  expect(exactPostgresType("numeric(12,2)", "decimal(12,2)")).toBe("decimal(12,2)");
});

test("a decimal value is a string, a bigint or a safe integer; a float is refused", () => {
  const dialect = new PostgresDialect();
  expect(dialect.encode("19.90", "decimal")).toBe("19.90");
  expect(dialect.encode(7, "decimal")).toBe("7");
  expect(dialect.encode(12n, "decimal")).toBe("12");
  expect(() => dialect.encode(0.1, "decimal")).toThrow('A decimal value must be a string such as "19.90" (or an integer), got number.');
  expect(() => dialect.encode("1,5", "decimal")).toThrow(OrmError);
  expect(dialect.decode("19.90", "decimal")).toBe("19.90");
});

test("a value that would lose digits is refused before the write", () => {
  expect(() => assertDecimalFits("Price", amount, "1.005")).toThrow('Price.amount: "1.005" has 3 digits after the point; numeric(12, 2) keeps 2. Round it in the code.');
  expect(() => assertDecimalFits("Price", amount, "12345678901.00")).toThrow("at most 10 digits before the point");
  expect(() => assertDecimalFits("Price", amount, "1.500")).not.toThrow();
  expect(() => assertDecimalFits("Price", amount, "-0.01")).not.toThrow();
  expect(() => assertDecimalFits("Price", amount, "9999999999.99")).not.toThrow();
});

test("precision and scale are checked when the model is built", () => {
  @Entity({ table: "bad_a" }) class BadScale { @Key() id = 0; @Column({ type: "decimal", precision: 2, scale: 3 }) v = "0"; }
  @Entity({ table: "bad_b" }) class NotDecimal { @Key() id = 0; @Column({ type: "real", precision: 5 }) v = 0; }
  @Entity({ table: "bad_c" }) class DecimalKey { @Key() @Column({ type: "decimal" }) id = "0"; }
  expect(() => new OrmModel([BadScale])).toThrow("scale must be an integer from 0 to precision (2).");
  expect(() => new OrmModel([NotDecimal])).toThrow('precision and scale need @Column({ type: "decimal" }).');
  expect(() => new OrmModel([DecimalKey])).toThrow('key "id" cannot be decimal');
});
