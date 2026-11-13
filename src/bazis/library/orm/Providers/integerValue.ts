const INTEGER_TEXT = /^[+-]?\d{1,40}$/u;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/**
 * The parameter for an integer column (`bigint` in PostgreSQL). A JavaScript
 * number is a double: sent as one, an integer beyond 2^53 makes the database
 * turn the column into doubles too, and `id = "1234567890123456789"` finds the
 * neighbouring row as well. So an integer written as a string, and a whole
 * number of that size, go as a `bigint` and are compared exactly.
 *
 * Anything else — a fraction, a value outside `bigint` — goes as a number, as
 * before: the database compares it as a double or refuses it.
 */
export function integerParameter(value: unknown): number | bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    const text = value.trim();
    return INTEGER_TEXT.test(text) ? exact(BigInt(text), Number(text)) : Number(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return exact(BigInt(value), value);
  return Number(value);
}

/** A number while it holds the integer exactly, a `bigint` while the column can hold it, the double otherwise. */
function exact(integer: bigint, double: number): number | bigint {
  if (Number.isSafeInteger(double)) return double;
  return integer >= INT8_MIN && integer <= INT8_MAX ? integer : double;
}
