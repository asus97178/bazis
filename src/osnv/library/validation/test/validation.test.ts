import { afterEach, describe, expect, test } from "bun:test";
import { RU_VALIDATION_MESSAGES, ValidationCodes, ValidationError, Validator } from "@/library/validation";

afterEach(() => {
  Validator.resetDefaultMessages();
});

function codesOf(result: { errors: readonly ValidationError[] }): string[] {
  return result.errors.map((error) => error.code ?? "");
}

describe("string rules", () => {
  class StringDto {
    @Validator({ required: true, minLength: 3, maxLength: 5 })
    name!: string;

    @Validator({ notEmpty: true })
    title?: string;

    @Validator({ length: [2, 4] })
    tag?: string;

    @Validator({ contains: "@corp", notContains: "spam" })
    login?: string;

    @Validator({ pattern: /^[a-z]+$/ })
    slug?: string;

    @Validator({ pattern: "^\\d{4}$" })
    pin?: string;
  }

  test("a valid object", () => {
    const dto = new StringDto();
    dto.name = "abcd";
    dto.title = "x";
    dto.tag = "abc";
    dto.login = "me@corp";
    dto.slug = "abc";
    dto.pin = "1234";
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("required: undefined and null", () => {
    const dto = new StringDto();
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.required]);
    dto.name = null as unknown as string;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.required]);
  });

  test("optional fields are skipped when missing", () => {
    const dto = new StringDto();
    dto.name = "abc";
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("minLength / maxLength / length / notEmpty", () => {
    const dto = new StringDto();
    dto.name = "ab";
    dto.title = "";
    dto.tag = "abcde";
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual([ValidationCodes.length, ValidationCodes.minLength, ValidationCodes.notEmpty].sort());
    dto.name = "abcdef";
    expect(codesOf(Validator.validate(dto))).toContain(ValidationCodes.maxLength);
  });

  test("contains / notContains", () => {
    const dto = new StringDto();
    dto.name = "abc";
    dto.login = "spam-me";
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual([ValidationCodes.contains, ValidationCodes.notContains].sort());
  });

  test("pattern: RegExp and a source string", () => {
    const dto = new StringDto();
    dto.name = "abc";
    dto.slug = "ABC";
    dto.pin = "12";
    const result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.pattern, ValidationCodes.pattern]);
  });

  test("a string rule on a non-string -> type error", () => {
    const dto = new StringDto();
    dto.name = 42 as unknown as string;
    const result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.type]);
    expect(result.errors[0]!.message).toContain("string");
  });
});

describe("email, url, uuid, json, phone, date", () => {
  class FormatsDto {
    @Validator({ email: true })
    email?: string;

    @Validator({ url: true })
    site?: string;

    @Validator({ uuid: true })
    id?: string;

    @Validator({ json: true })
    payload?: string;

    @Validator({ phone: true })
    phone?: string;

    @Validator({ type: "date" })
    bornAt?: Date | string;
  }

  test("valid formats", () => {
    const dto = new FormatsDto();
    dto.email = "user@example.com";
    dto.site = "https://bun.sh/docs";
    dto.id = crypto.randomUUID();
    dto.payload = '{"a":1}';
    dto.phone = "+7 (912) 345-67-89";
    dto.bornAt = new Date("2000-01-02");
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("invalid formats", () => {
    const dto = new FormatsDto();
    dto.email = "not-an-email";
    dto.site = "::not a url::";
    dto.id = "not-a-uuid";
    dto.payload = "{broken";
    dto.phone = "12-34";
    dto.bornAt = "not a date";
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual(
      [ValidationCodes.email, ValidationCodes.url, ValidationCodes.uuid, ValidationCodes.json, ValidationCodes.phone, ValidationCodes.date].sort(),
    );
  });

  test("uuid: versions 4 and 7, upper case, nil; broken variants are errors", () => {
    const dto = new FormatsDto();
    for (const valid of [
      crypto.randomUUID(),                            // v4
      Bun.randomUUIDv7(),                             // v7
      "550E8400-E29B-41D4-A716-446655440000",         // upper case
      "00000000-0000-0000-0000-000000000000",         // nil
    ]) {
      dto.id = valid;
      expect(Validator.validate(dto).isValid).toBe(true);
    }
    for (const invalid of [
      "550e8400e29b41d4a716446655440000",             // no hyphens
      "550e8400-e29b-91d4-a716-446655440000",         // version 9
      "550e8400-e29b-41d4-c716-446655440000",         // wrong variant
      "550e8400-e29b-41d4-a716-44665544000",          // one character short
    ]) {
      dto.id = invalid;
      expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.uuid]);
    }
  });

  test("date accepts a Date, a string and a timestamp; Invalid Date is an error", () => {
    const dto = new FormatsDto();
    dto.bornAt = new Date("invalid");
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.date]);
    dto.bornAt = 1700000000000 as unknown as string;
    expect(Validator.validate(dto).isValid).toBe(true);
  });
});

