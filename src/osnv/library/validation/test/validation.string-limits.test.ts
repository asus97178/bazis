import { describe, expect, spyOn, test } from "bun:test";
import { Validator } from "../index";

describe("string validation admission", () => {
  for (const mode of ["sync", "async"] as const) {
    test(`${mode}: maxLength rejects before pattern while other fields still validate`, async () => {
      const pattern = /^[a-z]+$/;
      const check = spyOn(pattern, "test");
      class Input {
        @Validator({ maxLength: 4, pattern })
        value = "OVERSIZED";

        @Validator({ min: 0 })
        count = -1;
      }
      try {
        const result = mode === "sync" ? Validator.validate(new Input()) : await Validator.validateAsync(new Input());
        expect(check).not.toHaveBeenCalled();
        expect(result.errors.map(({ property, code }) => ({ property, code }))).toEqual([
          { property: "value", code: "maxLength" },
          { property: "count", code: "min" },
        ]);
      } finally {
        check.mockRestore();
      }
    });
  }

  test("the upper length range also prevents pattern evaluation", () => {
    const pattern = /^[a-z]+$/;
    const check = spyOn(pattern, "test");
    class Input {
      @Validator({ length: [2, 4], pattern })
      value = "OVERSIZED";
    }
    try {
      expect(Validator.validate(new Input()).errors.map(({ code }) => code)).toEqual(["length"]);
      expect(check).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });

  test("collects both upper length errors without running content checks", () => {
    class Input {
      @Validator({ maxLength: 4, length: [2, 6], contains: "valid", notContains: "!", pattern: "^[a-z]+$", email: true })
      value = "INVALID!";
    }
    expect(Validator.validate(new Input()).errors.map(({ code }) => code)).toEqual(["maxLength", "length"]);
  });

  test("values at the upper limit and below the lower limit keep pattern validation", () => {
    class Input {
      @Validator({ minLength: 2, maxLength: 4, pattern: /^[a-z]+$/ })
      value = "abcd";
    }
    const input = new Input();
    expect(Validator.validate(input).isValid).toBe(true);
    input.value = "ABCD";
    expect(Validator.validate(input).errors.map(({ code }) => code)).toEqual(["pattern"]);
    input.value = "A";
    expect(Validator.validate(input).errors.map(({ code }) => code)).toEqual(["minLength", "pattern"]);
  });

  test("length admission preserves custom validation and conditional rules", () => {
    let customCalls = 0;
    class Input {
      @Validator({ maxLength: 4, pattern: /^[a-z]+$/, custom: () => { customCalls++; return false; } })
      value = "OVERSIZED";

      @Validator({ validateIf: () => false, maxLength: 4, pattern: /^[a-z]+$/ })
      ignored = "OVERSIZED";
    }
    expect(Validator.validate(new Input()).errors.map(({ code }) => code)).toEqual(["maxLength", "custom"]);
    expect(customCalls).toBe(1);
  });
});

describe("built-in email grammar", () => {
  class EmailInput {
    @Validator({ email: true })
    email = "";
  }

  for (const email of ["user@example.com", "a@b.c", ".@..b", "a@b..", "a@...", "юзер@пример.рф", "a+b@sub.example.com"]) {
    test(`preserves accepted email ${JSON.stringify(email)}`, () => {
      expect(Validator.validate(Object.assign(new EmailInput(), { email })).isValid).toBe(true);
    });
  }

  for (const email of ["", "@b.c", "a@", "a@b", "a@.b", "a@b.", "a@b.c@", " a@b.c", "a@b.c\n", "a@b.\tc", "a@b.\u00a0c"]) {
    test(`preserves rejected email ${JSON.stringify(email)}`, () => {
      expect(Validator.validate(Object.assign(new EmailInput(), { email })).errors.map(({ code }) => code)).toEqual(["email"]);
    });
  }
});
