import { expect, test } from "bun:test";
import { DiError, isConfigurationError, markConfigurationError } from "../index";

test("DI errors and marked errors are configuration errors; others are not", () => {
  expect(isConfigurationError(new DiError("x"))).toBe(true);
  expect(isConfigurationError(new Error("x"))).toBe(false);
  expect(isConfigurationError("x")).toBe(false);
  const error = new TypeError("bad option");
  expect(markConfigurationError(error)).toBe(error);
  expect(isConfigurationError(error)).toBe(true);
  // Marking keeps the error's own class and message.
  expect(error).toBeInstanceOf(TypeError);
  expect(Object.keys(error)).toEqual([]);
});
