import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import ts from "typescript";
import { collectTargetReachability, projectPath } from "../di-generate-target";

const GENERATOR = path.resolve("src/osnova/core/scripts/di-generate.ts");

async function temporaryProject(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "osnova-codegen-test-"));
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
  }));
  return root;
}

async function runGenerator(cwd: string, env?: Record<string, string>): Promise<{ readonly exit: number; readonly output: string }> {
  return runGeneratorTarget(cwd, "all", env);
}

async function runGeneratorTarget(cwd: string, target: string, env?: Record<string, string>): Promise<{ readonly exit: number; readonly output: string }> {
  const child = Bun.spawn([process.execPath, "run", GENERATOR, "--target", target], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: `${stdout}${stderr}` };
}

test("codegen declares isolated production and test targets", async () => {
  const config = await Bun.file("osnova.codegen.json").json() as {
    version: number;
    defaultTarget: string;
    targets: Record<string, { entrypoints: string[]; applicationParts?: string[] }>;
  };
  expect(config).toEqual({
    version: 1,
    defaultTarget: "production",
    targets: {
      production: { entrypoints: ["src/index.ts"] },
      test: {
        entrypoints: ["src/osnova/core/http/test/fixtures/conventionControllers.ts"],
      },
    },
  });
});

test("test fixture stays out of production output", async () => {
  const generated = await runGeneratorTarget(process.cwd(), "all");
  expect(generated.exit).toBe(0);
  // Framework packages must not ship the host application's name-based DI map.
  const legacyDeps = await Bun.file("src/osnova/core/di/generated/deps.ts").text();
  expect(legacyDeps).toMatch(/GENERATED_CLASS_DEPS[^=]*=\s*\{\s*\};/);
  expect(generated.output).not.toContain("OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/app/test/fixtures/application-postgres.fixture.ts");
  const channels = ["deps.ts", "bindings.ts", "httpRequestModels.ts", "httpListModels.ts", "openapi.ts", "agentCatalog.ts", "runtime.ts"];
  const paths = [
    ...channels.map((channel) => `src/generated/osnova/${channel}`),
    ...channels.map((channel) => `src/generated/osnova/targets/test/${channel}`),
  ];
  const outputs = await Promise.all(paths.map(async (filePath) => [filePath, await Bun.file(filePath).text()] as const));
  for (const [filePath, content] of outputs) {
    expect(content, filePath).not.toContain("createApplicationPostgresFixture");
    expect(content, filePath).not.toContain("app/test/fixtures/application-postgres.fixture");
  }
}, 30_000);

test("normal test lifecycle generates every target while build stays production-default", async () => {
  const manifest = await Bun.file("package.json").json() as { scripts: Record<string, string> };
  expect(manifest.scripts.pretest).toBe("bun run scripts/bun-toolchain-check.ts && bun run di:generate --target all");
  expect(manifest.scripts.test).toBe(
    "bun run scripts/bun-toolchain-check.ts && bun test --isolate --path-ignore-patterns='**/*.browser.spec.ts' --path-ignore-patterns='**/docs/audits/**' --path-ignore-patterns='**/bin/**'",
  );
  expect(manifest.scripts.prebuild).toBe("bun run di:generate");
  expect(manifest.scripts["prebuild:bin"]).toBe("bun run di:generate");
});

test("all targets share one root Program and the target pipeline emits every channel", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/osnova/core/scripts/di-generate.ts", "--target", "all"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  expect(output).toContain("programFactories=1");
  expect(output).toContain("targets=production,test");
  for (const channel of ["deps.ts", "bindings.ts", "httpRequestModels.ts", "httpListModels.ts", "openapi.ts", "agentCatalog.ts", "runtime.ts"]) {
    expect(await Bun.file(`src/generated/osnova/targets/test/${channel}`).exists()).toBe(true);
  }
  expect(await Bun.file("src/generated/osnova/targets/demo/runtime.ts").exists()).toBe(false);
}, 60_000);

test("removing the provisioning target returns its DI source to fail-closed unassigned diagnostics", async () => {
  const base = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
    "src/provisioning.ts": "export class Provisioner { constructor(private readonly authority: IAuthority) {} }\n",
  };
  const assigned = await temporaryProject({
    ...base,
    "osnova.codegen.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] }, "provisioning": { entrypoints: ["src/provisioning.ts"] } } }),
    "src/index.ts": "export const application = true;\n",
  });
  const unassigned = await temporaryProject({
    ...base,
    "osnova.codegen.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    "src/index.ts": "export const application = true;\n",
  });
  try {
    expect((await runGeneratorTarget(assigned, "all")).exit).toBe(0);
    const rejected = await runGeneratorTarget(unassigned, "all");
    expect(rejected.exit).not.toBe(0);
    expect(rejected.output).toContain("OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/provisioning.ts");
  } finally {
    await Promise.all([rm(assigned, { recursive: true, force: true }), rm(unassigned, { recursive: true, force: true })]);
  }
}, 30_000);

