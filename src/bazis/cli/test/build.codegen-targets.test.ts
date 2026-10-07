import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBuild, runDev, runTest } from "../build";

// bazis dev/test/build generate every target of bazis.config.json. Before, they
// generated only the default one and a second entrypoint (a worker) kept stale code.
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-codegen-targets-"));
  roots.push(root);
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({
    version: 1, defaultTarget: "production",
    targets: { production: { entrypoints: ["src/index.ts"] }, worker: { entrypoints: ["src/worker.ts"] } },
  }));
  return root;
}

// A failing codegen stops each command before it starts a process.
function recordingCodegen(targets: (string | undefined)[]) {
  return async (_cwd: string, target?: string) => { targets.push(target); return 3; };
}

test("dev, test and build run codegen for all targets", async () => {
  const root = await project();
  const targets: (string | undefined)[] = [];
  expect(await runDev(root, recordingCodegen(targets), () => {})).toBe(3);
  expect(await runTest(root, [], recordingCodegen(targets))).toBe(3);
  expect(await runBuild(root, { bin: false }, recordingCodegen(targets), () => {})).toBe(3);
  expect(targets).toEqual(["all", "all", "all"]);
});
