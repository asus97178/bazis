import { afterEach, describe, expect, test } from "bun:test";
import { RU_VALIDATION_MESSAGES, ValidationCodes, ValidationError, Validator } from "@/library/validation";

afterEach(() => {
  Validator.resetDefaultMessages();
});

function codesOf(result: { errors: readonly ValidationError[] }): string[] {
  return result.errors.map((error) => error.code ?? "");
}

describe("строковые правила", () => {
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

  test("валидный объект", () => {
    const dto = new StringDto();
    dto.name = "abcd";
    dto.title = "x";
    dto.tag = "abc";
    dto.login = "me@corp";
    dto.slug = "abc";
    dto.pin = "1234";
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("required: undefined и null", () => {
    const dto = new StringDto();
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.required]);
    dto.name = null as unknown as string;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.required]);
  });

  test("опциональные поля пропускаются, если отсутствуют", () => {
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

  test("pattern: RegExp и строка-источник", () => {
    const dto = new StringDto();
    dto.name = "abc";
    dto.slug = "ABC";
    dto.pin = "12";
    const result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.pattern, ValidationCodes.pattern]);
  });

  test("строковое правило на не-строке -> ошибка типа", () => {
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

  test("валидные форматы", () => {
    const dto = new FormatsDto();
    dto.email = "user@example.com";
    dto.site = "https://bun.sh/docs";
    dto.id = crypto.randomUUID();
    dto.payload = '{"a":1}';
    dto.phone = "+7 (912) 345-67-89";
    dto.bornAt = new Date("2000-01-02");
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("невалидные форматы", () => {
    const dto = new FormatsDto();
    dto.email = "not-an-email";
    dto.site = "::not a url::";
    dto.id = "not-a-uuid";
    dto.payload = "{broken";
    dto.phone = "12-34";
    dto.bornAt = "не дата";
    const result = Validator.validate(dto);
    expect(codesOf(result).sort()).toEqual(
      [ValidationCodes.email, ValidationCodes.url, ValidationCodes.uuid, ValidationCodes.json, ValidationCodes.phone, ValidationCodes.date].sort(),
    );
  });

  test("uuid: версии 4 и 7, верхний регистр, nil; битые варианты — ошибка", () => {
    const dto = new FormatsDto();
    for (const valid of [
      crypto.randomUUID(),                            // v4
      Bun.randomUUIDv7(),                             // v7
      "550E8400-E29B-41D4-A716-446655440000",         // верхний регистр
      "00000000-0000-0000-0000-000000000000",         // nil
    ]) {
      dto.id = valid;
      expect(Validator.validate(dto).isValid).toBe(true);
    }
    for (const invalid of [
      "550e8400e29b41d4a716446655440000",             // без дефисов
      "550e8400-e29b-91d4-a716-446655440000",         // версия 9
      "550e8400-e29b-41d4-c716-446655440000",         // неверный вариант
      "550e8400-e29b-41d4-a716-44665544000",          // короче на символ
    ]) {
      dto.id = invalid;
      expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.uuid]);
    }
  });

  test("date принимает Date, строку и timestamp; Invalid Date — ошибка", () => {
    const dto = new FormatsDto();
    dto.bornAt = new Date("invalid");
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.date]);
    dto.bornAt = 1700000000000 as unknown as string;
    expect(Validator.validate(dto).isValid).toBe(true);
  });
});

