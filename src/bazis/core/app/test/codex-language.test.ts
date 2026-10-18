import { afterEach, expect, test } from "bun:test";
import { Module } from "../../di";
import { CodexError } from "../../infra";
import { composeApp } from "../runApp";

@Module({ exports: [] })
class App {}

afterEach(() => {
  CodexError.useMessages({});
  composeApp(App);
});

test("runApp({ language }) switches the CodexError texts; own texts stay on top", () => {
  composeApp(App, { language: "ru" });
  expect(new CodexError("TIMEOUT").message).toBe("Время ожидания Codex App Server истекло.");

  CodexError.useMessages({ BUSY: "Подождите" });
  expect(new CodexError("BUSY").message).toBe("Подождите");
  expect(new CodexError("TIMEOUT").message).toBe("Время ожидания Codex App Server истекло.");

  // Own texts set before the application starts are kept too.
  composeApp(App, { language: "en" });
  expect(new CodexError("BUSY").message).toBe("Подождите");
  expect(new CodexError("TIMEOUT").message).toBe("Codex App Server timed out.");
});
