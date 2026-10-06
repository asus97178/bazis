import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Consumer view of the published package: pack src/bazis, install the tarball
// into an empty project, create an app with the installed `bazis` CLI and run it.
// Fails if the tarball carries tests or the installed package cannot build an app.
const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const work = mkdtempSync(join(tmpdir(), "bazis-package-check-"));

function run(step: string, command: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    console.error(`[package] FAIL: ${step}\n${output}`);
    throw new Error(step);
  }
  console.log(`[package] ${step}`);
  return output;
}

let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  run("pack", [bun, "pm", "pack", "--ignore-scripts", "--destination", work], join(root, "src/bazis"));
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pack produced no tarball");
  const listing = run("list tarball", ["tar", "-tzf", join(work, tarball)], work).split("\n");
  const leaked = listing.filter((entry) => /\/test\/|\.(test|spec)\.ts$/.test(entry));
  if (leaked.length > 0) throw new Error(`tarball contains test files: ${leaked.slice(0, 5).join(", ")}`);

  const consumer = join(work, "consumer");
  run("create consumer", ["mkdir", consumer], work);
  writeFileSync(join(consumer, "package.json"), '{ "name": "consumer", "private": true, "type": "module" }\n');
  run("install tarball", [bun, "add", join(work, tarball)], consumer);
  run("import bazis", [bun, "-e", 'const m = await import("bazis/core/di"); if (typeof m.createContainer !== "function") process.exit(1);'], consumer);
  // --vendor: the app must use the package packed above, not the npm release.
  run("bazis new", [join(consumer, "node_modules/.bin/bazis"), "new", "Demo", "--vendor"], consumer);

  const app = join(consumer, "demo");
  run("app install", [bun, "install"], app);
  const bazis = join(app, "node_modules/.bin/bazis");
  run("bazis codegen", [bazis, "codegen"], app);
  run("bazis g module --empty", [bazis, "g", "module", "Task", "--empty"], app);
  // An app service that depends on framework classes: codegen must wire them
  // from the installed package, not drop the registration as unknown.
  const probe = join(app, "src/app/modules/probe");
  mkdirSync(probe, { recursive: true });
  writeFileSync(join(probe, "Probe.service.ts"), [
    'import { Environment, HealthService } from "bazis/core/kernel";',
    "export class ProbeService {",
    "  constructor(private readonly environment: Environment, private readonly health: HealthService) {}",
    "  async describe() { return { environment: this.environment.name, healthy: (await this.health.check()).healthy }; }",
    "}", "",
  ].join("\n"));
  writeFileSync(join(probe, "Probe.controller.ts"), [
    'import { Controller, Get, Post } from "bazis/core/http";',
    'import { ProbeService } from "./Probe.service";',
    "export class ProbeRequest { name = \"\"; }",
    '@Controller("probe")',
    "export class ProbeController {",
    "  constructor(private readonly probe: ProbeService) {}",
    "  @Get() describe() { return this.probe.describe(); }",
    "  @Post() echo(body: ProbeRequest) { return body; }",
    "}", "",
  ].join("\n"));
  // The lazy loader must find the project's src/generated from node_modules/bazis
  // (it used to look next to the framework sources only and silently did nothing).
  writeFileSync(join(app, "src/app/test/generated-runtime.test.ts"), [
    'import { expect, test } from "bun:test";',
    'import { loadBazisGeneratedRuntime } from "bazis/core/generatedRuntime";',
    'import { getGeneratedOpenApiMetadata } from "bazis/core/http/OpenApi/generatedOpenApiRegistry";',
    'test("installed bazis loads the project generated runtime lazily", async () => {',
    "  await loadBazisGeneratedRuntime();",
    '  expect(Object.keys(getGeneratedOpenApiMetadata().schemas)).toContain("ProbeRequest");',
    "});", "",
  ].join("\n"));
  writeFileSync(join(probe, "Probe.module.ts"), [
    'import { Module, singleton } from "bazis/core/di";',
    'import { ProbeController } from "./Probe.controller";',
    'import { ProbeService } from "./Probe.service";',
    "@Module({ providers: [singleton(ProbeService)], controllers: [ProbeController], exports: [] })",
    "export class ProbeModule {}", "",
  ].join("\n"));
  const appModule = join(app, "src/app/modules/App.module.ts");
  writeFileSync(appModule, `import { ProbeModule } from "./probe/Probe.module";\n${readFileSync(appModule, "utf8").replace("imports: [", "imports: [ProbeModule, ")}`);
  run("bazis test (codegen + template /health test)", [bazis, "test"], app);
  run("bazis build (codegen + typecheck)", [bazis, "build"], app);
  run("bazis build --bin", [bazis, "build", "--bin"], app);
  if (readdirSync(app).some((name) => name.endsWith(".bun-build"))) throw new Error("bazis build --bin left .bun-build files in the project");

  // The same app from source (`bazis dev`) and as the compiled executable.
  for (const [label, command] of [["bazis dev", [bazis, "dev"]], ["binary", [join(app, "bin/demo")]]] as const) {
    const port = String(39000 + Math.floor(Math.random() * 900));
    server = Bun.spawn([...command], { cwd: app, env: { ...process.env, PORT: port }, stdout: "ignore", stderr: "ignore" });
    let healthy = false;
    for (let attempt = 0; attempt < 100 && !healthy; attempt++) {
      await Bun.sleep(200);
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
    }
    if (!healthy) throw new Error(`${label}: app did not answer /health`);
    const described = await fetch(`http://127.0.0.1:${port}/probe`).then((response) => response.ok ? response.json() : undefined, () => undefined) as { environment?: unknown; healthy?: unknown } | undefined;
    if (typeof described?.environment !== "string" || described.healthy !== true) throw new Error(`${label}: framework classes were not injected into an app service: ${JSON.stringify(described)}`);
    console.log(`[package] ${label}: /health 200, app service received framework dependencies`);
    server.kill("SIGTERM");
    if (await server.exited !== 0 && label === "bazis dev") throw new Error("bazis dev did not stop cleanly on SIGTERM");
    server = undefined;
  }
  // --full needs a cache and a database to run, so it is built, not started.
  run("bazis new Full", [join(consumer, "node_modules/.bin/bazis"), "new", "Full", "--vendor"], consumer);
  const full = join(consumer, "full");
  run("full install", [bun, "install"], full);
  run("bazis g module --full (no host auth)", [join(full, "node_modules/.bin/bazis"), "g", "module", "Report", "--full"], full);
  run("full bazis build", [join(full, "node_modules/.bin/bazis"), "build"], full);
  console.log(`[package] PASS ${tarball} (${listing.filter(Boolean).length} entries)`);
} finally {
  server?.kill();
  await server?.exited;
  rmSync(work, { recursive: true, force: true });
}
