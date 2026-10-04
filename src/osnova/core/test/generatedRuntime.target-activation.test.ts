import { expect, test } from "bun:test";

function runtimeScript(mode: "default" | "test"): string {
  const root = process.cwd().replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const generatedRuntime = `${root}/src/osnova/core/generatedRuntime.ts`;
  const testBootstrap = `${root}/src/generated/osnova/targets/test/bootstrap.ts`;
  return [
    "const seen: string[] = [];",
    "(globalThis as { __osnovaGeneratedRuntimeTestHook?: (target: string) => void }).__osnovaGeneratedRuntimeTestHook = (target) => seen.push(target);",
    mode === "test" ? `await import(${JSON.stringify(testBootstrap)});` : "",
    `const runtime = await import(${JSON.stringify(generatedRuntime)});`,
    "await runtime.loadOsnovaGeneratedRuntime();",
    "console.log(JSON.stringify(seen));",
  ].filter(Boolean).join("\n");
}

async function run(mode: "default" | "test"): Promise<readonly string[]> {
  const child = Bun.spawn([process.execPath, "--eval", runtimeScript(mode)], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout.trim()) as readonly string[];
}

test("default generated runtime activates the production target once", async () => {
  expect(await run("default")).toEqual(["production"]);
});

test("test bootstrap activates its descriptor without evaluating the production runtime", async () => {
  expect(await run("test")).toEqual([]);
});
