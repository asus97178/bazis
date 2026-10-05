import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli, type CliRuntime } from "../main";
import { generateModule, generateModulePack } from "../generateModule";
import { resolveGenerator, runCodegen } from "../codegen";
import { parseModuleName } from "../naming";
import { devEnvironment } from "../build";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-cli-command-"));
  roots.push(root);
  const appModulePath = path.join(root, "host/App.module.ts");
  await mkdir(path.dirname(appModulePath), { recursive: true });
  await Bun.write(appModulePath, 'import { Module } from "@osnova/core/di";\n@Module({ imports: [], exports: [] })\nexport class AppModule {}\n');
  return { root, appModulePath, modulesRoot: path.join(root, "features") };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function runtime(exitCode = 0) {
  const calls: { cwd: string; target?: string }[] = [];
  const logs: string[] = [];
  const adapter: CliRuntime = {
    log: (message) => logs.push(message), error: (message) => logs.push(message),
    codegen: async (cwd, target) => { calls.push({ cwd, target }); return exitCode; },
  };
  return { adapter, calls, logs };
}

describe("CLI command effects", () => {
  test("g module Name --help does not create files or invoke codegen", async () => {
    const f = await fixture();
    const r = runtime();
    expect(await runCli(["g", "module", "Task", "--modules-root", f.modulesRoot, "--help"], r.adapter)).toBe(0);
    expect(await Bun.file(f.modulesRoot).exists()).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  test("dry-run plans the host edit and passport without touching either", async () => {
    const f = await fixture();
    const original = await readFile(f.appModulePath, "utf8");
    const r = runtime();
    expect(await runCli(["g", "module", "Task", "--modules-root", f.modulesRoot, "--app-module", f.appModulePath, "--dry-run"], r.adapter)).toBe(0);
    expect(await Bun.file(f.modulesRoot).exists()).toBe(false);
    expect(await readFile(f.appModulePath, "utf8")).toBe(original);
    expect(r.logs.join("\n")).toContain("MODULE.md");
    expect(r.logs.join("\n")).toContain("App.module.ts");
    expect(r.calls).toHaveLength(0);
  });

  test.each(["--no-codegen", "--no-register"])("respects %s", async (flag) => {
    const f = await fixture();
    const r = runtime();
    expect(await runCli(["g", "m", "Guest", "--modules-root", f.modulesRoot, "--app-module", f.appModulePath, flag], r.adapter)).toBe(0);
    expect(await Bun.file(path.join(f.modulesRoot, "guest/MODULE.md")).exists()).toBe(true);
    expect((await readFile(f.appModulePath, "utf8")).includes("GuestModule")).toBe(flag === "--no-codegen");
    expect(r.calls).toHaveLength(0);
  });

  test("does not run codegen when host was missing", async () => {
    const f = await fixture();
    const r = runtime();
    expect(await runCli(["g", "module", "Task", "--empty", "--modules-root", f.modulesRoot], r.adapter)).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.logs.join("\n")).toContain("App module not found");
  });

  test("forwards target and codegen failure, preserving the generated scaffold", async () => {
    const f = await fixture();
    const r = runtime(17);
    expect(await runCli(["g", "module", "Task", "--modules-root", f.modulesRoot, "--app-module", f.appModulePath, "--target", "test"], r.adapter)).toBe(17);
    expect(r.calls).toEqual([{ cwd: process.cwd(), target: "test" }]);
    expect(await Bun.file(path.join(f.modulesRoot, "task/Task.module.ts")).exists()).toBe(true);
    expect(r.logs.join("\n")).toContain("scaffold files were kept");
  });

  test("explicit codegen does not generate a feature", async () => {
    const r = runtime();
    expect(await runCli(["codegen", "--target", "all"], r.adapter)).toBe(0);
    expect(r.calls).toEqual([{ cwd: process.cwd(), target: "all" }]);
  });

  test("generates only entry and passport for an empty atomic module", async () => {
    const f = await fixture();
    const result = await generateModule({ ...f, name: "Mailer", profile: "empty", register: false });
    expect(await readdir(result.moduleDir)).toEqual(["MODULE.md", "Mailer.module.ts"]);
    expect(await readFile(path.join(result.moduleDir, "Mailer.module.ts"), "utf8")).toContain("exports: []");
  });

  test("generates and connects a composite with four atomic passports and no business providers", async () => {
    const f = await fixture();
    const result = await generateModulePack({ ...f, name: "DataManager", parts: ["tables", "fields", "validators", "records"] });
    expect(result.files).toHaveLength(10);
    expect(result.registered).toBe(true);
    const module = await readFile(path.join(result.moduleDir, "DataManager.module.ts"), "utf8");
    expect(module).toContain("imports: [TablesModule, FieldsModule, ValidatorsModule, RecordsModule]");
    expect(module).not.toContain("providers:");
    expect(module).not.toContain("ormOsnova:");
    const app = await readFile(f.appModulePath, "utf8");
    expect(app).toContain('from "../features/data-manager_modules/DataManager.module"');
    for (const part of ["tables", "fields", "validators", "records"]) {
      const files = await readdir(path.join(result.moduleDir, `${part}_module`));
      expect(files).toHaveLength(2);
      expect(files).toContain("MODULE.md");
    }
    for (const file of result.files.filter((file) => file.endsWith("MODULE.md"))) {
      const markdown = await readFile(file, "utf8");
      for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        expect(await Bun.file(path.resolve(path.dirname(file), match[1]!)).exists()).toBe(true);
      }
    }
  });

  test("force is idempotent and retains unrelated user files", async () => {
    const f = await fixture();
    const options = { ...f, name: "Task", profile: "empty" as const };
    const initial = await generateModule(options);
    await Bun.write(path.join(initial.moduleDir, "notes.txt"), "keep");
    const second = await generateModule({ ...options, force: true });
    expect(second.changes).toEqual([]);
    expect(second.registered).toBe(true);
    expect(await readFile(path.join(initial.moduleDir, "notes.txt"), "utf8")).toBe("keep");
  });

  test("pack dry-run creates no directory; invalid parts fail before writes", async () => {
    const f = await fixture();
    const result = await generateModulePack({ ...f, name: "DataManager", parts: ["tables", "records"], dryRun: true });
    expect(result.files).toHaveLength(6);
    expect(await Bun.file(result.moduleDir).exists()).toBe(false);
    await expect(generateModulePack({ ...f, name: "DataManager", parts: ["records", "records"] })).rejects.toThrow();
    expect(await Bun.file(f.modulesRoot).exists()).toBe(false);
  });

  test("actual CLI process handles help and error exit codes without writes", async () => {
    const f = await fixture();
    const main = path.resolve(import.meta.dir, "../main.ts");
    for (const [args, expected] of [
      [["g", "module", "Task", "--help"], 0],
      [["g", "module", "Task", "--modules-root"], 1],
    ] as const) {
      const process = Bun.spawn([Bun.argv[0]!, main, ...args], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      expect(code).toBe(expected);
      expect(out + err).toContain(expected === 0 ? "Usage:" : "requires a value");
    }
    expect(await readdir(f.root)).toEqual(["host"]);
  });
});

describe("codegen delegation", () => {
  test("runs the installed framework generator with the requested target and propagates its status", async () => {
    const f = await fixture();
    const generator = path.join(f.root, "node_modules/osnv/core/scripts/di-generate.ts");
    await mkdir(path.dirname(generator), { recursive: true });
    await Bun.write(path.join(f.root, "osnv.config.json"), JSON.stringify({ targets: { production: {} } }));
    await Bun.write(generator, 'await Bun.write("arguments.json", JSON.stringify(Bun.argv.slice(2))); process.exitCode = 23;');
    expect(resolveGenerator(f.root)).toBe(generator);
    expect(await runCodegen(f.root, "production")).toBe(23);
    expect(await Bun.file(path.join(f.root, "arguments.json")).json()).toEqual(["--target", "production"]);
  });

  test("rejects an unknown target before subprocess execution", async () => {
    const f = await fixture();
    await Bun.write(path.join(f.root, "osnv.config.json"), '{"targets":{"production":{}}}');
    await expect(runCodegen(f.root, "unknown")).rejects.toThrow("Unknown codegen target");
    await expect(runCodegen(path.join(f.root, "missing"), "production")).rejects.toThrow("osnv.config.json");
  });
});

test.each([
  ["Status", "Status", "statuses"], ["statuses", "Status", "statuses"],
  ["Address", "Address", "addresses"], ["addresses", "Address", "addresses"],
  ["Class", "Class", "classes"], ["Case", "Case", "cases"],
  ["cases", "Case", "cases"], ["Boy", "Boy", "boys"],
  ["Category", "Category", "categories"], ["APIKey", "ApiKey", "api-keys"],
  ["Constructor", "Constructor", "constructors"],
])("normalizes common module names: %s", (input, entity, route) => {
  expect(parseModuleName(input).entity).toBe(entity);
  expect(parseModuleName(input).route).toBe(route);
});

test("osnv dev runs as development unless OSNV_ENV is set in the shell", () => {
  expect(devEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin", OSNV_ENV: "development" });
  expect(devEnvironment({ OSNV_ENV: "" }).OSNV_ENV).toBe("development");
  expect(devEnvironment({ OSNV_ENV: "staging" }).OSNV_ENV).toBe("staging");
});

test("files and role classes are named by the module; the record and its DTOs stay singular", async () => {
  expect(parseModuleName("Stats")).toMatchObject({ folder: "stats", module: "Stats", moduleClass: "StatsModule", entity: "Stat" });
  expect(parseModuleName("order-items")).toMatchObject({ folder: "order-items", module: "OrderItems", moduleClass: "OrderItemsModule", entity: "OrderItem", route: "order-items" });
  expect(parseModuleName("Task")).toMatchObject({ module: "Task", moduleClass: "TaskModule", entity: "Task" });

  const f = await fixture();
  const result = await generateModule({ ...f, name: "Stats", profile: "full" });
  const files = result.files.map((file) => path.relative(result.moduleDir, file)).sort();
  expect(files).toEqual([
    "MODULE.md", "Stats.module.ts",
    "ai/agents/Stats.agent.ts", "ai/contracts/Stats.brief.ts", "ai/tools/Stats.tool.ts",
    "background/Stats.reporter.ts",
    "http/Stats.controller.ts", "http/contracts/Stats.query.ts", "http/contracts/Stats.requests.ts", "http/contracts/Stats.responses.ts",
    "model/Stats.dbContext.ts", "model/Stats.model.ts",
    "services/IStats.service.ts", "services/Stats.service.ts",
  ]);
  const source = async (file: string) => readFile(path.join(result.moduleDir, file), "utf8");
  expect(await source("Stats.module.ts")).toContain("export class StatsModule {}");
  expect(await source("http/Stats.controller.ts")).toContain("export class StatsController {");
  expect(await source("services/Stats.service.ts")).toContain("export class StatsService implements IStatsService {");
  expect(await source("model/Stats.dbContext.ts")).toContain("export class StatsDbContext extends DbContext {");
  expect(await source("model/Stats.model.ts")).toContain("export class Stat {");
  expect(await source("http/contracts/Stats.requests.ts")).toContain("export class CreateStatRequest {");
  expect(await source("background/Stats.reporter.ts")).toContain("export class StatsReporter ");
  expect(await readFile(f.appModulePath, "utf8")).toContain("import { StatsModule } from \"../features/stats/Stats.module\";");
});
