import { afterEach, describe, expect, test } from "bun:test";
import { RU_VALIDATION_MESSAGES, RuleSet, Validator } from "@/library/validation";

// 0.121.0: rules as data (Validator.ruleSet) for objects without a decorated
// class, such as rows of tables that users create at run time.

afterEach(() => {
  Validator.resetDefaultMessages();
});

describe("Validator.ruleSet", () => {
  const rules = Validator.ruleSet({
    title: { required: true, minLength: 2, maxLength: 10 },
    amount: [{ type: "number", min: 0 }, { integer: true }],
    email: { email: true },
    state: { enumType: { New: "new", Done: "done" } },
  });

  test("a valid plain object passes", () => {
    expect(rules.validate({ title: "Order", amount: 3, email: "a@b.io", state: "new" }).isValid).toBe(true);
  });

  test("errors carry the same codes, paths and params as decorators", () => {
    const result = rules.validate({ title: "", amount: -1.5, email: "nope", state: "lost" });
    expect(result.errors.map((error) => [error.property, error.code])).toEqual([
      ["title", "minLength"],
      ["amount", "min"],
      ["amount", "integer"],
      ["email", "email"],
      ["state", "enum"],
    ]);
    expect(result.errors[0]!.params).toMatchObject({ min: 2 });
  });

  test("required and optional fields", () => {
    expect(rules.validate({}).errors.map((error) => error.code)).toEqual(["required"]);
    expect(rules.validate({ title: "Ok", amount: null }).isValid).toBe(true);
  });

  test("messages follow the global registry and the local message", () => {
    Validator.setDefaultMessages(RU_VALIDATION_MESSAGES);
    const local = Validator.ruleSet({ code: { pattern: "^\\d+$", message: "Только цифры" } });
    expect(local.validate({ code: "x1" }).errors[0]!.message).toBe("Только цифры");
    expect(rules.validate({}).errors[0]!.message).not.toContain("required");
  });

  test("custom gets the whole object; async custom needs validateAsync", async () => {
    const cross = Validator.ruleSet({
      end: { custom: (value, row) => (value as number) >= (row as { start: number }).start || "end before start" },
      slow: { custom: async (value) => value === "ok" },
    });
    expect(cross.validate({ start: 5, end: 3 }).errors.map((error) => error.message)).toContain("end before start");
    expect(cross.validate({ slow: "bad" }).errors.map((error) => error.code)).toEqual(["asyncCustomInSyncCall"]);
    expect((await cross.validateAsync({ slow: "bad" })).errors.map((error) => error.code)).toEqual(["custom"]);
    expect((await cross.validateAsync({ slow: "ok" })).isValid).toBe(true);
  });

  test("fields lists the rule names once", () => {
    expect(rules.fields).toEqual(["title", "amount", "email", "state"]);
  });

  test("names of Object.prototype are rejected, inherited values are never read", () => {
    expect(() => new RuleSet({ constructor: { required: true } })).toThrow(TypeError);
    expect(() => new RuleSet({ __proto__: { required: true } } as never)).not.toThrow();
    expect(() => Validator.ruleSet(JSON.parse('{"__proto__": {"required": true}}'))).toThrow(TypeError);
    expect(() => Validator.ruleSet({ toString: { required: true } })).toThrow(TypeError);
  });

  test("a regex pattern from a string is compiled once and reused", () => {
    const digits = Validator.ruleSet({ pin: { pattern: "^\\d{4}$", maxLength: 4 } });
    for (let index = 0; index < 3; index += 1) {
      expect(digits.validate({ pin: "12a4" }).errors.map((error) => error.code)).toEqual(["pattern"]);
    }
  });
});
