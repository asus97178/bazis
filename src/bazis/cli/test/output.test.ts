import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLAIN, Screen } from "../../library/terminal";
import { typeProblems } from "../build";
import { codegenProblem, renderCodegen } from "../codegen";
import { createScreens, lineOutput } from "../ui";
import { extractLanguage, runCli } from "../main";
import { parseModuleName } from "../naming";
import { generateProject } from "../generateProject";

const screen = new Screen({ write: () => undefined }, { language: "en", style: PLAIN });

describe("CLI output", () => {
  test("--lang is taken from anywhere before test arguments", () => {
    expect(extractLanguage(["--lang", "ru", "codegen"])).toEqual({ argv: ["codegen"], lang: "ru" });
    expect(extractLanguage(["g", "module", "Task", "--lang=en"])).toEqual({ argv: ["g", "module", "Task"], lang: "en" });
    expect(extractLanguage(["test", "--lang", "ru"])).toEqual({ argv: ["test", "--lang", "ru"] });
  });

  test("an unknown DI dependency points at the parameter and suggests the injectable type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bazis-cli-output-"));
    try {
      await Bun.write(path.join(root, "src/Stats.service.ts"), 'import type { SQL } from "bun";\n\nexport class StatsService {\n  constructor(\n    private readonly sql: SQL,\n  ) {}\n}\n');
      const problem = codegenProblem('BAZIS_DI_DEPENDENCY_UNKNOWN: src/Stats.service.ts:3: constructor parameter 1 of "StatsService" has type "SQL", which is neither a DI token', root, screen);
      expect(problem.tag).toBe("DI");
      expect(problem.where).toBe("src/Stats.service.ts:5");
      expect(problem.frame).toMatchObject({ line: 5, column: 27, length: 3 });
      expect(problem.fixes).toEqual(["inject IPostgres from bazis/core/infra instead of Bun's SQL"]);
      expect(problem.code).toBe("BAZIS_DI_DEPENDENCY_UNKNOWN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the codegen step lists only what the project has", () => {
    const lines: string[] = [];
    const ui = createScreens(lineOutput((line) => lines.push(line)), lineOutput((line) => lines.push(line)), "en");
    renderCodegen(ui, { ok: true, ms: 400, targets: [{ name: "production", sources: 2, deps: 0, controllers: 1, requestModels: 0, listModels: 0, tools: 0, ms: 1 }], outputs: [], warnings: [], errors: [] }, process.cwd());
    const step = lines.find((line) => line.includes("codegen")) ?? "";
    expect(step).toContain("2 files · 1 controller");
    expect(step).not.toContain(" 0 ");
  });

  test("tsc errors become problems with their position and continuation lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bazis-cli-output-"));
    try {
      await writeFile(path.join(root, "a.ts"), "const x: number = 'y';\n");
      const problems = typeProblems("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  more detail\n", root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ tag: "TYPE", where: "a.ts:1:7", code: "TS2322" });
      expect(problems[0]?.cause).toBe("Type 'string' is not assignable to type 'number'.\nmore detail");
      expect(problems[0]?.frame?.line).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a module name must start with a letter, and the error says so", () => {
    expect(() => parseModuleName("1Task")).toThrow('Invalid module name "1Task": it must start with a letter');
  });

  test("a command error is a failure screen with the message and the help hint", async () => {
    const lines: string[] = [];
    const code = await runCli(["g", "module", "1Task"], { log: (line) => lines.push(line), error: (line) => lines.push(line), language: "en", codegen: async () => 0 });
    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("FAILED   command failed");
    expect(output).toContain("it must start with a letter");
    expect(output).toContain("Use bazis --help");
  });

  test("a new project records its language and checks /health on a port from the operating system", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bazis-cli-output-"));
    try {
      const result = await generateProject({ name: "Demo", outputPath: path.join(root, "demo") });
      const config = await Bun.file(path.join(result.projectDir, "bazis.config.json")).json() as { language?: string };
      expect(["en", "ru"]).toContain(config.language!);
      const health = await Bun.file(path.join(result.projectDir, "src/app/test/health.test.ts")).text();
      expect(health).toContain("port: 0");
      expect(health).not.toContain("Math.random");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
