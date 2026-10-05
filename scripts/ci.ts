import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// One CI entry point for any host: run through scripts/osnv-bun so every step
// uses the qualified Bun (process.execPath). Steps stop at the first failure.
// `--live <evidence-dir>` adds the disposable PostgreSQL qualification (Docker).
const usage = "Usage: bun scripts/ci.ts [--live <evidence-dir>]";
const args = process.argv.slice(2);
const live = args[0] === "--live" ? args[1] : undefined;
if (args.length !== 0 && (live === undefined || args.length !== 2)) throw new Error(usage);

const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const results: { step: string; seconds: number }[] = [];

function run(step: string, command: string[], cwd = root, env: Record<string, string | undefined> = process.env): void {
  console.log(`\n[ci] ${step}`);
  const started = performance.now();
  const result = Bun.spawnSync(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
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
run("cli binary build", [bun, "run", "build:bin"]);

// Binaries must work without the source tree: run them from an empty directory.
const outside = mkdtempSync(join(tmpdir(), "osnv-ci-bin-"));
try {
  run("cli binary", [join(root, "bin/osnv"), "--help"], outside);
} finally {
  rmSync(outside, { recursive: true, force: true });
}

run("package", [bun, "run", "scripts/package-check.ts"]);

// examples/todo as a user would build it (its e2e test needs OSNV_DB__HOST, else it is skipped).
const example = join(root, "examples/todo");
const exampleEnv = { ...process.env, OSNV_BUN_BIN: bun };
const exampleCli = join(example, "node_modules/osnv/cli/main.ts");
run("example install", [bun, "install", "--frozen-lockfile"], example, exampleEnv);
run("example build", [bun, exampleCli, "build", "--bin"], example, exampleEnv);
run("example test", [bun, exampleCli, "test"], example, exampleEnv);

if (live !== undefined) run("live PostgreSQL", ["python3", "ops/live-postgres/runner.py", resolve(live)]);

console.log("\n[ci] PASS");
for (const { step, seconds } of results) console.log(`  ${step.padEnd(20)} ${seconds}s`);
