import { expect, test } from "bun:test";
import { runCli, type CliRuntime } from "../main";
import { parseCliArgs } from "../parseCli";
import { bazisVersion } from "../ui";

function runtime(bun?: CliRuntime["bun"]) {
  const logs: string[] = [];
  const calls: string[] = [];
  const adapter: CliRuntime = {
    log: (message) => logs.push(message), error: (message) => logs.push(message), language: "en",
    codegen: async (cwd) => { calls.push(cwd); return 0; },
    ...(bun ? { bun } : {}),
  };
  return { adapter, logs, calls };
}

test("--version and -v print the package version, with --lang anywhere", async () => {
  expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["codegen", "--version"])).toEqual({ kind: "error", message: "Unknown option: --version" });
  const r = runtime({ version: "1.3.13", path: "/old/bun" });
  expect(await runCli(["--lang", "ru", "--version"], r.adapter)).toBe(0);
  expect(r.logs).toEqual([bazisVersion()]);
  expect(bazisVersion()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("an older Bun stops a command before it runs, naming the Bun and the fix", async () => {
  const r = runtime({ version: "1.3.13", path: "/Users/ann/.bun/bin/bun" });
  expect(await runCli(["codegen"], r.adapter)).toBe(1);
  expect(r.calls).toHaveLength(0);
  // The panel wraps long lines; compare the text without its frame.
  const output = r.logs.join("\n").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
  expect(output).toContain("bazis needs Bun 1.4.0 or newer; this is Bun 1.3.13.");
  expect(output).toContain("This Bun is /Users/ann/.bun/bin/bun. bunx bazis and bun run scripts start bazis with the first bun in PATH, not with the Bun that called them.");
  expect(output).toContain("Update that Bun: bun upgrade. Or put the newer Bun first in PATH.");
});

test("a supported Bun runs the command", async () => {
  const r = runtime({ version: "1.4.0", path: "/usr/local/bin/bun" });
  expect(await runCli(["codegen"], r.adapter)).toBe(0);
  expect(r.calls).toHaveLength(1);
});
