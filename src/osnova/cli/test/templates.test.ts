import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { generateModule, generateModulePack } from "../generateModule";
import { MemoryCache } from "@osnova/core/cache";
import { HttpContext } from "@osnova/core/http";
import { ServiceCollection } from "@osnova/core/di";
import { optionsFromSchema, parseListQuery } from "@osnova/library/jsonapi";
import { DbContextOptions, ModelBuilder, type DatabaseProvider, type Row, type SqlParam } from "@osnova/library/orm";
import { PostgresDialect } from "../../library/orm/Providers/PostgresDialect";

let root = "";
let catalogDir = "";
let guestDir = "";
const files: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "osnova-cli-templates-"));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ extends: path.resolve("tsconfig.json"), include: ["**/*.ts"] }));
  for (const [name, profile] of [["CliGuest", "minimal"], ["CliCatalog", "full"], ["CliMailer", "empty"]] as const) {
    const result = await generateModule({ name, profile, modulesRoot: root, register: false });
    files.push(...result.files);
    if (profile === "full") catalogDir = result.moduleDir;
    if (profile === "minimal") guestDir = result.moduleDir;
  }
  files.push(...(await generateModulePack({ name: "CliDataManager", parts: ["tables", "records"], modulesRoot: root, register: false })).files);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("all generated profiles type-check against the real framework and host auth", () => {
  const configFile = ts.readConfigFile(path.resolve("tsconfig.json"), ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd());
  const program = ts.createProgram(files.filter((file) => file.endsWith(".ts")), { ...config.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map((diagnostic) => `${diagnostic.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)).toEqual([]);
}, 30_000);

test("generated CRUD passports link to existing components and document their fields", async () => {
  for (const file of files.filter((file) => file.endsWith("MODULE.md"))) {
    const markdown = await Bun.file(file).text();
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      expect(await Bun.file(path.resolve(path.dirname(file), match[1]!)).exists()).toBe(true);
    }
    expect(markdown).toContain("AGENTS.md");
  }
  const passport = await Bun.file(path.join(catalogDir, "MODULE.md")).text();
  for (const field of ["body.name", "body.email", "basePath", "topic", "audience", "context"]) expect(passport).toContain(field);
});

test("full service evicts list and item caches after successful mutations, preserving other tags", async () => {
  const { CliCatalogService } = await import(path.join(catalogDir, "services/CliCatalog.service.ts"));
  const entity = { id: "123e4567-e89b-42d3-a456-426614174000", name: "First", email: "first@example.com", createdAt: new Date(), updatedAt: new Date() };
  let failSave = false;
  const repository = {
    find: async () => entity,
    add: () => {}, remove: () => {},
    saveChanges: async () => { if (failSave) throw new Error("save failed"); },
  };
  const cache = new MemoryCache();
  const service = new CliCatalogService({ cliCatalogs: repository, saveChanges: repository.saveChanges }, cache);
  const prime = () => {
    cache.set("list", [entity], { tags: ["cli-catalogs"] });
    cache.set("item", entity, { tags: ["cli-catalogs"] });
    cache.set("unrelated", true, { tags: ["other"] });
  };
  for (const mutate of [
    () => service.create({ name: "Second", email: "second@example.com" }),
    () => service.update(entity.id, { name: "Updated" }),
    () => service.delete(entity.id),
  ]) {
    prime();
    await mutate();
    expect(cache.get("list")).toBeUndefined();
    expect(cache.get("item")).toBeUndefined();
    expect(cache.get("unrelated")).toBe(true);
  }
  prime();
  failSave = true;
  await expect(service.create({ name: "Third", email: "third@example.com" })).rejects.toThrow("save failed");
  expect(cache.get("list")).toBeDefined();
  cache.dispose();
});

test("generated controllers derive Location and list basePath from the active HTTP prefix", async () => {
  const { CliGuestController } = await import(path.join(guestDir, "http/CliGuestController.ts"));
  const item = { id: "123e4567-e89b-42d3-a456-426614174000", name: "Guest", email: "guest@example.com" };
  const service = { create: async () => item };
  const controller = new CliGuestController(service);
  const provider = new ServiceCollection().buildServiceProvider();
  const scope = provider.createScope();
  const url = new URL("http://localhost/custom/v2/cli-guests/");
  const ctx = new HttpContext(new Request(url.toString()), url, {}, scope);
  const result = await controller.create(item, ctx);
  expect(result.status).toBe(201);
  expect(new Headers(result.headers).get("Location")).toBe(`/custom/v2/cli-guests/${item.id}`);

  const { CliCatalogController } = await import(path.join(catalogDir, "http/CliCatalogController.ts"));
  const calls: unknown[][] = [];
  const catalogController = new CliCatalogController({ getAll: async (...args: unknown[]) => { calls.push(args); return { items: [item], total: 42 }; } });
  const query = parseListQuery(new URLSearchParams());
  const document = await catalogController.list(query, ctx);
  expect(calls).toEqual([[query]]);
  expect(document.data).toEqual([item]);
  expect(document.meta.total).toBe(42);
  expect(document.links.self).toStartWith(ctx.path);
  await scope.dispose();
  await provider.dispose();
});

test("minimal and full lists bound SQL and return data; summary counts all rows and selects at most 20 names", async () => {
  for (const [directory, entityName] of [[guestDir, "CliGuest"], [catalogDir, "CliCatalog"]]) {
    const { [entityName!]: Entity } = await import(path.join(directory!, `model/${entityName}.model.ts`));
    const { [`${entityName}DbContext`]: Context } = await import(path.join(directory!, `model/${entityName}DbContext.ts`));
    const { [`${entityName}Service`]: Service } = await import(path.join(directory!, `services/${entityName}.service.ts`));
    const { [`${entityName}ListQuery`]: Query } = await import(path.join(directory!, `http/contracts/${entityName}ListQuery.ts`));
    const statements: { sql: string; params: readonly SqlParam[] }[] = [];
    const provider: DatabaseProvider = {
      name: "postgres", dialect: new PostgresDialect(), limits: { maxParametersPerCommand: 32767 },
      async query(sql, params) { statements.push({ sql, params }); return (/COUNT\(/i.test(sql) ? [{ count: 200 }] : [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Guest", email: "guest@example.com", createdAt: new Date(), updatedAt: new Date() }]) as Row[]; },
      async execute() { throw new Error("read must not write"); },
      async transaction() { throw new Error("read must not start a transaction"); },
      async ping() { return true; }, async introspect() { return { tables: new Map() }; }, async close() {},
    };
    const db = new Context(new DbContextOptions({ provider, entities: [Entity] }));
    const cache = new MemoryCache();
    try {
      const service = new Service(db, cache);
      const options = optionsFromSchema(Query);
      for (const [search, limit, offset] of [["", 20, 0], ["page[size]=999999", 100, 0], ["page[number]=2&page[size]=10", 10, 10]] as const) {
        statements.length = 0;
        const result = await service.getAll(parseListQuery(new URLSearchParams(search), options));
        expect(result.total).toBe(200);
        expect(result.items[0].name).toBe("Guest");
        expect(Object.keys(result).sort()).toEqual(["items", "total"]);
        expect(statements).toHaveLength(2);
        expect(statements[0]!.sql).toMatch(/COUNT\(/i);
        expect(statements[1]!.sql).toContain("LIMIT $1 OFFSET $2");
        expect(statements[1]!.params).toEqual([limit, offset]);
        expect(statements[1]!.sql).toContain('ORDER BY "id" ASC');
      }
      expect(db.changeTracker.tryGetByKey(ModelBuilder.build(Entity), "123e4567-e89b-42d3-a456-426614174000")).toBeUndefined();
      statements.length = 0;
      await service.getAll(parseListQuery(new URLSearchParams("filter[email]=guest@example.com"), options));
      expect(statements[0]!.params).toEqual(["guest@example.com"]);
      expect(statements[1]!.params).toEqual(["guest@example.com", 20, 0]);
      statements.length = 0;
      expect(await service.summary()).toEqual({ count: 200, names: ["Guest"] });
      expect(statements).toHaveLength(2);
      expect(statements[1]!.sql).toStartWith('SELECT "name"');
      expect(statements[1]!.sql).toContain("LIMIT $1");
      expect(statements[1]!.params).toEqual([20]);
    } finally { cache.dispose(); }
  }
});
