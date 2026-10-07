import { existsSync } from "node:fs";
import path from "node:path";

const GENERATOR = "core/scripts/di-generate.ts";

/** Run the framework generator for the project in `cwd`; returns its exit code. */
export async function runCodegen(cwd: string, target?: string): Promise<number> {
  if (target !== undefined) {
    const configFile = Bun.file(path.join(cwd, "bazis.config.json"));
    if (!await configFile.exists()) throw new Error("--target requires bazis.config.json in the current directory.");
    const config = await configFile.json();
    if (target !== "all" && !Object.hasOwn(config.targets ?? {}, target)) throw new Error(`Unknown codegen target: ${target}`);
  }
  const generator = resolveGenerator(cwd);
  // TypeScript 7 has no compiler API: the preload switches it to @typescript/typescript6.
  const preload = path.join(path.dirname(generator), "typescriptApiPreload.ts");
  const args = [await resolveBun(cwd), ...(existsSync(preload) ? ["--preload", preload] : []), generator, ...(target === undefined ? [] : ["--target", target])];
  return await Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
}

/**
 * The generator of the framework this project uses: the installed package,
 * the framework source checkout, or the package this CLI runs from.
 */
export function resolveGenerator(cwd: string): string {
  const candidates = [
    path.join(cwd, "node_modules/bazis", GENERATOR),
    path.join(cwd, "src/bazis", GENERATOR),
    path.resolve(import.meta.dir, "..", GENERATOR),
  ];
  const generator = candidates.find((candidate) => existsSync(candidate));
  if (!generator) throw new Error("bazis code generator not found. Install the framework in this project: bun add bazis");
  return generator;
}

/** Bun for child processes: the project's qualified launcher when present. */
export async function resolveBun(cwd: string): Promise<string> {
  const wrapper = path.join(cwd, "scripts/bazis-bun");
  // process.execPath can be the compiled CLI itself. Never invoke it as Bun.
  const executable = await Bun.file(wrapper).exists() ? wrapper : (process.env.BAZIS_BUN_BIN || Bun.which("bun"));
  if (!executable) throw new Error("Bun was not found. Set BAZIS_BUN_BIN or put Bun on PATH.");
  return executable;
}
