import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// One CI entry point for any host: run through scripts/osnova-bun so every step
// uses the qualified Bun (process.execPath). Steps stop at the first failure.
// `--live <evidence-dir>` adds the disposable PostgreSQL qualification (Docker).
const usage = "Usage: bun scripts/ci.ts [--live <evidence-dir>]";
const args = process.argv.slice(2);
const live = args[0] === "--live" ? args[1] : undefined;
if (args.length !== 0 && (live === undefined || args.length !== 2)) throw new Error(usage);

const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const results: { step: string; seconds: number }[] = [];

function run(step: string, command: string[], cwd = root): void {
  console.log(`\n[ci] ${step}`);
  const started = performance.now();
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  results.push({ step, seconds: Math.round((performance.now() - started) / 100) / 10 });
  if (result.exitCode !== 0) {
    console.error(`[ci] FAIL: ${step} (exit ${result.exitCode ?? "signal"})`);
    process.exit(result.exitCode || 1);
  }
}

function generatedIsCurrent(): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--", "src/generated"], { cwd: root, stdout: "pipe" });
  const changed = status.stdout.toString().trim();
  if (status.exitCode !== 0 || changed) {
    console.error(`[ci] FAIL: committed codegen output is stale\n${changed}`);
    process.exit(1);
  }
}

run("toolchain", [bun, "run", "toolchain:check"]);
run("codegen", [bun, "run", "di:generate", "--target", "all"]);
generatedIsCurrent();
run("typecheck", [bun, "node_modules/typescript/bin/tsc", "--noEmit"]);
run("tests", [bun, "run", "test"]);
run("admin-ui", [bun, "run", "admin:ui:check"]);
run("client-ui", [bun, "run", "client:ui:build"]);
run("binaries", [bun, "run", "build:bin"]);

// Binaries must work without the source tree: run them from an empty directory.
const outside = mkdtempSync(join(tmpdir(), "osnova-ci-bin-"));
try {
  run("app binary config", [join(root, "bin/osnova-app"), "config", "check", "--environment=test"], outside);
  run("cli binary", [join(root, "bin/osnova"), "--help"], outside);
} finally {
  rmSync(outside, { recursive: true, force: true });
}

run("package", [bun, "run", "scripts/package-check.ts"]);

if (live !== undefined) run("live PostgreSQL", ["python3", "ops/live-postgres/runner.py", resolve(live)]);

console.log("\n[ci] PASS");
for (const { step, seconds } of results) console.log(`  ${step.padEnd(20)} ${seconds}s`);
