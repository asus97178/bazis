import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateProject } from "../generateProject";
import { parseCliArgs } from "../parseCli";
import { runCli, type CliRuntime } from "../main";

const roots: string[] = [];
const frameworkPath = path.resolve(import.meta.dir, "../..");
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnv-project-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("new project", () => {
  test("parses only its own options and rejects invalid names", () => {
    expect(parseCliArgs(["new", "MyApp", "--path", "/tmp/example", "--dry-run"])).toMatchObject({ kind: "new", name: "MyApp", dryRun: true });
    expect(parseCliArgs(["new", "../escape"]).kind).toBe("error");
    expect(parseCliArgs(["new", "App", "--force"]).kind).toBe("error");
    expect(parseCliArgs(["g", "module", "App", "--framework", frameworkPath]).kind).toBe("error");
    expect(parseCliArgs(["new", "App", "--link-framework"])).toMatchObject({ kind: "new", linkFramework: true });
    expect(parseCliArgs(["g", "module", "App", "--link-framework"]).kind).toBe("error");
    expect(parseCliArgs(["codegen", "--link-framework"]).kind).toBe("error");
  });

  test("dry-run has no effects; creation produces an independent app and refuses overwrite", async () => {
    const root = await fixture();
    const outputPath = path.join(root, "hello-app");
    const options = { name: "HelloApp", outputPath, frameworkPath };
    const planned = await generateProject({ ...options, dryRun: true });
    expect(planned.files).toHaveLength(11);
    expect(await readdir(root)).toEqual([]);
    const result = await generateProject(options);
    expect(result.projectDir).toBe(await realpath(outputPath));
    const manifest = JSON.parse(await readFile(path.join(outputPath, "package.json"), "utf8"));
    expect(manifest.dependencies.osnv).toBe("file:./vendor/osnv");
    expect(result.frameworkMode).toBe("snapshot");
    expect(result.frameworkFileCount).toBeGreaterThan(0);
    expect(result.frameworkFileCount).toBe(planned.frameworkFileCount);
    expect(await Bun.file(path.join(outputPath, "vendor/osnv/cli/main.ts")).text()).toBe(await Bun.file(path.join(frameworkPath, "cli/main.ts")).text());
    expect(await readdir(path.join(outputPath, "vendor/osnv"))).not.toContain("node_modules");
    expect(await readdir(path.join(outputPath, "vendor/osnv/cli"))).not.toContain("test");
    expect(manifest.scripts["di:generate"]).toBeUndefined();
    expect(manifest.scripts).toMatchObject({ codegen: "osnv codegen", dev: "osnv dev", build: "osnv build", "build:bin": "osnv build --bin" });
    expect(manifest.scripts.osnv).toBeUndefined();
    expect(await readFile(path.join(outputPath, "docs/architecture/MODULE_ARCHITECTURE.md"), "utf8")).toContain("atomic module");
    expect(await readFile(path.join(outputPath, "src/index.ts"), "utf8")).toContain("registerOsnvGeneratedRuntime");
    await expect(generateProject(options)).rejects.toThrow("already exists");
    await expect(generateProject({ name: "Bad", outputPath: path.join(root, "bad"), frameworkPath: root })).rejects.toThrow("Local Osnv package not found");
    await expect(generateProject({ name: "Orphan", outputPath: path.join(root, "missing/parent/orphan"), frameworkPath })).rejects.toThrow("Parent directory does not exist");
    await expect(generateProject({ name: "Nested", outputPath: path.join(frameworkPath, "nested-project"), frameworkPath, dryRun: true })).rejects.toThrow("outside the Osnv package");
    expect(await readdir(root)).toEqual(["hello-app"]);
  });

  test("live framework link is an explicit opt-in", async () => {
    const root = await fixture();
    const result = await generateProject({ name: "Linked", outputPath: path.join(root, "linked"), frameworkPath, linkFramework: true });
    const manifest = await Bun.file(path.join(result.projectDir, "package.json")).json();
    expect(manifest.dependencies.osnv).toBe(`file:${path.relative(result.projectDir, frameworkPath)}`);
    expect(result.frameworkMode).toBe("link");
    expect(result.frameworkFileCount).toBe(0);
    expect(await readdir(result.projectDir)).not.toContain("vendor");
  });

  test("CLI command prints the created path without running codegen", async () => {
    const root = await fixture();
    const logs: string[] = [];
    const runtime: CliRuntime = { log: (message) => logs.push(message), error: (message) => logs.push(message), codegen: async () => { throw new Error("unexpected codegen"); } };
    expect(await runCli(["new", "Demo", "--path", path.join(root, "demo"), "--framework", frameworkPath], runtime)).toBe(0);
    expect(logs.join("\n")).toContain("created project:");
    expect(logs.join("\n")).toContain("bun install");
  });

  test("relocated snapshot runs codegen without the original framework source tree", async () => {
    const root = await fixture();
    const result = await generateProject({ name: "Standalone", outputPath: path.join(root, "standalone"), frameworkPath });
    const relocated = path.join(root, "relocated");
    await rename(result.projectDir, relocated);
    await mkdir(path.join(relocated, "node_modules"));
    await symlink("../vendor/osnv", path.join(relocated, "node_modules/osnv"));
    await symlink(path.resolve("node_modules/typescript"), path.join(relocated, "node_modules/typescript"));
    await symlink(path.resolve("node_modules/@types"), path.join(relocated, "node_modules/@types"));
    const run = async (args: string[]) => {
      const executable = process.env.OSNV_BUN_BIN ?? process.execPath;
      const child = Bun.spawn([executable, ...args], { cwd: relocated, stdout: "pipe", stderr: "pipe" });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, output + error).toBe(0);
    };
    await run(["node_modules/osnv/cli/main.ts", "codegen"]);
    expect(await Bun.file(path.join(relocated, "src/generated/osnv/runtime.ts")).exists()).toBe(true);
    expect(await Bun.file(path.join(relocated, "src/osnv/package.json")).exists()).toBe(false);
  }, 30_000);
});
