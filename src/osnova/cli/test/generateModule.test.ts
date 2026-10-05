import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateModule } from "../generateModule";
import { parseModuleName } from "../naming";
import { buildModuleTemplates } from "../templates/module";

describe("parseModuleName", () => {
  test("normalizes User → folder user, route users", () => {
    const naming = parseModuleName("User");
    expect(naming.folder).toBe("user");
    expect(naming.entity).toBe("User");
    expect(naming.route).toBe("users");
    expect(naming.moduleClass).toBe("UserModule");
    expect(naming.collection).toBe("users");
  });

  test("keeps plural folder users", () => {
    const naming = parseModuleName("users");
    expect(naming.folder).toBe("users");
    expect(naming.entity).toBe("User");
    expect(naming.route).toBe("users");
  });

  test("supports hyphenated names", () => {
    const naming = parseModuleName("order-item");
    expect(naming.folder).toBe("order-item");
    expect(naming.entity).toBe("OrderItem");
    expect(naming.route).toBe("order-items");
    expect(naming.collection).toBe("orderItems");
  });

  test("normalizes irregular singular and plural inputs to the same entity and route", () => {
    const cases = [
      ["person", "people", "Person", "people"],
      ["child", "children", "Child", "children"],
      ["man", "men", "Man", "men"],
      ["woman", "women", "Woman", "women"],
    ] as const;
    for (const [singular, plural, entity, route] of cases) {
      const fromSingular = parseModuleName(singular);
      const fromPlural = parseModuleName(plural);
      expect(fromSingular.entity).toBe(entity);
      expect(fromPlural.entity).toBe(entity);
      expect(fromSingular.route).toBe(route);
      expect(fromPlural.route).toBe(route);
      expect(fromSingular.collection).toBe(route);
      expect(fromPlural.collection).toBe(route);
    }
  });
});

