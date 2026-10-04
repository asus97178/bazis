import path from "node:path";

/** Run the host's existing generator, including its toolchain checks. */
export async function runCodegen(cwd: string, target?: string): Promise<number> {
  const packageFile = Bun.file(path.join(cwd, "package.json"));
  if (!await packageFile.exists()) throw new Error("codegen requires a project package.json in the current directory.");
  const manifest = await packageFile.json();
  if (typeof manifest.scripts?.["di:generate"] !== "string" || !manifest.scripts["di:generate"].trim()) {
    throw new Error("Project has no di:generate script. Add it or generate with --no-codegen.");
  }
  if (target !== undefined) {
    const configFile = Bun.file(path.join(cwd, "osnova.codegen.json"));
    if (!await configFile.exists()) throw new Error("--target requires osnova.codegen.json in the current directory.");
    const config = await configFile.json();
    if (target !== "all" && !Object.hasOwn(config.targets ?? {}, target)) throw new Error(`Unknown codegen target: ${target}`);
  }
  const args = [await resolveBun(cwd), "run", "di:generate", ...(target === undefined ? [] : ["--target", target])];
  return await Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
}

/** Bun for child processes: the project's qualified launcher when present. */
export async function resolveBun(cwd: string): Promise<string> {
  const wrapper = path.join(cwd, "scripts/osnova-bun");
  // process.execPath can be the compiled CLI itself. Never invoke it as Bun.
  const executable = await Bun.file(wrapper).exists() ? wrapper : (process.env.OSNOVA_BUN_BIN || Bun.which("bun"));
  if (!executable) throw new Error("Bun was not found. Set OSNOVA_BUN_BIN or put Bun on PATH.");
  return executable;
}
