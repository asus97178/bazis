import { expect, test } from "bun:test";
import path from "node:path";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";

test("CLI scaffolds feed the real codegen: context DI, HTTP bindings and AI catalog", async () => {
  const project = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-cli-codegen-"));
  const main = path.resolve(import.meta.dir, "../main.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, main, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
  };
  try {
    // Keep the real framework under src/osnova: the codegen boundary deliberately
    // treats files outside that directory as application sources.
    await cp(path.join(project, "src/osnova"), path.join(root, "src/osnova"), { recursive: true });
    await symlink(path.join(project, "node_modules"), path.join(root, "node_modules"));
    await cp(path.join(project, "tsconfig.json"), path.join(root, "tsconfig.json"));
    const modules = path.join(root, "src/app/modules");
    await mkdir(path.join(modules, "auth"), { recursive: true });
    for (const helper of ["jwtAuth.ts", "tokenKinds.ts", "accessTokenValidation.ts"]) {
      await cp(path.join(project, "src/app/modules/auth", helper), path.join(modules, "auth", helper));
    }
    await Bun.write(path.join(modules, "App.module.ts"), 'import { Module } from "@osnova/core/di";\n@Module({imports: [], exports: []})\nexport class AppModule {}\n');
    await Bun.write(path.join(root, "src/index.ts"), 'export { AppModule } from "./app/modules/App.module";\n');
    await Bun.write(path.join(root, "osnv.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ scripts: { "di:generate": "bun run src/osnova/core/scripts/di-generate.ts" } }));
    await run(["g", "m", "CliGuest", "--no-codegen"]);
    await run(["g", "module", "CliCatalog", "--full", "--no-codegen"]);
    await run(["g", "module", "CliMailer", "--empty", "--no-codegen"]);
    await run(["g", "pack", "CliDataManager", "--parts", "tables,records", "--no-codegen"]);
    const generated = path.join(root, "src/generated/osnv");
    await Bun.write(path.join(generated, "keep.txt"), "unrelated file");
    await run(["codegen", "--target", "production"]);
    expect(await Bun.file(path.join(generated, "keep.txt")).text()).toBe("unrelated file");
    const deps = await Bun.file(path.join(generated, "deps.ts")).text();
    expect(deps).toContain("CliGuestDbContext");
    expect(deps).toContain("CliCatalogDbContext");
    expect(deps).toContain("ICache");
    expect(deps).toContain("ICliCatalogService");
    const bindings = await Bun.file(path.join(generated, "bindings.ts")).text();
    expect(bindings).toContain("CliGuestController");
    expect(bindings).toContain("CliCatalogController");
    const agents = await Bun.file(path.join(generated, "agentCatalog.ts")).text();
    expect(agents).toContain("CliCatalogSummaryTool");
    expect(agents).toContain("CliCatalogAnalystAgent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
