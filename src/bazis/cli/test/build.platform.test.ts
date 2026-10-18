import { expect, test } from "bun:test";
import { compileArgs } from "../build";
import { parseCliArgs } from "../parseCli";

test("build --bin --platform compiles for that platform", () => {
  expect(parseCliArgs(["build", "--bin", "--platform", "linux-x64"])).toEqual({ kind: "build", bin: true, outfile: undefined, dotenv: false, platform: "linux-x64" });
  expect(parseCliArgs(["build", "--bin", "--platform", "linux-arm64-musl"])).toMatchObject({ platform: "linux-arm64-musl" });
  expect(parseCliArgs(["build", "--platform", "linux-x64"])).toEqual({ kind: "error", message: "--platform requires --bin." });
  expect(parseCliArgs(["build", "--bin", "--platform", "solaris"])).toEqual({
    kind: "error",
    message: "Unknown platform: solaris. Use <os>-<arch>[-musl]: linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, darwin-arm64, darwin-x64, windows-x64.",
  });
  expect(parseCliArgs(["codegen", "--platform", "linux-x64"])).toEqual({ kind: "error", message: "--bin, --outfile, --platform and --dotenv are only supported by build." });

  const args = compileArgs("/usr/bin/bun", "src/index.ts", "bin/app-linux-x64", { platform: "linux-x64" });
  expect(args.slice(0, 4)).toEqual(["/usr/bin/bun", "build", "--compile", "--target=bun-linux-x64"]);
  expect(compileArgs("/usr/bin/bun", "src/index.ts", "bin/app", {})).not.toContain("--target=bun-linux-x64");
});
