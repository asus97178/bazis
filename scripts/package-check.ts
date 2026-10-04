import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  run("app codegen", [bun, "run", "di:generate"], app);
  run("app module", [bun, "run", "osnova", "g", "module", "Task", "--empty"], app);
  run("app typecheck", [bun, "run", "build"], app);

  const port = String(39000 + Math.floor(Math.random() * 900));
  server = Bun.spawn([bun, "run", "src/index.ts"], { cwd: app, env: { ...process.env, PORT: port }, stdout: "ignore", stderr: "ignore" });
  let healthy = false;
  for (let attempt = 0; attempt < 50 && !healthy; attempt++) {
    await Bun.sleep(200);
    healthy = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
  }
  if (!healthy) throw new Error("generated app did not answer /health");
  console.log("[package] app /health 200");
  console.log(`[package] PASS ${tarball} (${listing.filter(Boolean).length} entries)`);
} finally {
  server?.kill();
  await server?.exited;
  rmSync(work, { recursive: true, force: true });
}
