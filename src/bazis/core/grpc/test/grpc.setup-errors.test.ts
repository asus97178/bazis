import { expect, test } from "bun:test";
import { KernelError } from "../../kernel";
import { GrpcSetupError } from "../index";

// 0.112.0: a gRPC controller that does not map every RPC stopped the start
// with a TypeError, a source frame and a Bun banner. It is a configuration
// error of the code and prints as one line, like a duplicate HTTP route.
test("GrpcSetupError is a KernelError", () => {
  expect(new GrpcSetupError("x")).toBeInstanceOf(KernelError);
  expect(new GrpcSetupError("x").name).toBe("GrpcSetupError");
});

test("an RPC without @GrpcMethod stops the start as one configuration-error line", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/missingMethod.fixture.ts`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).toBe(1);
  expect(stderr).toContain("[bazis] configuration error: HalfEchoController: RPC Expand is missing @GrpcMethod().");
  expect(stderr).not.toContain("Bun v");
});
