import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateModule, generateModulePack } from "../generateModule";
import { parseCliArgs } from "../parseCli";

// Passports record the creation command, and `g module --pack` adds a part to an
// existing composite module the same way `g pack` lays out its parts.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bazis-cli-pack-part-")));
  roots.push(root);
  const modulesRoot = path.join(root, "modules");
  const appModulePath = path.join(modulesRoot, "App.module.ts");
  await mkdir(modulesRoot, { recursive: true });
  await Bun.write(appModulePath, 'import { Module } from "bazis/core/di";\n@Module({ imports: [], exports: [] })\nexport class AppModule {}\n');
  return { modulesRoot };
}

test("passports record the canonical creation command", async () => {
  const { modulesRoot } = await fixture();
  const module = await generateModule({ name: "Task", profile: "minimal", modulesRoot });
  expect(await readFile(path.join(module.moduleDir, "MODULE.md"), "utf8"))
    .toContain(`Created with: \`bunx bazis g module Task --minimal --modules-root ${modulesRoot}\`.`);

  const pack = await generateModulePack({ name: "Catalog", parts: ["items", "categories"], modulesRoot });
  const command = `bunx bazis g pack Catalog --parts items,categories --modules-root ${modulesRoot}`;
  expect(await readFile(path.join(pack.moduleDir, "MODULE.md"), "utf8")).toContain(`Created with: \`${command}\`.`);
  const part = await readFile(path.join(pack.moduleDir, "items_module/MODULE.md"), "utf8");
  expect(part).toContain(`Created with: \`${command}\`.`);
  expect(part).toContain("Type: atomic, a part of the composite CatalogModule ([passport](../MODULE.md)).");
});

test("--pack adds a part next to the generated ones and connects it in the pack root", async () => {
  const { modulesRoot } = await fixture();
  await generateModulePack({ name: "Catalog", parts: ["items", "categories"], modulesRoot });
  const result = await generateModule({ name: "Prices", profile: "empty", pack: "Catalog", modulesRoot });

  const packDir = path.join(modulesRoot, "catalog_modules");
  expect(result.moduleDir).toBe(path.join(packDir, "prices_module"));
  expect((await readdir(result.moduleDir)).sort()).toEqual(["MODULE.md", "Prices.module.ts"]);
  const root = await readFile(path.join(packDir, "Catalog.module.ts"), "utf8");
  expect(root).toContain('import { PricesModule } from "./prices_module/Prices.module";');
  expect(root).toContain("imports: [ItemsModule, CategoriesModule, PricesModule]");
  expect(await readFile(path.join(modulesRoot, "App.module.ts"), "utf8")).not.toContain("PricesModule");

  const passport = await readFile(path.join(result.moduleDir, "MODULE.md"), "utf8");
  expect(passport).toContain("Type: atomic, a part of the composite CatalogModule ([passport](../MODULE.md)).");
  expect(passport).toContain(`Created with: \`bunx bazis g module Prices --empty --pack Catalog --modules-root ${modulesRoot}\`.`);
  expect(result.warnings.some((warning) => warning.startsWith("Add PricesModule to the parts table in "))).toBe(true);
});

test("--pack fails before writing when the pack does not exist", async () => {
  const { modulesRoot } = await fixture();
  await expect(generateModule({ name: "Prices", profile: "empty", pack: "Catalog", modulesRoot }))
    .rejects.toThrow("Pack CatalogModule not found");
  expect(await readdir(modulesRoot)).toEqual(["App.module.ts"]);
});

test("--pack is parsed for g module only and not together with --app-module", () => {
  expect(parseCliArgs(["g", "module", "Prices", "--empty", "--pack", "Catalog"])).toMatchObject({ kind: "generate", args: { pack: "Catalog" } });
  expect(parseCliArgs(["g", "pack", "Catalog", "--parts", "a,b", "--pack", "Other"]).kind).toBe("error");
  expect(parseCliArgs(["g", "module", "Prices", "--pack", "Catalog", "--app-module", "x.ts"]).kind).toBe("error");
});
