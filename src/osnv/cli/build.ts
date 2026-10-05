import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveBun } from "./codegen";

type Codegen = (cwd: string, target?: string) => Promise<number>;

export interface BuildOptions {
  /** Also compile the entrypoint into a standalone executable. */
  readonly bin: boolean;
  /** Executable path relative to the project; default `bin/<package name>`. */
  readonly outfile?: string;
}

/**
 * `osnv dev`: codegen, then run the default target's entrypoint from source.
 * With `watch`, a change under src/ (except src/generated) stops the app,
 * reruns codegen and starts it again; a failed codegen waits for the next change.
 * The app runs as `development` unless OSNV_ENV is set in the shell.
 */
/** `osnv dev` means development; an OSNV_ENV from the shell still wins. */
export function devEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, OSNV_ENV: env.OSNV_ENV || "development" };
}

export async function runDev(cwd: string, codegen: Codegen, log: (message: string) => void, options: { readonly watch?: boolean } = {}): Promise<number> {
  const bun = await resolveBun(cwd);
  const entry = await projectEntry(cwd);
  const env = devEnvironment(process.env);
  if (!options.watch) {
    const generated = await codegen(cwd);
    if (generated !== 0) return generated;
    const child = Bun.spawn([bun, "run", entry], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    // The app owns graceful shutdown; forward the signal instead of dying first.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInterrupt = forward("SIGINT"), onTerminate = forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    try {
      return await child.exited;
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }

  let child: ReturnType<typeof Bun.spawn> | undefined;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    if (!child) return;
    const running = child;
    child = undefined;
    running.kill("SIGTERM");
    await running.exited;
  };
  const start = async () => {
    if (await codegen(cwd) !== 0) { log("[osnv] codegen failed; waiting for changes..."); return; }
    child = Bun.spawn([bun, "run", entry], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  };
  const watcher = watch(path.join(cwd, "src"), { recursive: true }, (_event, file) => {
    // codegen writes src/generated: watching it would restart forever.
    if (!file || /^generated([\\/]|$)/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(async () => { log(`[osnv] ${file} changed, restarting...`); await stop(); await start(); });
    }, 150);
  });
  const finished = Promise.withResolvers<number>();
  const shutdown = () => {
    watcher.close();
    clearTimeout(timer);
    queue = queue.then(stop).then(() => finished.resolve(0), () => finished.resolve(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  log("[osnv] watching src/ for changes (Ctrl+C to stop)");
  queue = queue.then(start);
  try {
    return await finished.promise;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

/** `osnv test [args]`: codegen, then `bun test` with the given arguments. */
export async function runTest(cwd: string, args: readonly string[], codegen: Codegen): Promise<number> {
  const generated = await codegen(cwd);
  if (generated !== 0) return generated;
  return await Bun.spawn([await resolveBun(cwd), "test", ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

/** `osnv build [--bin]`: codegen and typecheck; with `bin`, also compile. */
export async function runBuild(cwd: string, options: BuildOptions, codegen: Codegen, log: (message: string) => void): Promise<number> {
  const generated = await codegen(cwd);
  if (generated !== 0) return generated;
  const bun = await resolveBun(cwd);
  const tsc = path.join(cwd, "node_modules/typescript/bin/tsc");
  if (!existsSync(tsc)) throw new Error("TypeScript is not installed in this project. Run: bun add -d typescript");
  log("[osnv] typecheck...");
  const typecheck = await Bun.spawn([bun, tsc, "--noEmit"], { cwd, stdout: "inherit", stderr: "inherit" }).exited;
  if (typecheck !== 0 || !options.bin) return typecheck;
  const outfile = path.resolve(cwd, options.outfile ?? path.join("bin", await binaryName(cwd)));
  log(`[osnv] compile ${path.relative(cwd, outfile)}...`);
  return compileBinary(bun, await projectEntry(cwd), outfile);
}

/**
 * `bun build --compile` clones the running Bun executable into a temporary
 * `.<hash>.bun-build` file in its working directory and cannot remove it when
 * that executable is read-only or carries `uchg` (scripts/osnv-bun). Compile
 * from a private directory and remove it afterwards.
 */
export function compileBinary(bun: string, entry: string, outfile: string): number {
  const workDir = mkdtempSync(path.join(tmpdir(), "osnv-compile-"));
  try {
    const result = Bun.spawnSync([bun, "build", "--compile", path.resolve(entry), "--outfile", path.resolve(outfile)],
      { cwd: workDir, stdout: "inherit", stderr: "inherit" });
    return result.exitCode ?? 1;
  } finally {
    if (existsSync("/usr/bin/chflags")) Bun.spawnSync(["/usr/bin/chflags", "-R", "nouchg", workDir]);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (error) {
      // The binary itself is complete; report the leftover without failing the build.
      console.error(`[osnv] temporary directory was not removed: ${workDir}`, error);
    }
  }
}

async function projectEntry(cwd: string): Promise<string> {
  const configFile = Bun.file(path.join(cwd, "osnv.config.json"));
  if (!await configFile.exists()) throw new Error("osnv.config.json not found in the current directory.");
  const config = await configFile.json() as { defaultTarget?: string; targets?: Record<string, { entrypoints?: unknown }> };
  const entry = (config.targets?.[config.defaultTarget ?? ""]?.entrypoints as unknown[] | undefined)?.[0];
  if (typeof entry !== "string" || !entry) throw new Error("osnv.config.json has no entrypoint for its default target.");
  return path.resolve(cwd, entry);
}

async function binaryName(cwd: string): Promise<string> {
  const manifest = Bun.file(path.join(cwd, "package.json"));
  const name = await manifest.exists() ? (await manifest.json() as { name?: unknown }).name : undefined;
  const base = typeof name === "string" ? name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9._-]+/gi, "-") : "";
  if (!base) throw new Error("package.json needs a name for the default binary path; pass --outfile.");
  return base;
}