describe("number rules", () => {
  class NumberDto {
    @Validator({ required: true, min: 18, max: 100 })
    age!: number;

    @Validator({ range: [0, 10] })
    rating?: number;

    @Validator({ positive: true, integer: true })
    count?: number;

    @Validator({ negative: true })
    debt?: number;
  }

  test("valid values", () => {
    const dto = new NumberDto();
    dto.age = 30;
    dto.rating = 10;
    dto.count = 5;
    dto.debt = -1;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("min / max / range / positive / negative / integer", () => {
    const dto = new NumberDto();
    dto.age = 17;
    dto.rating = 11;
    dto.count = -1.5;
    dto.debt = 0;
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual(
      [ValidationCodes.min, ValidationCodes.range, ValidationCodes.positive, ValidationCodes.integer, ValidationCodes.negative].sort(),
    );
  });

  test("NaN and a non-number -> type error", () => {
    const dto = new NumberDto();
    dto.age = Number.NaN;
    let result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.type]);
    expect(result.errors[0]!.message).toContain("NaN");

    dto.age = "30" as unknown as number;
    result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.type]);
  });
});

describe("boolean and enum", () => {
  enum Role {
    Admin = "admin",
    User = "user",
  }

  enum Level {
    Low,
    High,
  }

  class FlagsDto {
    @Validator({ required: true, mustBeTrue: true })
    accepted!: boolean;

    @Validator({ mustBeFalse: true })
    banned?: boolean;

    @Validator({ enumType: Role })
    role?: string;

    @Validator({ enumType: Level })
    level?: number;
  }

  test("valid values", () => {
    const dto = new FlagsDto();
    dto.accepted = true;
    dto.banned = false;
    dto.role = Role.User;
    dto.level = Level.High;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("mustBeTrue / mustBeFalse", () => {
    const dto = new FlagsDto();
    dto.accepted = false;
    dto.banned = true;
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual([ValidationCodes.mustBeTrue, ValidationCodes.mustBeFalse].sort());
  });

  test("string enum: a foreign value", () => {
    const dto = new FlagsDto();
    dto.accepted = true;
    dto.role = "root";
    const result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.enum]);
    expect(result.errors[0]!.message).toContain("admin, user");
  });

  test("numeric enum: reverse keys are not values", () => {
    const dto = new FlagsDto();
    dto.accepted = true;
    dto.level = 99;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.enum]);
    // The enum member name ("Low") is not an allowed value; only 0 and 1 are.
    dto.level = "Low" as unknown as number;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.enum]);
  });
});

