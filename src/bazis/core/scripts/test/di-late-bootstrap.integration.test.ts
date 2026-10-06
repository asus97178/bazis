import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = process.cwd();
const generator = path.join(repositoryRoot, "src/bazis/core/scripts/di-generate.ts");

async function writeFixture(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const destination = path.join(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await Bun.write(destination, content);
  }));
}

async function run(executable: string, args: readonly string[], cwd: string): Promise<{ readonly exit: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

test("a generated non-default target late-normalizes class deps declared before bootstrap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-di-late-bootstrap-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await symlink(path.join(repositoryRoot, "src/bazis"), path.join(root, "src/bazis"), "dir");
    await writeFixture(root, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          experimentalDecorators: true,
          strict: true,
          paths: {
            "bazis/core/*": ["./src/bazis/core/*"],
          },
        },
        include: ["src/**/*.ts"],
      }),
      "bazis.config.json": JSON.stringify({
        version: 1,
        defaultTarget: "production",
        targets: {
          production: { entrypoints: ["src/production.ts"] },
          audit: { entrypoints: ["src/audit-di-bootstrap/main.ts"] },
        },
      }),
      "src/production.ts": "export const production = true;\n",
      "src/audit-di-bootstrap/Dependency.ts": `export class AuditBootstrapDependency {
  readonly value = "ready";
}
`,
      "src/audit-di-bootstrap/Service.ts": `import { AuditBootstrapDependency } from "./Dependency";

export class AuditBootstrapService {
  constructor(readonly dependency: AuditBootstrapDependency) {}
}
`,
      "src/audit-di-bootstrap/Module.ts": `import { Module, singleton } from "bazis/core/di";
import { AuditBootstrapDependency } from "./Dependency";
import { AuditBootstrapService } from "./Service";

@Module({
  providers: [singleton(AuditBootstrapDependency), singleton(AuditBootstrapService)],
  exports: [AuditBootstrapService],
})
export class AuditBootstrapModule {}
`,
      "src/audit-di-bootstrap/main.ts": `import { createContainer } from "bazis/core/di";
import { AuditBootstrapDependency } from "./Dependency";
import { AuditBootstrapModule } from "./Module";
import { AuditBootstrapService } from "./Service";

await import("../generated/bazis/targets/audit/bootstrap");
const container = createContainer(AuditBootstrapModule, { validateOnBuild: true });
try {
  const service = container.resolve(AuditBootstrapService);
  console.log(JSON.stringify({ dependency: service.dependency.value, sameDependency: service.dependency === container.resolve(AuditBootstrapDependency) }));
} finally {
  await container.dispose();
}
`,
    });

    const generated = await run(process.execPath, ["run", generator, "--target", "audit"], root);
    expect(generated.exit, generated.stderr).toBe(0);
    expect(generated.stdout).toContain("target=audit");

    const executed = await run(process.execPath, ["run", "src/audit-di-bootstrap/main.ts"], root);
    expect(executed.exit, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toEqual({ dependency: "ready", sameDependency: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