test("a generic third target receives only its static reachable application slice", async () => {
  const root = path.join("/private/tmp", `osnova-codegen-third-${crypto.randomUUID()}`);
  const third = path.join(root, "third.ts");
  const feature = path.join(root, "feature.ts");
  const other = path.join(root, "other.ts");
  await mkdir(root, { recursive: true });
  await Bun.write(third, 'export { feature } from "./feature";\n');
  await Bun.write(feature, 'export const feature = "third";\n');
  await Bun.write(other, 'export const other = "unreached";\n');
  const program = ts.createProgram([third, feature, other], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext });
  const files = new Map(program.getSourceFiles().filter((source) => source.fileName.startsWith(root)).map((source) => [projectPath(source.fileName), source]));
  const reached = collectTargetReachability(program, files, [projectPath(third)]);
  expect(reached).toEqual(new Set([projectPath(third), projectPath(feature)]));
});

test("fails closed from the shared candidate index for real DI, HTTP, Agent and Module markers", async () => {
  const root = await temporaryProject({
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", experimentalDecorators: true }, include: ["src/**/*.ts"] }),
    "osnova.codegen.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    "src/index.ts": "export const root = true;\n",
    "src/z-agent.ts": "@Agent() export class AgentSource {}\n@Tool() export class ToolSource {}\n@Prompt() export class PromptSource {}\n",
    "src/c-controller.ts": "@Controller(\"items\") export class ControllerSource {}\n",
    "src/d-di.ts": "export class DiSource { constructor(private readonly widget: IWidget) {} }\n",
    "src/m-module.ts": "@Module({ providers: [] }) export class FeatureModule {}\n",
    "src/a-request.ts": "@RequestModel() export class RequestSource {}\n",
    "src/b-list.ts": "export class ListSource extends ListRequest {}\n",
    "src/generated/osnova/sentinel.ts": "untouched\n",
  });
  try {
    const result = await runGenerator(root);
    expect(result.exit).not.toBe(0);
    const diagnostics = result.output.split("\n").filter((line) => line.includes("OSNOVA_CODEGEN_SOURCE_UNASSIGNED")).map((line) => line.replace(/^error: /, ""));
    expect(diagnostics).toEqual([
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/a-request.ts",
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/b-list.ts",
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/c-controller.ts",
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/d-di.ts",
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/m-module.ts",
      "OSNOVA_CODEGEN_SOURCE_UNASSIGNED: src/z-agent.ts",
    ]);
    expect(await Bun.file(path.join(root, "src/generated/osnova/sentinel.ts")).text()).toBe("untouched\n");
    expect(await Bun.file(path.join(root, "src/generated/osnova/deps.ts")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared application parts are reached by two targets without target ambiguity", async () => {
  const root = await temporaryProject({
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
    "src/shared.ts": "export class SharedPart {}\n",
    "src/production.ts": "export { SharedPart } from './shared';\n",
    "src/secondary.ts": "export { SharedPart } from './shared';\n",
  });
  try {
    const program = ts.createProgram([path.join(root, "src/production.ts"), path.join(root, "src/secondary.ts"), path.join(root, "src/shared.ts")], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext });
    const files = new Map(program.getSourceFiles().filter((source) => source.fileName.startsWith(root)).map((source) => [projectPath(source.fileName), source]));
    const production = collectTargetReachability(program, files, [projectPath(path.join(root, "src/production.ts"))]);
    const secondary = collectTargetReachability(program, files, [projectPath(path.join(root, "src/secondary.ts"))]);
    expect(production.has(projectPath(path.join(root, "src/shared.ts")))).toBe(true);
    expect(secondary.has(projectPath(path.join(root, "src/shared.ts")))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports deterministic dynamic-edge locations and leaves outputs untouched", async () => {
  const root = await temporaryProject({
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
    "osnova.codegen.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    "src/index.ts": "const second = name;\nimport(second);\nconst first = name;\nimport(first);\n",
  });
  try {
    const result = await runGenerator(root);
    expect(result.exit).not.toBe(0);
    expect(result.output.split("\n").filter((line) => line.includes("OSNOVA_CODEGEN_DYNAMIC_EDGE_UNRESOLVED")).map((line) => line.replace(/^error: /, ""))).toEqual([
      "OSNOVA_CODEGEN_DYNAMIC_EDGE_UNRESOLVED: production:src/index.ts:2",
      "OSNOVA_CODEGEN_DYNAMIC_EDGE_UNRESOLVED: production:src/index.ts:4",
    ]);
    expect(await Bun.file(path.join(root, "src/generated/osnova/deps.ts")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disk transaction restores backups, removes newly-created finals and cleans staging after injected rename failure", async () => {
  const root = await temporaryProject({
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
    "osnova.codegen.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    "src/index.ts": "export const root = true;\n",
    "src/generated/osnova/deps.ts": "previous-deps\n",
  });
  try {
    const result = await runGenerator(root, { OSNOVA_CODEGEN_TEST_FAIL_RENAME_AT: "4" });
    expect(result.exit).not.toBe(0);
    expect(result.output).toContain("OSNOVA_CODEGEN_TEST_RENAME_FAILURE:4");
    expect(await Bun.file(path.join(root, "src/generated/osnova/deps.ts")).text()).toBe("previous-deps\n");
    expect(await Bun.file(path.join(root, "src/generated/osnova/bindings.ts")).exists()).toBe(false);
    expect((await readdir(root)).filter((name) => name.startsWith(".osnova-codegen-stage-"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
