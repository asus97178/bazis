import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Consumer view of the published package: pack src/osnova, install the tarball
// into an empty project, create an app with the installed `osnv` CLI and run it.
// Fails if the tarball carries tests or the installed package cannot build an app.
const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const work = mkdtempSync(join(tmpdir(), "osnv-package-check-"));

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
  run("pack", [bun, "pm", "pack", "--ignore-scripts", "--destination", work], join(root, "src/osnova"));
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pack produced no tarball");
  const listing = run("list tarball", ["tar", "-tzf", join(work, tarball)], work).split("\n");
  const leaked = listing.filter((entry) => /\/test\/|\.(test|spec)\.ts$/.test(entry));
  if (leaked.length > 0) throw new Error(`tarball contains test files: ${leaked.slice(0, 5).join(", ")}`);

  const consumer = join(work, "consumer");
  run("create consumer", ["mkdir", consumer], work);
  writeFileSync(join(consumer, "package.json"), '{ "name": "consumer", "private": true, "type": "module" }\n');
  run("install tarball", [bun, "add", join(work, tarball)], consumer);
  run("import osnv", [bun, "-e", 'const m = await import("osnv/core/di"); if (typeof m.createContainer !== "function") process.exit(1);'], consumer);
  run("osnv new", [join(consumer, "node_modules/.bin/osnv"), "new", "Demo"], consumer);

  const app = join(consumer, "demo");
  run("app install", [bun, "install"], app);
  const osnv = join(app, "node_modules/.bin/osnv");
  run("osnv codegen", [osnv, "codegen"], app);
  run("osnv g module --empty", [osnv, "g", "module", "Task", "--empty"], app);
  // An app service that depends on framework classes: codegen must wire them
  // from the installed package, not drop the registration as unknown.
  const probe = join(app, "src/app/modules/probe");
  mkdirSync(probe, { recursive: true });
  writeFileSync(join(probe, "Probe.service.ts"), [
    'import { Environment, HealthService } from "osnv/core/kernel";',
    "export class ProbeService {",
    "  constructor(private readonly environment: Environment, private readonly health: HealthService) {}",
    "  async describe() { return { environment: this.environment.name, healthy: (await this.health.check()).healthy }; }",
    "}", "",
  ].join("\n"));
  writeFileSync(join(probe, "Probe.controller.ts"), [
    'import { Controller, Get } from "osnv/core/http";',
    'import { ProbeService } from "./Probe.service";',
    '@Controller("probe")',
    "export class ProbeController {",
    "  constructor(private readonly probe: ProbeService) {}",
    "  @Get() describe() { return this.probe.describe(); }",
    "}", "",
  ].join("\n"));
  writeFileSync(join(probe, "Probe.module.ts"), [
    'import { Module, singleton } from "osnv/core/di";',
    'import { ProbeController } from "./Probe.controller";',
    'import { ProbeService } from "./Probe.service";',
    "@Module({ providers: [singleton(ProbeService)], controllers: [ProbeController], exports: [] })",
    "export class ProbeModule {}", "",
  ].join("\n"));
  const appModule = join(app, "src/app/modules/App.module.ts");
  writeFileSync(appModule, `import { ProbeModule } from "./probe/Probe.module";\n${readFileSync(appModule, "utf8").replace("imports: [", "imports: [ProbeModule, ")}`);
  run("osnv test (codegen + template /health test)", [osnv, "test"], app);
  run("osnv build (codegen + typecheck)", [osnv, "build"], app);
  run("osnv build --bin", [osnv, "build", "--bin"], app);
  if (readdirSync(app).some((name) => name.endsWith(".bun-build"))) throw new Error("osnv build --bin left .bun-build files in the project");

  // The same app from source (`osnv dev`) and as the compiled executable.
  for (const [label, command] of [["osnv dev", [osnv, "dev"]], ["binary", [join(app, "bin/demo")]]] as const) {
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
    if (await server.exited !== 0 && label === "osnv dev") throw new Error("osnv dev did not stop cleanly on SIGTERM");
    server = undefined;
  }
  // --full needs a cache and a database to run, so it is built, not started.
  run("osnv new Full", [join(consumer, "node_modules/.bin/osnv"), "new", "Full"], consumer);
  const full = join(consumer, "full");
  run("full install", [bun, "install"], full);
  run("osnv g module --full (no host auth)", [join(full, "node_modules/.bin/osnv"), "g", "module", "Report", "--full"], full);
  run("full osnv build", [join(full, "node_modules/.bin/osnv"), "build"], full);
  console.log(`[package] PASS ${tarball} (${listing.filter(Boolean).length} entries)`);
} finally {
  server?.kill();
  await server?.exited;
  rmSync(work, { recursive: true, force: true });
}
