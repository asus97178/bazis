import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function clearBuildFlags(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await clearBuildFlags(file);
    // On macOS Bun's compile scratch copy inherits the qualified launcher's
    // immutable flag. Only clear that flag on scratch files owned by this test.
    else if (process.platform === "darwin" && entry.isFile() && entry.name.endsWith(".bun-build")) {
      const child = Bun.spawn(["/usr/bin/chflags", "nouchg", file], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    }
  }
}

test("compiled CLI creates an independent app with exact late DI and cached activation in its binary", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..");
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "bazis-standalone-runtime-"));
  const project = path.join(root, "app");
  const cli = path.join(root, "bazis");
  const binary = path.join(root, "app-bin");
  const run = async (command: string[], cwd = root) => {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${command.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
    return stdout.trim();
  };
  try {
    await run([process.execPath, "build", "--compile", path.join(repository, "src/bazis/cli/main.ts"), "--outfile", cli]);
    await run([cli, "new", "StandaloneAudit", "--path", project, "--framework", path.join(repository, "src/bazis"), "--vendor"]);
    // Relocation must not depend on the old absolute location or framework checkout.
    await rename(project, `${project}-moved`);
    await mkdir(project);
    await rename(`${project}-moved`, path.join(project, "relocated"));
    const relocated = path.join(project, "relocated");
    await run([cli, "g", "module", "AuditProbe", "--empty", "--no-codegen"], relocated);
    await mkdir(path.join(relocated, "node_modules"));
    await symlink("../vendor/bazis", path.join(relocated, "node_modules/bazis"), "dir");
    for (const [name, source] of [
      ["@types", "node_modules/@types"], ["typescript", "node_modules/typescript"],
    ]) await symlink(path.join(repository, source!), path.join(relocated, "node_modules", name!), "dir");
    const sources = {
      "src/app/modules/audit-probe/User.service.ts": `export class UserService { get() { return "independent-app"; } }`,
      "src/app/modules/audit-probe/Dependency.service.ts": `export class DependencyService { get() { return "late-dependency"; } }`,
      "src/app/modules/audit-probe/Cached.service.ts": `import { Cacheable } from "bazis/core/cache";
import { DependencyService } from "./Dependency.service";
export class CachedService {
  constructor(readonly dependency: DependencyService) {}
  @Cacheable({ seconds: 30 }) get() { return this.dependency.get(); }
}`,
      "src/app/modules/audit-probe/AuditProbe.module.ts": `import { Module, scoped } from "bazis/core/di";
import { memory } from "bazis/core/cache";
import { UserService } from "./User.service";
import { DependencyService } from "./Dependency.service";
import { CachedService } from "./Cached.service";
@Module({ imports: [memory()], providers: [scoped(UserService), scoped(DependencyService), scoped(CachedService)], exports: [UserService, CachedService] })
export class AuditProbeModule {}`,
      "src/index.ts": `import { createContainer } from "bazis/core/di";
import { AppModule } from "./app/modules/App.module";
import { UserService } from "./app/modules/audit-probe/User.service";
import { CachedService } from "./app/modules/audit-probe/Cached.service";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const container = createContainer(AppModule, { validateOnBuild: true });
try {
  const scope = container.createScope();
  try { console.log(JSON.stringify({ user: scope.resolve(UserService).get(), cached: scope.resolve(CachedService).get() })); }
  finally { await scope.dispose(); }
} finally { await container.dispose(); }`,
    };
    for (const [name, source] of Object.entries(sources)) await Bun.write(path.join(relocated, name), source);
    await run([cli, "codegen", "--target", "production"], relocated);
    await run([process.execPath, path.join(repository, "node_modules/typescript/bin/tsc"), "--noEmit"], relocated);
    const expected = { user: "independent-app", cached: "late-dependency" };
    expect(JSON.parse(await run([process.execPath, "run", "src/index.ts"], relocated))).toEqual(expected);
    await run([process.execPath, "build", "--compile", "src/index.ts", "--outfile", binary], relocated);
    // Run without project sources or node_modules in the current directory.
    expect(JSON.parse(await run([binary], root))).toEqual(expected);
    console.log("STANDALONE_RUNTIME_PASS: CLI new/module/codegen, TypeScript, source, compile, binary outside checkout");
  } finally {
    await clearBuildFlags(root);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
