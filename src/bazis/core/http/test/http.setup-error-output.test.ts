import { expect, test } from "bun:test";
import { KernelError } from "../../kernel";
import { HttpSetupError } from "../Errors/HttpError";

// 0.100.8: a broken route is a configuration error of the code. On 0.100.7 it
// printed as "[bazis] application failed: HttpSetupError: …", like a database
// that is down.

test("HttpSetupError is a KernelError", () => {
  expect(new HttpSetupError("x")).toBeInstanceOf(KernelError);
  expect(new HttpSetupError("x").name).toBe("HttpSetupError");
});

test("a duplicate route stops the start as a configuration error", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/duplicateRoute.fixture.ts`], { stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).toBe(1);
  expect(stderr).toContain("[bazis] configuration error: Duplicate route: GET /orders is mapped to both OrdersController.list");
  expect(stderr).not.toContain("application failed");
});
