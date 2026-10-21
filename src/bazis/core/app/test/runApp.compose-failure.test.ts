import { expect, test } from "bun:test";

// 0.110.1: a configuration error found while runApp composed the application
// escaped as an unhandled exception with a source frame and a Bun banner, while
// the same error from the kernel build printed one line.
test("a configuration error while composing the app is one line and exit code 1", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/composeFailure.fixture.ts`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).toBe(1);
  expect(stderr).toContain("[bazis] configuration error: ReportsController.bug has both @AllowAnonymous() and @Authorize(...)");
  expect(stderr).not.toContain("Bun v");
  expect(stderr).not.toMatch(/^\s+at /m);
});
