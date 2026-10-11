import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileBinary } from "../build";

// A Bun executable reads bunfig.toml and .env from the directory it starts in
// unless the compile turns that off; compileBinary must turn it off.
test("a compiled binary ignores bunfig.toml and .env in its working directory unless dotenv is on", async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "bazis-compile-autoload-"));
  try {
    const entry = path.join(root, "entry.ts");
    await writeFile(entry, `console.log(JSON.stringify({ value: process.env.BAZIS_PROBE ?? null, preload: (globalThis as { preloaded?: boolean }).preloaded === true }));\n`);
    const strict = path.join(root, "strict");
    const dotenv = path.join(root, "dotenv");
    expect(compileBinary(process.execPath, entry, strict)).toBe(0);
    expect(compileBinary(process.execPath, entry, dotenv, { dotenv: true })).toBe(0);

    const workDir = path.join(root, "run");
    await mkdir(workDir);
    await writeFile(path.join(workDir, ".env"), "BAZIS_PROBE=from-dotenv\n");
    await writeFile(path.join(workDir, "pre.ts"), "(globalThis as { preloaded?: boolean }).preloaded = true;\n");
    await writeFile(path.join(workDir, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
    const env = { ...process.env };
    delete env.BAZIS_PROBE;
    const run = async (binary: string) => {
      const child = Bun.spawn([binary], { cwd: workDir, env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout.trim()) as { value: string | null; preload: boolean };
    };

    expect(await run(strict)).toEqual({ value: null, preload: false });
    expect(await run(dotenv)).toEqual({ value: "from-dotenv", preload: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
