import { expect, test } from "bun:test";
import { PostgresDialect } from "../Providers/PostgresDialect";
import { integerParameter } from "../Providers/integerValue";

// An integer column is `bigint`; a JavaScript number is a double. Beyond 2^53 a
// parameter sent as a double makes the database compare doubles.

test("an integer goes to the database as it was written: a number while it is exact, a bigint beyond 2^53", () => {
  expect(integerParameter(42)).toBe(42);
  expect(integerParameter("42")).toBe(42);
  expect(integerParameter(" -7 ")).toBe(-7);
  expect(integerParameter("+7")).toBe(7);
  expect(integerParameter("007")).toBe(7);
  expect(integerParameter(9007199254740991)).toBe(9007199254740991);
  expect(integerParameter("9007199254740991")).toBe(9007199254740991);
  expect(integerParameter("-9007199254740991")).toBe(-9007199254740991);

  // The string names an integer a double cannot hold: it stays that integer.
  expect(integerParameter("9007199254740993")).toBe(9007199254740993n);
  expect(integerParameter("1234567890123456789")).toBe(1234567890123456789n);
  expect(integerParameter("-1234567890123456789")).toBe(-1234567890123456789n);
  expect(integerParameter("9223372036854775807")).toBe(9223372036854775807n);
  expect(integerParameter("-9223372036854775808")).toBe(-9223372036854775808n);
  expect(integerParameter(1234567890123456789n)).toBe(1234567890123456789n);
  // A whole number of that size is a double already, but it is compared with the column as an integer.
  expect(integerParameter(9007199254740992)).toBe(9007199254740992n);
  expect(integerParameter(-1e18)).toBe(-1000000000000000000n);
});

test("what is not an integer of the column goes as a number, as before", () => {
  expect(integerParameter(5.5)).toBe(5.5);
  expect(integerParameter("5.5")).toBe(5.5);
  expect(integerParameter("1e3")).toBe(1000);
  expect(integerParameter(true)).toBe(1);
  expect(integerParameter("many")).toBeNaN();
  // Outside bigint: the database refuses it or compares it as a double.
  expect(integerParameter("9223372036854775808")).toBe(9223372036854775808);
  expect(integerParameter(1e30)).toBe(1e30);
  expect(integerParameter("1".repeat(41))).toBe(Number("1".repeat(41)));
});

test("the dialect encodes an integer column exactly and leaves a real column a double", () => {
  const dialect = new PostgresDialect();
  expect(dialect.encode("1234567890123456789", "integer")).toBe(1234567890123456789n);
  expect(dialect.encode(9007199254740992, "integer")).toBe(9007199254740992n);
  expect(dialect.encode("12", "integer")).toBe(12);
  expect(dialect.encode(null, "integer")).toBeNull();
  expect(dialect.encode("1234567890123456789", "real")).toBe(1234567890123456800);
  expect(dialect.encode("0.5", "real")).toBe(0.5);
});
