import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const repo = process.cwd();
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stdout + stderr).toBe(0);
  return stdout;
}

async function clearBuildFlags(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await clearBuildFlags(file);
    // The qualified Bun launcher's immutable flag reaches compile scratch copies on macOS.
    // Limit cleanup to files created inside this fixture; never follow its node_modules symlink.
    else if (process.platform === "darwin" && entry.isFile() && entry.name.endsWith(".bun-build")) {
      await run(["/usr/bin/chflags", "nouchg", file], root);
    }
  }
}

test("codegen preserves class identity, private same-name dependencies and export aliases in a binary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "osnv-class-identity-"));
  try {
    await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true, paths: { "osnv/*": [path.join(repo, "src/osnv/*")], "@/*": [path.join(repo, "src/osnv/*")] } }, include: ["src/**/*.ts"] }),
      "osnv.config.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
      "src/a/Dependency.ts": 'export class Dependency { readonly value = "A"; }',
      "src/b/Dependency.ts": 'export class Dependency { readonly value = "B"; }',
      "src/a/barrel.ts": 'export { Dependency as RenamedDependency } from "./Dependency";',
      "src/a/Service.ts": 'import type { Lazy } from "osnv/core/di"; import { RenamedDependency as Input } from "./barrel"; class WorkerService { constructor(readonly dependency: Input, readonly lazy: Lazy<Input>) {} } export { WorkerService as Service };',
      "src/b/Service.ts": 'import type { Lazy } from "osnv/core/di"; import { Dependency as Input } from "./Dependency"; export default class WorkerService { constructor(readonly dependency: Input, readonly lazy: Lazy<Input>) {} }',
      "src/index.ts": `import { createContainer, singleton } from "osnv/core/di";
import { Dependency as A } from "./a/Dependency";
import { Dependency as B } from "./b/Dependency";
import { Service as Alpha } from "./a/Service";
import Beta from "./b/Service";
const { registerOsnvGeneratedRuntime } = await import("./generated/osnv/runtime");
await registerOsnvGeneratedRuntime();
const root = createContainer({ imports: [
  { providers: [singleton(A), singleton(Alpha)], exports: [Alpha] },
  { providers: [singleton(B), singleton(Beta)], exports: [Beta] },
] }, { validateOnBuild: true });
console.log(root.resolve(Alpha).dependency.value + root.resolve(Beta).dependency.value + root.resolve(Alpha).lazy.value.value + root.resolve(Beta).lazy.value.value);
await root.dispose();`,
    };
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(root, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await Bun.write(destination, content);
    }
    await run([process.execPath, path.join(repo, "src/osnv/core/scripts/di-generate.ts")], root);
    const generated = await Bun.file(path.join(root, "src/generated/osnv/deps.ts")).text();
    expect(generated).toContain("import { Service as TargetClass_");
    expect(generated).toContain("import { default as TargetClass_");
    expect(generated.match(/import \{ Dependency as DependencyClass_/g)).toHaveLength(2);
    expect(generated).not.toContain('["Dependency"]');
    await run([process.execPath, path.join(repo, "node_modules/typescript/bin/tsc"), "--noEmit"], root);
    expect((await run([process.execPath, "src/index.ts"], root)).trim()).toBe("ABAB");
    const binary = path.join(root, "app");
    await run([process.execPath, "build", "--compile", "src/index.ts", "--outfile", binary], root);
    expect((await run([binary], tmpdir())).trim()).toBe("ABAB");
  } finally {
    await clearBuildFlags(root);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
