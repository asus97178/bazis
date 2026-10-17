import { expect, test } from "bun:test";

// 0.100.8: a start that fails while an onInit hook hangs names the hook and the
// reason. On 0.100.7 the rollback waited for the hook and printed only
// "Graceful shutdown did not finish within …ms. Forcing exit.".

async function run(mode: "timeout" | "signal"): Promise<{ exit: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/kernel.hung-oninit.fixture.ts`, mode], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { exit, stderr };
}

test("startup timeout during a hung onInit names the hook, then forces exit", async () => {
  const { exit, stderr } = await run("timeout");
  expect(exit).toBe(1);
  expect(stderr).toContain("[bazis] application failed: StartupTimeoutError: Application startup did not finish within 200ms; still starting: hook HungWarmUp.onInit.");
  expect(stderr).toContain("[bazis] Cleanup after the failed start did not finish within 100ms. Forcing exit.");
  // The limit and the pending hook are in the message; no inspected { timeoutMs, pending } dump.
  expect(stderr).not.toContain("timeoutMs:");
});

test("a shutdown signal during a hung onInit says the start was aborted", async () => {
  const { exit, stderr } = await run("signal");
  expect(exit).toBe(1);
  expect(stderr).toContain("Application startup was aborted by a shutdown request.");
  expect(stderr).toContain("[bazis] Cleanup after the failed start did not finish within 100ms. Forcing exit.");
});
