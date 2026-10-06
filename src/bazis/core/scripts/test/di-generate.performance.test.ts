import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const APPROVED_BUDGET = (baselineMs: number): number => Math.max(baselineMs * 0.3, 1_000);

/**
 * Recorded baseline method: run `bun run di:generate` on a warm checkout and
 * retain the emitted totalMs. The gate intentionally tests metric shape and a
 * relative synthetic model, not an unstable absolute wall clock.
 */
test("codegen emits the approved timing and count fields", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/bazis/core/scripts/di-generate.ts", "--target", "all"], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  });
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exit).toBe(0);
  const summary = output.split("\n").find((line) => line.includes("programFactories=1"));
  expect(summary).toBeDefined();
  for (const field of ["configMs", "programMs", "discoveryMs", "analysisMs", "targetMs", "renderMs", "writeMs", "totalMs", "programSources", "eligible", "candidates", "outputs"]) {
    expect(summary).toMatch(new RegExp(`${field}=`));
  }
}, 60_000);

test("approved warm-run budget is relative", () => {
  expect(APPROVED_BUDGET(100)).toBe(1_000);
  expect(APPROVED_BUDGET(10_000)).toBe(3_000);
});

function metric(summary: string, name: string): number {
  const value = new RegExp(`${name}=([0-9]+(?:\\.[0-9]+)?)`).exec(summary)?.[1];
  if (value === undefined) throw new Error(`missing ${name} metric`);
  return Number(value);
}

test("actual synthetic small and large projects remain near-linear within the documented warm-run budget", async () => {
  const generator = path.resolve("src/bazis/core/scripts/di-generate.ts");
  const runProject = async (count: number): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), `bazis-codegen-performance-${count}-`));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"],
      }));
      await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({
        version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } },
      }));
      const classes = Array.from({ length: count }, (_, index) => `export class Candidate${index} { constructor(readonly dependency: Dependency) {} }`).join("\n");
      await Bun.write(path.join(root, "src/index.ts"), `export class Dependency {}\n${classes}\n`);
      const run = async (): Promise<string> => {
        const child = Bun.spawn([process.execPath, "run", generator], { cwd: root, stdout: "pipe", stderr: "pipe" });
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit, `${stdout}${stderr}`).toBe(0);
        const summary = `${stdout}${stderr}`.split("\n").find((line) => line.includes("programFactories=1"));
        expect(summary).toBeDefined();
        return summary as string;
      };
      await run(); // warm the synthetic project's own generated outputs
      return await run();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const small = await runProject(40);
  const large = await runProject(80);
  const smallTotal = metric(small, "totalMs");
  const largeTotal = metric(large, "totalMs");
  const smallCandidates = metric(small, "candidates");
  const largeCandidates = metric(large, "candidates");
  expect(smallCandidates).toBe(40);
  expect(largeCandidates).toBe(80);
  const growthLimit = smallTotal * 2 + APPROVED_BUDGET(smallTotal);
  console.log(`[di:generate performance baseline] smallCandidates=${smallCandidates} smallTotalMs=${smallTotal.toFixed(1)} largeCandidates=${largeCandidates} largeTotalMs=${largeTotal.toFixed(1)} growthLimitMs=${growthLimit.toFixed(1)}`);
  expect(largeTotal).toBeLessThanOrEqual(growthLimit);
}, 45_000);
