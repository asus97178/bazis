import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const launcher = resolve(repo, "scripts/osnova-bun");
const fixture = resolve(import.meta.dir, "fixtures/osnova-bun.shutdown.fixture.ts");

async function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture deadline exceeded")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function shutdown(cleanupMs: number, timeoutMs?: string) {
  const child = Bun.spawn(["/bin/sh", launcher, "--no-env-file", fixture, String(cleanupMs)], {
    cwd: repo,
    env: { OSNV_BUN_BIN: process.execPath, ...(timeoutMs === undefined ? {} : { OSNV_BUN_SHUTDOWN_TIMEOUT_MS: timeoutMs }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const ready = Promise.withResolvers<{ pid: number; executable: string }>();
  const output = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      const line = text.split("\n")[0];
      if (line?.endsWith("}")) ready.resolve(JSON.parse(line));
    }
    return text;
  })();
  const errors = new Response(child.stderr).text();
  let ownedPid: number | undefined;
  try {
    const info = await within(Promise.race([
      ready.promise,
      child.exited.then(async (code) => { throw new Error(`fixture exited before ready: ${code}: ${await errors}`); }),
    ]), 10_000);
    ownedPid = info.pid;
    const started = performance.now();
    child.kill("SIGTERM");
    const exitCode = await within(child.exited, 18_000);
    const elapsedMs = performance.now() - started;
    return { exitCode, elapsedMs, stdout: await output, stderr: await errors, cleaned: !existsSync(dirname(info.executable)) };
  } finally {
    if (child.exitCode === null) {
      if (ownedPid !== undefined) { try { process.kill(ownedPid, "SIGKILL"); } catch {} }
      child.kill("SIGTERM");
      await within(child.exited, 2_000);
    }
  }
}

test("launcher default grace permits the kernel's ten-second shutdown budget", async () => {
  const result = await shutdown(10_500);
  expect(result.stdout).toContain("CLEANUP_STARTED");
  expect(result.stdout).toContain("CLEANUP_FINISHED");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
  expect(result.exitCode).toBe(143);
  expect(result.cleaned).toBe(true);
}, 30_000);

test("launcher honors an explicit shutdown budget longer than 500ms", async () => {
  const result = await shutdown(1_100, "2000");
  expect(result.stdout).toContain("CLEANUP_FINISHED");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(1_000);
  expect(result.elapsedMs).toBeLessThan(4_000);
  expect(result.exitCode).toBe(143);
  expect(result.cleaned).toBe(true);
}, 15_000);

test("launcher still terminates a hung child after its configured budget", async () => {
  const result = await shutdown(-1, "800");
  expect(result.stdout).toContain("CLEANUP_STARTED");
  expect(result.stdout).not.toContain("CLEANUP_FINISHED");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(750);
  expect(result.elapsedMs).toBeLessThan(3_000);
  expect(result.exitCode).toBe(143);
  expect(result.cleaned).toBe(true);
}, 15_000);

test.each(["0", "-1", "1.5", "2147483648", "999999999999999999999999"])("launcher rejects invalid shutdown budget %s", (timeoutMs) => {
  const result = Bun.spawnSync(["/bin/sh", launcher, "--no-env-file", "-e", "process.exit(0)"], {
    cwd: repo,
    env: { OSNV_BUN_BIN: process.execPath, OSNV_BUN_SHUTDOWN_TIMEOUT_MS: timeoutMs },
  });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("OSNV_BUN_SHUTDOWN_TIMEOUT_INVALID");
});
