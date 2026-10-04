import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `bun build --compile` clones the running Bun executable into a temporary
// `.<hash>.bun-build` file in its working directory. Under scripts/osnova-bun
// that executable carries the `uchg` flag, the clone inherits it and Bun cannot
// unlink it, leaving ~60 MB per build. Compiling from a private directory keeps
// the clone out of the repository; the directory is removed after the build.
const usage = "Usage: bun scripts/build-bin.ts <entrypoint> <outfile>";
const [entry, outfile, ...rest] = process.argv.slice(2);
if (entry === undefined || outfile === undefined || rest.length > 0) throw new Error(usage);

const workDir = mkdtempSync(join(tmpdir(), "osnova-compile-"));
let exitCode = 1;
try {
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", resolve(entry), "--outfile", resolve(outfile)],
    { cwd: workDir, stdout: "inherit", stderr: "inherit" },
  );
  exitCode = result.exitCode ?? 1;
} finally {
  if (existsSync("/usr/bin/chflags")) Bun.spawnSync(["/usr/bin/chflags", "-R", "nouchg", workDir]);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    // The binary itself is complete; report the leftover without failing the build.
    console.error(`[build-bin] temporary directory was not removed: ${workDir}`, error);
  }
}
process.exit(exitCode);