describe("числовые правила", () => {
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

  test("валидные значения", () => {
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

  test("NaN и не-число -> ошибка типа", () => {
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

describe("boolean и enum", () => {
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

  test("валидные значения", () => {
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

  test("строковый enum: чужое значение", () => {
    const dto = new FlagsDto();
    dto.accepted = true;
    dto.role = "root";
    const result = Validator.validate(dto);
    expect(codesOf(result)).toEqual([ValidationCodes.enum]);
    expect(result.errors[0]!.message).toContain("admin, user");
  });

  test("числовой enum: обратные ключи не считаются значениями", () => {
    const dto = new FlagsDto();
    dto.accepted = true;
    dto.level = 99;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.enum]);
    // The enum member name ("Low") is not an allowed value; only 0 and 1 are.
    dto.level = "Low" as unknown as number;
    expect(codesOf(Validator.validate(dto))).toEqual([ValidationCodes.enum]);
  });
});

describe("custom и validateIf: сложные условия", () => {
  class SignupDto {
    @Validator({ required: true, min: 18 })
    @Validator({
      custom: (value, instance) => {
        const dto = instance as SignupDto;
        if ((value as number) < 21 && dto.guardianConsent !== true) {
          return "Для регистрации до 21 года необходимо согласие опекуна";
        }
        return true;
      },
    })
    age!: number;

    @Validator({ validateIf: (instance) => (instance as SignupDto).age < 21, required: true })
    guardianConsent?: boolean;
  }

  test("перекрёстная проверка полей: до 21 года нужно согласие", () => {
    const dto = new SignupDto();
    dto.age = 19;
    const result = Validator.validate(dto);
    expect(result.hasErrorsFor("age")).toBe(true);
    expect(result.getErrorsFor("age")[0]!.message).toContain("согласие опекуна");
    expect(result.hasErrorsFor("guardianConsent")).toBe(true);

    dto.guardianConsent = true;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("validateIf=false отключает остальные правила декоратора", () => {
    const dto = new SignupDto();
    dto.age = 30;
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("custom: false -> стандартное сообщение, ValidationError -> как есть", () => {
    class Dto {
      @Validator({ custom: () => false })
      a = 1;

      @Validator({ custom: (value) => new ValidationError("b", value, "своя ошибка", "myCode") })
      b = 2;
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.custom);
    expect(result.getErrorsFor("b")[0]!.code).toBe("myCode");
    expect(result.getErrorsFor("b")[0]!.message).toBe("своя ошибка");
  });

  test("исключение в custom перехватывается, валидация продолжается", () => {
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

  test("исключение в validateIf перехватывается", () => {
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

  test("несколько декораторов на одном поле — выполняются все", () => {
    class Dto {
      @Validator({ minLength: 5 })
      @Validator({ contains: "x" })
      value = "ab";
    }
    const result = Validator.validate(new Dto());
    expect(codesOf(result).sort()).toEqual([ValidationCodes.contains, ValidationCodes.minLength].sort());
  });
});

describe("асинхронная валидация", () => {
  class AsyncDto {
    @Validator({
      custom: async (value) => {
        await Bun.sleep(1);
        return value === "taken" ? "Имя уже занято" : true;
      },
    })
    username = "taken";

    @Validator({ required: true })
    email?: string;
  }

  test("validateAsync ждёт асинхронные custom-функции", async () => {
    const result = await Validator.validateAsync(new AsyncDto());
    expect(result.getErrorsFor("username")[0]!.message).toBe("Имя уже занято");
    expect(result.hasErrorsFor("email")).toBe(true);
  });

  test("асинхронный custom в синхронном validate -> ошибка использования", () => {
    const result = Validator.validate(new AsyncDto());
    expect(result.getErrorsFor("username")[0]!.code).toBe(ValidationCodes.asyncCustomInSyncCall);
  });

  test("reject в асинхронном custom -> customError", async () => {
    class Dto {
      @Validator({ custom: async () => Promise.reject(new Error("db down")) })
      a = 1;
    }
    const result = await Validator.validateAsync(new Dto());
    expect(result.getErrorsFor("a")[0]!.code).toBe(ValidationCodes.customError);
    expect(result.getErrorsFor("a")[0]!.message).toContain("db down");
  });
});

describe("вложенная валидация", () => {
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

  test("явный nested: ошибки с путём через точку", () => {
    const profile = new ProfileDto();
    profile.address = new AddressDto();
    profile.address.zip = "12";
    const result = Validator.validate(profile);
    expect(result.hasErrorsFor("address.city")).toBe(true);
    expect(result.hasErrorsFor("address.zip")).toBe(true);
    expect(result.getErrorsFor("address.city")[0]!.code).toBe(ValidationCodes.required);
  });

  test("автоопределение nested по декораторам на классе значения", () => {
    class AutoDto {
      @Validator({ required: true })
      address!: AddressDto;
    }
    const dto = new AutoDto();
    dto.address = new AddressDto();
    const result = Validator.validate(dto);
    expect(result.hasErrorsFor("address.city")).toBe(true);
  });

  test("nested: false отключает автоопределение", () => {
    class OptOutDto {
      @Validator({ required: true, nested: false })
      address!: AddressDto;
    }
    const dto = new OptOutDto();
    dto.address = new AddressDto();
    expect(Validator.validate(dto).isValid).toBe(true);
  });

  test("массивы: поэлементная проверка с индексами в пути", () => {
    class OrderDto {
      @Validator({ nested: true })
      addresses: AddressDto[] = [];
    }
    const order = new OrderDto();
    const valid = new AddressDto();
    valid.city = "Москва";
    order.addresses = [valid, new AddressDto()];
    const result = Validator.validate(order);
    expect(result.hasErrorsFor("addresses[0].city")).toBe(false);
    expect(result.hasErrorsFor("addresses[1].city")).toBe(true);
  });

  test("циклические ссылки не зацикливают валидацию", () => {
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

  test("несколько декораторов на поле не дублируют вложенные ошибки", () => {
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

  test("асинхронные custom внутри вложенных объектов", async () => {
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

describe("сообщения и кастомизация", () => {
  test("локальный message приоритетнее глобального и встроенного", () => {
    Validator.setDefaultMessages({ minLength: "глобально: минимум {min}" });
    class Dto {
      @Validator({ minLength: 5, message: "локально: {property} короче {min}" })
      a = "ab";

      @Validator({ minLength: 5 })
      b = "ab";
    }
    const result = Validator.validate(new Dto());
    expect(result.getErrorsFor("a")[0]!.message).toBe("локально: a короче 5");
    expect(result.getErrorsFor("b")[0]!.message).toBe("глобально: минимум 5");
  });

  test("встроенные сообщения с плейсхолдерами {property} и {value}", () => {
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

  test("reset возвращает встроенные сообщения", () => {
    Validator.setDefaultMessages({ required: "ОБЯЗАТЕЛЬНО!" });
    class Dto {
      @Validator({ required: true })
      a?: string;
    }
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe("ОБЯЗАТЕЛЬНО!");
    Validator.resetDefaultMessages();
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe('Field "a" is required');
  });

  test("неизвестные плейсхолдеры остаются как есть", () => {
    class Dto {
      @Validator({ required: true, message: "{property} {nope}" })
      a?: string;
    }
    expect(Validator.validate(new Dto()).errors[0]!.message).toBe("a {nope}");
  });
});

describe("ValidationResult и устойчивость", () => {
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

  test("объект без декораторов валиден", () => {
    expect(Validator.validate({ anything: 1 }).isValid).toBe(true);
    expect(Validator.validate(Object.create(null) as object).isValid).toBe(true);
  });

  test("наследование: правила родителя работают в потомке", () => {
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

  test("подсказка type без других правил", () => {
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