describe("generateModule", () => {
  let tempRoot = "";

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "osnova-cli-"));
  });

  afterAll(async () => {
    if (tempRoot.length > 0) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("creates minimal module tree by default", async () => {
    const modulesRoot = path.join(tempRoot, "modules");
    await mkdir(modulesRoot, { recursive: true });

    const appModulePath = path.join(modulesRoot, "App.module.ts");
    await Bun.write(
      appModulePath,
      `import { Module } from "@osnova/core/di";

@Module({ imports: [] })
export class AppModule {}
`,
    );

    const result = await generateModule({
      name: "Product",
      modulesRoot,
      appModulePath,
    });

    expect(result.files).toHaveLength(10);
    expect(result.registered).toBe(true);

    const moduleDir = path.join(modulesRoot, "product");
    const expectedFiles = buildModuleTemplates(parseModuleName("Product"), "minimal").map((file) =>
      path.join(moduleDir, file.relativePath),
    );

    for (const file of expectedFiles) {
      expect(await Bun.file(file).exists()).toBe(true);
    }

    const appModule = await readFile(appModulePath, "utf8");
    expect(appModule).toContain('import { ProductModule } from "./product/Product.module";');
    expect(appModule).toContain("imports: [ProductModule]");

    const controller = await readFile(path.join(moduleDir, "http/Product.controller.ts"), "utf8");
    expect(controller).not.toContain("@Authorize");
    expect(controller).not.toContain("@OutputCache");
    const module = await readFile(path.join(moduleDir, "Product.module.ts"), "utf8");
    expect(module).not.toContain("agents:");
    expect(module).not.toContain("tools:");
    expect(module).toContain("ormOsnova:");
    expect(module).not.toContain("sqlite");
    expect(module).not.toContain("provider:");
  });

  test("creates full enterprise module tree when requested", async () => {
    const modulesRoot = path.join(tempRoot, "full");
    await mkdir(modulesRoot, { recursive: true });

    const result = await generateModule({
      name: "Catalog",
      modulesRoot,
      register: false,
      profile: "full",
    });

    expect(result.files).toHaveLength(14);

    const moduleDir = path.join(modulesRoot, "catalog");
    const expectedFiles = buildModuleTemplates(parseModuleName("Catalog"), "full").map((file) =>
      path.join(moduleDir, file.relativePath),
    );

    for (const file of expectedFiles) {
      expect(await Bun.file(file).exists()).toBe(true);
    }

    const controller = await readFile(path.join(moduleDir, "http/Catalog.controller.ts"), "utf8");
    expect(controller).toContain("@Authorize");
    expect(controller).toContain("@OutputCache");

    const agent = await readFile(path.join(moduleDir, "ai/agents/Catalog.agent.ts"), "utf8");
    expect(agent).toContain("@Agent");
    expect(agent).toContain("@Task");
    expect(agent).toContain('role: "catalogs analyst"');
    expect(await Bun.file(path.join(moduleDir, "ai/prompts/CatalogAnalystPrompt.ts")).exists()).toBe(false);

    const module = await readFile(path.join(moduleDir, "Catalog.module.ts"), "utf8");
    expect(module).toContain("agents: [CatalogAnalystAgent]");
    expect(module).toContain("tools: [CatalogSummaryTool]");
    expect(module).not.toContain("scoped(CatalogSummaryTool)");
    expect(module).not.toContain("as const");
    expect(module).toContain("ormOsnova:");
    expect(module).not.toContain("sqlite");
    expect(module).not.toContain("provider:");
  });

  test("full profile without host auth helpers generates public routes and warns", async () => {
    const previous = process.cwd();
    const host = await mkdtemp(path.join(os.tmpdir(), "osnv-full-no-auth-"));
    try {
      process.chdir(host);
      const root = path.join(host, "src/app/modules");
      await mkdir(root, { recursive: true });
      const result = await generateModule({ name: "Ledger", modulesRoot: root, register: false, profile: "full" });
      expect(result.files).toHaveLength(14);
      expect(result.warnings.some((warning) => warning.includes("no @Authorize"))).toBe(true);
      const controller = await readFile(path.join(root, "ledger/http/Ledger.controller.ts"), "utf8");
      expect(controller).not.toMatch(/^\s*@Authorize\(/m);
      expect(controller).not.toContain("tokenKinds");
      expect(controller).toContain("@OutputCache");
      expect(controller).toContain("these routes are public");
    } finally {
      process.chdir(previous);
      await rm(host, { recursive: true, force: true });
    }
  });

  test("fails when module folder exists", async () => {
    const modulesRoot = path.join(tempRoot, "dup");
    await generateModule({ name: "Invoice", modulesRoot, register: false });

    await expect(generateModule({ name: "Invoice", modulesRoot, register: false })).rejects.toThrow(
      "Module folder already exists",
    );
  });

  test("preflights App.module.ts before creating feature files", async () => {
    const modulesRoot = path.join(tempRoot, "invalid-app");
    await mkdir(modulesRoot, { recursive: true });
    const appModulePath = path.join(modulesRoot, "App.module.ts");
    await Bun.write(appModulePath, "export class AppModule {}\n");

    await expect(generateModule({ name: "Person", modulesRoot, appModulePath })).rejects.toThrow(
      "Could not select a unique @Module class",
    );
    expect(await Bun.file(path.join(modulesRoot, "person")).exists()).toBe(false);
    expect(await readFile(appModulePath, "utf8")).toBe("export class AppModule {}\n");
  });

  test("rolls back overwritten files when a later atomic write fails", async () => {
    const modulesRoot = path.join(tempRoot, "rollback");
    const moduleDir = path.join(modulesRoot, "invoice");
    await mkdir(moduleDir, { recursive: true });
    const moduleFile = path.join(moduleDir, "Invoice.module.ts");
    await Bun.write(moduleFile, "// original\n");
    // The second template write needs `model/` to be a directory. A file at the
    // same path forces a deterministic write failure after the first overwrite.
    await Bun.write(path.join(moduleDir, "model"), "blocker\n");

    await expect(generateModule({
      name: "Invoice",
      modulesRoot,
      register: false,
      force: true,
    })).rejects.toThrow();

    expect(await readFile(moduleFile, "utf8")).toBe("// original\n");
    expect(await readFile(path.join(moduleDir, "model"), "utf8")).toBe("blocker\n");
    expect(await Bun.file(path.join(moduleDir, "services/IInvoice.service.ts")).exists()).toBe(false);
  });
});
