import { afterAll, beforeAll, expect, test } from "bun:test";
import { Module } from "../../di";
import { Authorize, Controller, ForbiddenError, Get, type AuthorizeCheck, type HttpContext } from "../../http";
import { startTestApp, type TestApp } from "../../testing";
import { createLanguages, negotiateLanguage } from "../messages";

test("Accept-Language picks the supported language with the highest q", () => {
  const supported = ["ru", "en"];
  expect(negotiateLanguage("ru-RU,ru;q=0.9,en;q=0.8", supported)).toBe("ru");
  expect(negotiateLanguage("en;q=0.5, ru;q=0.4", supported)).toBe("en");
  expect(negotiateLanguage("en-GB", supported)).toBe("en");
  expect(negotiateLanguage("fr, de;q=0.5", supported)).toBeUndefined();
  expect(negotiateLanguage("ru;q=0, en;q=0.1", supported)).toBe("en");
  expect(negotiateLanguage("*", supported)).toBeUndefined();
  expect(negotiateLanguage(undefined, supported)).toBeUndefined();
  expect(() => createLanguages({ default: "en", supported: ["ru"] })).toThrow('runApp: language.default "en" must be one of language.supported (ru).');
});

const seen: (string | undefined)[] = [];
const remember: AuthorizeCheck = (ctx) => { seen.push((ctx as HttpContext).language); return true; };

@Controller("books")
class BooksController {
  @Get("secret")
  @Authorize(remember)
  secret() { throw new ForbiddenError(); }
}
@Module({ controllers: [BooksController], exports: [] })
class App {}

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp(App, { language: { default: "ru", supported: ["ru", "en"] } });
});
afterAll(async () => {
  await app.stop();
});

const get = (path: string, language?: string) => app.fetch(path, language === undefined ? {} : { headers: { "accept-language": language } });

test("each request gets its language, with Content-Language and Vary", async () => {
  const english = await get("/nothing", "en-US,en;q=0.9");
  expect(await english.json()).toEqual({ error: "Not Found" });
  expect(english.headers.get("content-language")).toBe("en");
  expect(english.headers.get("vary")).toBe("Accept-Language");

  const russian = await get("/nothing");
  expect(russian.headers.get("content-language")).toBe("ru");
  expect(((await russian.json()) as { error: string }).error).not.toBe("Not Found");

  seen.length = 0;
  const forbidden = await get("/books/secret", "en");
  expect(await forbidden.json()).toEqual({ error: "Forbidden" });
  expect(forbidden.headers.get("content-language")).toBe("en");
  expect((await get("/books/secret", "fr")).headers.get("content-language")).toBe("ru");
  expect(seen).toEqual(["en", "ru"]);
});

test("one language adds no language headers", async () => {
  const single = await startTestApp(App, { language: "ru" });
  try {
    const response = await single.fetch("/nothing", { headers: { "accept-language": "en" } });
    expect(response.headers.get("content-language")).toBeNull();
    expect(((await response.json()) as { error: string }).error).not.toBe("Not Found");
  } finally {
    await single.stop();
  }
});
