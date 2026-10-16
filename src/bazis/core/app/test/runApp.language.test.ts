import { afterEach, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp, type TestAppOptions } from "@/core/testing";
import { MessageRegistry, Validator } from "@/library/validation";
import { BooksModule } from "./fixtures/languageControllers";

// The controller is a target-local codegen fixture (bazis.config.json, target
// "test"); its generated bindings are registered before the app starts.
import "../../../../generated/bazis/targets/test/bootstrap";

// 0.100.7: `runApp({ language, messages })` translates every text the framework
// writes into a response. On 0.100.6 only validation rules followed the global
// MessageRegistry; "Not Found", "Unauthorized", a missing parameter, malformed
// JSON and the 404/405 written before routing stayed English.

afterEach(() => MessageRegistry.reset());

async function withApp(options: TestAppOptions, run: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await startTestApp(BooksModule, options);
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}

async function body(app: TestApp, path: string, init?: RequestInit): Promise<{ status: number; json: { error: string; details?: unknown } }> {
  const response = await app.fetch(path, init);
  return { status: response.status, json: (await response.json()) as { error: string; details?: unknown } };
}

const post = (payload: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: payload });

describe("language: ru", () => {
  test("framework texts of every stage are Russian; the app's own texts stay", async () => {
    await withApp({ language: "ru" }, async (app) => {
      expect(await body(app, "/nope")).toEqual({ status: 404, json: { error: "Не найдено" } });
      expect(await body(app, "/books", { method: "DELETE" })).toEqual({ status: 405, json: { error: "Метод не поддерживается" } });
      expect(await body(app, "/books")).toEqual({ status: 400, json: { error: 'Не передан обязательный параметр "q"' } });
      expect(await body(app, "/books?q=a&limit=x")).toEqual({ status: 400, json: { error: 'Параметр "limit": ожидается число, получено: "x"' } });
      expect(await body(app, "/books/3")).toEqual({ status: 404, json: { error: "Не найдено" } });
      expect(await body(app, "/books/2")).toEqual({ status: 404, json: { error: "Книга 2 не найдена" } });
      expect(await body(app, "/books/admin")).toEqual({ status: 403, json: { error: "Доступ запрещён" } });
      expect(await body(app, "/books/me")).toEqual({ status: 401, json: { error: "Требуется аутентификация" } });
      expect(await body(app, "/books", post("{"))).toEqual({ status: 400, json: { error: "Тело запроса — некорректный JSON" } });
      expect(await body(app, "/books", post("[]"))).toEqual({ status: 400, json: { error: "Тело запроса должно быть JSON-объектом" } });
    });
  });

  test("validation: title, rule texts without plural forms, type names and a rule's own message", async () => {
    await withApp({ language: "ru" }, async (app) => {
      expect(await body(app, "/books", post('{"title":"a","year":"x"}'))).toEqual({
        status: 400,
        json: {
          error: "Проверка данных не пройдена",
          details: [
            { property: "year", message: 'Поле "year": ожидается число, получено: строка', code: "type" },
            { property: "title", message: 'Поле "title": минимальная длина — 2', code: "minLength" },
            { property: "author", message: "Укажите автора", code: "required" },
          ],
        },
      });
    });
  });

  test("an unexpected error mapped to a status gets the Russian reason phrase", async () => {
    await withApp({ language: "ru", http: { errorHandler: { status: () => 409 } } }, async (app) => {
      expect((await body(app, "/books/boom")).json.error).toBe("Конфликт");
    });
  });
});

test("messages replace single texts on top of the language", async () => {
  await withApp({ language: "ru", messages: { notFound: "Нет такой страницы", required: "Заполните {property}" } }, async (app) => {
    expect((await body(app, "/nope")).json.error).toBe("Нет такой страницы");
    const details = (await body(app, "/books", post('{"title":"ok","author":"x"}'))).json.details;
    expect(details).toEqual([{ property: "year", message: "Заполните year", code: "required" }]);
  });
});

test("Validator.setDefaultMessages still wins over the language catalog", async () => {
  Validator.setDefaultMessages({ required: "{property}: обязательно" });
  await withApp({ language: "ru" }, async (app) => {
    const details = (await body(app, "/books", post('{"title":"ok","author":"x"}'))).json.details;
    expect(details).toEqual([{ property: "year", message: "year: обязательно", code: "required" }]);
  });
});

test("without language the texts are English, as before", async () => {
  await withApp({}, async (app) => {
    expect(await body(app, "/nope")).toEqual({ status: 404, json: { error: "Not Found" } });
    expect(await body(app, "/books")).toEqual({ status: 400, json: { error: 'Missing required query parameter "q"' } });
    expect(await body(app, "/books?q=a&limit=x")).toEqual({ status: 400, json: { error: 'Parameter "limit" must be of type number, got: "x"' } });
    expect(await body(app, "/books/admin")).toEqual({ status: 403, json: { error: "Forbidden" } });
    expect(await body(app, "/books", post('{"title":"a","year":"x"}'))).toEqual({
      status: 400,
      json: {
        error: "Validation failed",
        details: [
          { property: "year", message: 'Field "year" must be of type number, got: string', code: "type" },
          { property: "title", message: 'Field "title" must be at least 2 characters long', code: "minLength" },
          { property: "author", message: "Укажите автора", code: "required" },
        ],
      },
    });
  });
});

test("two apps in one process keep their own languages", async () => {
  await withApp({ language: "ru" }, async (ru) => {
    await withApp({}, async (en) => {
      expect((await body(ru, "/nope")).json.error).toBe("Не найдено");
      expect((await body(en, "/nope")).json.error).toBe("Not Found");
      expect((await body(ru, "/books", post("{}"))).json.error).toBe("Проверка данных не пройдена");
      expect((await body(en, "/books", post("{}"))).json.error).toBe("Validation failed");
    });
  });
});

test("an unknown language stops the start and names the supported ones", async () => {
  await expect(startTestApp(BooksModule, { language: "de" as never })).rejects.toThrow('runApp: language "de" is not supported. Use one of: en, ru.');
});