describe("custom and validateIf: complex conditions", () => {
  class SignupDto {
    @Validator({ required: true, min: 18 })
    @Validator({
      custom: (value, instance) => {
        const dto = instance as SignupDto;
        if ((value as number) < 21 && dto.guardianConsent !== true) {
          return "Registration under 21 requires guardian consent";
        }
        return true;
      },
    })
    age!: number;

    @Validator({ validateIf: (instance) => (instance as SignupDto).age < 21, required: true })
    guardianConsent?: boolean;
  }

  test("cross-field check: consent is required under 21", () => {
    const dto = new SignupDto();
    dto.age = 19;
    const result = Validator.validate(dto);
    expect(result.hasErrorsFor("age")).toBe(true);
    expect(result.getErrorsFor("age")[0]!.message).toContain("guardian consent");
    expect(result.hasErrorsFor("guardianConsent")).toBe(true);

    dto.guardianConsent = true;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("validateIf=false turns off the other rules of the decorator", () => {
    const dto = new SignupDto();
    dto.age = 30;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("custom: false -> the standard message, ValidationError -> as is", () => {
    class Dto {
      @Validator({ custom: () => false })
      a = 1;

      @Validator({ custom: (value) => new ValidationError("b", value, "own error", "myCode") })
      b = 2;
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.custom);
    expect(result.getErrorsFor("b")[0]!.code).toBe("myCode");
    expect(result.getErrorsFor("b")[0]!.message).toBe("own error");
  });

  test("an exception in custom is caught and validation continues", () => {
    class Dto {
      @Validator({
        custom: () => {
          throw new Error("boom");
        },
      })
      a = 1;

      @Validator({ required: true })
      b?: string;
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.customError);
    expect(result.getErrorsFor("a")[0]!.message).toContain("boom");
    expect(result.hasErrorsFor("b")).toBe(true);
  });

  test("an exception in validateIf is caught", () => {
    class Dto {
      @Validator({
        validateIf: () => {
          throw new Error("guard failed");
        },
        required: true,
      })
      a?: string;
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.customError);
  });

  test("several decorators on one field all run", () => {
    class Dto {
      @Validator({ minLength: 5 })
      @Validator({ contains: "x" })
      value = "ab";
    }
    const result = Validator.validate(new Dto());
    expect(codesOf(result).sort()).toEqual([ValidationCodes.contains, ValidationCodes.minLength].sort());
  });
});

describe("asynchronous validation", () => {
  class AsyncDto {
    @Validator({
      custom: async (value) => {
        await Bun.sleep(1);
        return value === "taken" ? "The name is taken" : true;
      },
    })
    username = "taken";

    @Validator({ required: true })
    email?: string;
  }

  test("validateAsync awaits async custom functions", async () => {
    const result = await Validator.validateAsync(new AsyncDto());
    expect(result.getErrorsFor("username")[0]!.message).toBe("The name is taken");
    expect(result.hasErrorsFor("email")).toBe(true);
  });

  test("an async custom in the synchronous validate -> usage error", () => {
    const result = Validator.validate(new AsyncDto());
    expect(result.getErrorsFor("username")[0]!.code).toBe(ValidationCodes.asyncCustomInSyncCall);
  });

  test("a reject in an async custom -> customError", async () => {
    class Dto {
      @Validator({ custom: async () => Promise.reject(new Error("db down")) })
      a = 1;
    }
    const result = await Validator.validateAsync(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.customError);
    expect(result.getErrorsFor("a")[0]!.message).toContain("db down");
  });
});

describe("nested validation", () => {
  class AddressDto {
    @Validator({ required: true, notEmpty: true })
    city!: string;

    @Validator({ pattern: /^\d{6}$/ })
    zip?: string;
  }

  class ProfileDto {
    @Validator({ nested: true, required: true })
    address!: AddressDto;
  }

  test("explicit nested: errors with a dotted path", () => {
    const profile = new ProfileDto();
    profile.address = new AddressDto();
    profile.address.zip = "12";
    const result = Validator.validate(profile);
    expect(result.hasErrorsFor("address.city")).toBe(true);
    expect(result.hasErrorsFor("address.zip")).toBe(true);
    expect(result.getErrorsFor("address.city")[0]!.code).toBe(ValidationCodes.required);
  });

  test("nested is auto-detected from decorators on the value class", () => {
    class AutoDto {
      @Validator({ required: true })
      address!: AddressDto;
    }
    const dto = new AutoDto();
    dto.address = new AddressDto();
    const result = Validator.validate(dto);
    expect(result.hasErrorsFor("address.city")).toBe(true);
  });

  test("nested: false turns off auto-detection", () => {
    class OptOutDto {
      @Validator({ required: true, nested: false })
      address!: AddressDto;
    }
    const dto = new OptOutDto();
    dto.address = new AddressDto();
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("arrays: element checks with indexes in the path", () => {
    class OrderDto {
      @Validator({ nested: true })
      addresses: AddressDto[] = [];
    }
    const order = new OrderDto();
    const valid = new AddressDto();
    valid.city = "Moscow";
    order.addresses = [valid, new AddressDto()];
    const result = Validator.validate(order);
    expect(result.hasErrorsFor("addresses[0].city")).toBe(false);
    expect(result.hasErrorsFor("addresses[1].city")).toBe(true);
  });

  test("circular references do not loop the validation", () => {
    class NodeDto {
      @Validator({ required: true, notEmpty: true })
      name!: string;

      @Validator({ nested: true })
      next?: NodeDto;
    }
    const a = new NodeDto();
    const b = new NodeDto();
    a.name = "a";
    a.next = b;
    b.next = a; // a cycle; b.name is missing
    const result = Validator.validate(a);
    expect(result.hasErrorsFor("next.name")).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  test("several decorators on a field do not duplicate nested errors", () => {
    class TwiceDto {
      @Validator({ required: true })
      @Validator({ nested: true })
      address!: AddressDto;
    }
    const dto = new TwiceDto();
    dto.address = new AddressDto();
    const result = Validator.validate(dto);
    expect(result.getErrorsFor("address.city")).toHaveLength(1);
  });

  test("async custom checks inside nested objects", async () => {
    class InnerDto {
      @Validator({ custom: async () => "async inner fail" })
      flag = true;
    }
    class OuterDto {
      @Validator({ nested: true })
      inner = new InnerDto();
    }
    const result = await Validator.validateAsync(new OuterDto());
    expect(result.getErrorsFor("inner.flag")[0]!.message).toBe("async inner fail");
  });
});

describe("messages and customization", () => {
  test("a local message wins over the global and built-in ones", () => {
    Validator.setDefaultMessages({ minLength: "global: at least {min}" });
    class Dto {
      @Validator({ minLength: 5, message: "local: {property} is shorter than {min}" })
      a = "ab";

      @Validator({ minLength: 5 })
      b = "ab";
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.message).toBe("local: a is shorter than 5");
    expect(result.getErrorsFor("b")[0]!.message).toBe("global: at least 5");
  });

  test("built-in messages with {property} and {value} placeholders", () => {
    class Dto {
      @Validator({ required: true })
      username?: string;
    }
    const result = Validator.validate(new Dto());
    expect(result.errors[0]!.message).toBe('Field "username" is required');
  });

  test("RU_VALIDATION_MESSAGES switches every built-in code to Russian", () => {
    class Dto {
      @Validator({ required: true })
      username?: string;
    }
    try {
      Validator.setDefaultMessages(RU_VALIDATION_MESSAGES);
      expect(Validator.validate(new Dto()).errors[0]!.message).toBe('Поле "username" обязательно для заполнения');
    } finally {
      Validator.resetDefaultMessages();
    }
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe('Field "username" is required');
  });

  test("reset restores the built-in messages", () => {
    Validator.setDefaultMessages({ required: "REQUIRED!" });
    class Dto {
      @Validator({ required: true })
      a?: string;
    }
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe("REQUIRED!");
    Validator.resetDefaultMessages();
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe('Field "a" is required');
  });

  test("unknown placeholders stay as is", () => {
    class Dto {
      @Validator({ required: true, message: "{property} {nope}" })
      a?: string;
    }
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe("a {nope}");
  });
});

describe("ValidationResult and resilience", () => {
  test("getErrorsFor / hasErrorsFor / isValid", () => {
    class Dto {
      @Validator({ required: true })
      a?: string;

      @Validator({ min: 10 })
      b = 5;
    }
    const result = Validator.validate(new Dto());
    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.hasErrorsFor("a")).toBe(true);
    expect(result.getErrorsFor("b")).toHaveLength(1);
    expect(result.getErrorsFor("missing")).toHaveLength(0);
    expect(result.hasErrorsFor("missing")).toBe(false);
  });

  test("an object without decorators is valid", () => {
    expect(Validator.validate({ anything: 1 }).isValid).toBe(true);
    expect(Validator.validate(Object.create(null) as object).isValid).toBe(true);
  });

  test("inheritance: parent rules work in a subclass", () => {
    class BaseDto {
      @Validator({ required: true })
      id?: string;
    }
    class ChildDto extends BaseDto {
      @Validator({ min: 0 })
      extra = -1;
    }
    const result = Validator.validate(new ChildDto());
    expect(result.hasErrorsFor("id")).toBe(true);
    expect(result.hasErrorsFor("extra")).toBe(true);
    // The subclass rules did not leak into the parent.
    const baseResult = Validator.validate(new BaseDto());
    expect(baseResult.errors).toHaveLength(1);
  });

  test("the type hint without other rules", () => {
    class Dto {
      @Validator({ type: "string" })
      a: unknown = 42;

      @Validator({ type: "number" })
      b: unknown = "x";

      @Validator({ type: "boolean" })
      c: unknown = "no";

      @Validator({ type: "any" })
      d: unknown = Symbol("ok");
    }
    const result = Validator.validate(new Dto());
    expect(codesOf(result)).toEqual([ValidationCodes.type, ValidationCodes.type, ValidationCodes.type]);
  });
});
