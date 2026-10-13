import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { count, detectTerminal, messages, padEnd, parseLanguage, plain, projectLanguage, resolveLanguage, Screen, widthOf, PLAIN } from "../index";

function capture(language: "en" | "ru" = "en") {
  let text = "";
  const screen = new Screen({ write: (chunk: string) => { text += chunk; } }, { language, style: PLAIN });
  return { screen, text: () => text };
}

describe("output language", () => {
  test("the flag wins over BAZIS_LANG, the project and the system locale", () => {
    expect(resolveLanguage({ flag: "ru", env: "en", project: "en", system: "en_US.UTF-8" })).toBe("ru");
    expect(resolveLanguage({ env: "ru", project: "en", system: "en_US.UTF-8" })).toBe("ru");
    expect(resolveLanguage({ project: "ru", system: "en_US.UTF-8" })).toBe("ru");
    expect(resolveLanguage({ system: "ru_RU.UTF-8" })).toBe("ru");
    expect(resolveLanguage({})).toBe("en");
  });

  test("an unknown value is skipped instead of failing the command", () => {
    expect(resolveLanguage({ flag: "de", env: "ru" })).toBe("ru");
    expect(parseLanguage("C")).toBeUndefined();
    expect(parseLanguage("ru-RU")).toBe("ru");
  });

  test("the project language comes from the nearest bazis.config.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bazis-lang-"));
    try {
      await writeFile(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, language: "ru" }));
      const nested = path.join(root, "src", "app");
      await Bun.write(path.join(nested, "x.ts"), "");
      expect(projectLanguage(nested)).toBe("ru");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("terminal style", () => {
  test("colour follows the terminal, NO_COLOR and FORCE_COLOR", () => {
    expect(detectTerminal({ isTTY: true }, {}).color).toBe(true);
    expect(detectTerminal({ isTTY: true }, { NO_COLOR: "1" }).color).toBe(false);
    expect(detectTerminal({ isTTY: false }, { FORCE_COLOR: "1" }).color).toBe(true);
    expect(detectTerminal({ isTTY: true }, { CI: "true" }).animate).toBe(false);
    expect(detectTerminal({ isTTY: false }, {}).color).toBe(false);
  });

  test("widths ignore colour escapes and links", () => {
    const coloured = "\x1b[38;2;1;2;3mabc\x1b[39m";
    expect(widthOf(coloured)).toBe(3);
    expect(plain(padEnd(coloured, 5))).toBe("abc  ");
    expect(widthOf("\x1b]8;;http://x\x1b\\http://x\x1b]8;;\x1b\\")).toBe(8);
  });

  test("Russian plurals agree with the number", () => {
    const ru = messages("ru");
    expect(count(ru, 1, "file")).toBe("1 файл");
    expect(count(ru, 3, "file")).toBe("3 файла");
    expect(count(ru, 11, "file")).toBe("11 файлов");
    expect(count(ru, 21, "route")).toBe("21 маршрут");
    expect(count(messages("en"), 2, "problem")).toBe("2 problems");
  });
});

describe("screen", () => {
  test("banners say success and failure in words, in both languages", () => {
    const en = capture("en");
    en.screen.banner("success", "app is running");
    en.screen.banner("failed", "configuration is invalid");
    expect(en.text()).toContain("SUCCESS   app is running");
    expect(en.text()).toContain("FAILED   configuration is invalid");
    const ru = capture("ru");
    ru.screen.banner("success", "приложение работает");
    ru.screen.banner("failed", "конфигурация с ошибками");
    expect(ru.text()).toContain("УСПЕХ");
    expect(ru.text()).toContain("ПРОВАЛ");
  });

  test("without colour a badge is a bracketed word and a step keeps its columns", () => {
    const { screen, text } = capture();
    screen.step("ok", "codegen", "29 files", "0.9 s");
    screen.step("skip", "connections", "not checked");
    expect(text()).toContain("[OK  ]  codegen         29 files");
    expect(text()).toContain("[SKIP]  connections     not checked");
    expect(text()).not.toContain("\x1b[");
  });

  test("a problem box shows the cause, the code frame with a marker and the fixes", () => {
    const { screen, text } = capture();
    screen.problem(1, 2, {
      tag: "DI",
      where: "src/a.ts:6",
      cause: "unknown dependency",
      frame: { lines: [[5, "  constructor("], [6, "    private readonly sql: SQL,"]], line: 6, column: 27, length: 3 },
      fixes: ["inject IPostgres"],
      declaredIn: "src/a.ts:1",
      code: "BAZIS_DI_DEPENDENCY_UNKNOWN",
    });
    const output = text();
    expect(output).toContain("1/2 [DI] src/a.ts:6");
    expect(output).toContain("✖  unknown dependency");
    expect(output).toContain("  6 │     private readonly sql: SQL,");
    expect(output).toContain("^^^");
    expect(output).toContain("➜  inject IPostgres");
    expect(output).toContain("declared in src/a.ts:1");
    expect(output).toContain("code BAZIS_DI_DEPENDENCY_UNKNOWN");
  });

  test("a spinner draws only on an interactive terminal", () => {
    const { screen, text } = capture();
    screen.progress("codegen")();
    expect(text()).toBe("");
  });
});
