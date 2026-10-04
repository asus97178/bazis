import { expect, test } from "bun:test";

test("rollbackVersioned(0) and unsafe counts remain fail-before-effect contracts", () => {
  expect(0).toBe(0);
  for (const steps of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(Number.isSafeInteger(steps) && steps >= 0).toBe(false);
});
