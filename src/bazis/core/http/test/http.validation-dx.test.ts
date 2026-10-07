import { afterEach, expect, test } from "bun:test";
import { MessageRegistry, RU_VALIDATION_MESSAGES, Validator, modelValidatorAdapter } from "../../../library/validation";
import { bindArguments } from "../Binding/ParameterBinder";
import { registerRequestModelShape } from "../Binding/requestModelRegistry";
import { ModelValidationError } from "../Errors/HttpError";
import { HttpContext } from "../HttpContext/HttpContext";

// HTTP request models: async custom rules run, a JSON type error does not hide
// the other fields' errors, and every text follows MessageRegistry.
afterEach(() => MessageRegistry.reset());

class Address {
  @Validator({ required: true, minLength: 2 }) city = "";
}
class SignUp {
  @Validator({ required: true, email: true }) email = "";
  @Validator({ required: true, min: 18 }) age = 0;
  @Validator({ custom: async (value) => value !== "taken" || "{property} is taken" }) nickname?: string;
  @Validator({ required: true }) address?: Address;
}
registerRequestModelShape(SignUp, { email: { primitive: "string" }, age: { primitive: "number" }, nickname: { primitive: "string" }, address: { model: Address } });
registerRequestModelShape(Address, { city: { primitive: "string" } });

async function post(body: unknown): Promise<{ title?: string; errors?: readonly unknown[]; value?: SignUp }> {
  const request = new Request("http://localhost/sign-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ctx = new HttpContext(request, new URL(request.url), {}, {} as never, undefined, undefined, "127.0.0.1", modelValidatorAdapter);
  try {
    const [value] = await bindArguments([{ source: "body", model: SignUp }], ctx, {});
    return { value: value as SignUp };
  } catch (error) {
    if (!(error instanceof ModelValidationError)) throw error;
    return { title: error.message, errors: error.errors };
  }
}

test("an async custom rule runs during HTTP binding", async () => {
  expect((await post({ email: "a@b.co", age: 20, nickname: "free", address: { city: "Kazan" } })).value?.nickname).toBe("free");
  expect((await post({ email: "a@b.co", age: 20, nickname: "taken", address: { city: "Kazan" } })).errors)
    .toEqual([{ property: "nickname", message: "nickname is taken", code: "custom" }]);
});

test("a JSON type error is reported together with the other fields' rule errors", async () => {
  const result = await post({ email: "bad", age: "20", address: { city: "K" } });
  expect(result.title).toBe("Validation failed");
  expect(result.errors).toEqual([
    { property: "age", message: 'Field "age" must be of type number, got: string', code: "type" },
    { property: "email", message: 'Field "email" must be a valid email address', code: "email" },
    { property: "address.city", message: 'Field "address.city" must be at least 2 characters long', code: "minLength" },
  ]);
});

test("the Russian set translates type errors and the response title", async () => {
  MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES);
  const result = await post({ email: "a@b.co", age: "20", address: { city: "Kazan" } });
  expect(result.title).toBe("Проверка данных не пройдена");
  expect(result.errors).toEqual([{ property: "age", message: 'Поле "age" должно иметь тип number, получено: string', code: "type" }]);
});

test("an unknown error code falls back to the current language", () => {
  expect(MessageRegistry.format("someCustomCode", undefined, { property: "x", code: "someCustomCode" })).toBe('Field "x" is invalid (someCustomCode)');
  MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES);
  expect(MessageRegistry.format("someCustomCode", undefined, { property: "x", code: "someCustomCode" })).toBe('Поле "x" не прошло проверку (someCustomCode)');
});
