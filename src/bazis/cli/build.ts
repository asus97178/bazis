import { existsSync, mkdtempSync, rmSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PALETTE, formatBytes, formatDuration, type Problem } from "../library/terminal";
import { resolveBun, type CodegenOptions } from "./codegen";
import { commandFailed, commandHeader, createScreens, readFrameLines, type CliOutput } from "./ui";

type Codegen = (cwd: string, target?: string, options?: CodegenOptions) => Promise<number>;

export interface BuildOptions {
  /** Also compile the entrypoint into a standalone executable. */
  readonly bin: boolean;
  /** Executable path relative to the project; default `bin/<package name>`. */
  readonly outfile?: string;
  /** Let the executable read `.env` files from its working directory (off by default). */
  readonly dotenv?: boolean;
  /** Another platform, `linux-x64`: `bun build --target=bun-linux-x64`. */
  readonly platform?: string;
}

export interface CompileOptions {
  /** Cross-compile for `bun-<platform>`; Bun downloads that runtime once. */
  readonly platform?: string;
  /** Let the executable read `.env`, `.env.local`, `.env.<NODE_ENV>` from its working directory. */
  readonly dotenv?: boolean;
}

const defaultUi = (): CliOutput => createScreens(process.stdout, process.stderr);

/** `bazis dev` means development; an BAZIS_ENV from the shell still wins. */
export function devEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, BAZIS_ENV: env.BAZIS_ENV || "development" };
}

/**
 * `bazis dev`: codegen of every target, then run the default target's entrypoint from source.
 * With `watch`, a change under src/ (except src/generated) stops the app,
 * reruns codegen and starts it again; a failed codegen waits for the next change.
 * The app runs as `development` unless BAZIS_ENV is set in the shell. The CLI
 * prints the header and the build; the application prints the rest of the screen.
 */
export async function runDev(cwd: string, codegen: Codegen, ui: CliOutput = defaultUi(), options: { readonly watch?: boolean } = {}): Promise<number> {
  const s = ui.out;
  const t = s.t;
  const bun = await resolveBun(cwd);
  const entry = await projectEntry(cwd);
  const watchDir = "src/";
  const env: NodeJS.ProcessEnv = {
    ...devEnvironment(process.env),
    // The CLI already printed the logo; the application continues the screen.
    BAZIS_UI_HEADER: "0",
    BAZIS_LANG: process.env.BAZIS_LANG || s.language,
    ...(options.watch ? { BAZIS_UI_WATCH: watchDir } : {}),
  };
  commandHeader(s, "dev", cwd, [
    s.kv(t.meta.env, s.strong(env.BAZIS_ENV ?? "development", PALETTE.yellow)),
    s.kv(t.meta.watch, options.watch ? s.strong(t.meta.on, PALETTE.lime) : s.muted(t.meta.off)),
    s.kv(t.meta.src, s.text(path.relative(cwd, entry))),
  ]);
  const build = async (footer?: string): Promise<number> => {
    s.section(t.section.build);
    const generated = await codegen(cwd, "all", { ui, ...(footer === undefined ? {} : { footer }) });
    if (generated === 0) s.line();
    return generated;
  };
  if (!options.watch) {
    const generated = await build();
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
    if (await build(t.failure.exitWatch(1, watchDir)) !== 0) return;
    child = Bun.spawn([bun, "run", entry], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  };
  const watcher = watch(path.join(cwd, "src"), { recursive: true }, (_event, file) => {
    // codegen writes src/generated: watching it would restart forever.
    if (!file || /^generated([\\/]|$)/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(async () => {
        s.line();
        s.line(`  ${s.strong("↻", PALETTE.link)}  ${s.text(`src/${String(file).replaceAll("\\", "/")}`)} ${s.muted(t.dev.restarting)}`);
        s.line();
        await stop();
        await start();
      });
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
  queue = queue.then(start);
  try {
    return await finished.promise;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

/** `bazis test [args]`: codegen of every target, then `bun test` with the given arguments. */
export async function runTest(cwd: string, args: readonly string[], codegen: Codegen, ui: CliOutput = defaultUi()): Promise<number> {
  const s = ui.out;
  const t = s.t;
  commandHeader(s, "test", cwd, [s.kv(t.meta.env, s.strong("test", PALETTE.link)), ...(args.length ? [s.text(`bun test ${args.join(" ")}`)] : [])]);
  s.section(t.section.build);
  const generated = await codegen(cwd, "all", { ui });
  if (generated !== 0) return generated;
  s.line();
  s.section(t.section.tests);
  s.line();
  const startedAt = performance.now();
  const exitCode = await Bun.spawn([await resolveBun(cwd), "test", ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  s.line();
  if (exitCode === 0) {
    s.banner("success", `${t.test.done} · ${formatDuration(performance.now() - startedAt)}`);
    return 0;
  }
  ui.err.banner("failed", t.test.failed(exitCode));
  ui.err.footer(t.failure.exit(exitCode));
  return exitCode;
}

/** `bazis build [--bin]`: codegen of every target and typecheck; with `bin`, also compile. */
export async function runBuild(cwd: string, options: BuildOptions, codegen: Codegen, ui: CliOutput = defaultUi()): Promise<number> {
  const s = ui.out;
  const t = s.t;
  const startedAt = performance.now();
  const outfile = options.bin ? path.resolve(cwd, options.outfile ?? path.join("bin", await defaultBinaryName(cwd, options.platform))) : undefined;
  commandHeader(s, "build", cwd, [
    s.kv(t.meta.target, s.text(options.bin ? "executable" : "typecheck")),
    ...(outfile === undefined ? [] : [s.kv(t.meta.out, s.text(path.relative(cwd, outfile)))]),
    ...(options.platform === undefined ? [] : [s.kv(t.meta.platform, s.text(options.platform))]),
  ]);
  s.section(t.section.build);
  const generated = await codegen(cwd, "all", { ui });
  if (generated !== 0) return generated;
  const bun = await resolveBun(cwd);
  const tsc = path.join(cwd, "node_modules/typescript/bin/tsc");
  if (!existsSync(tsc)) throw new Error("TypeScript is not installed in this project. Run: bun add -d typescript");
  const stop = s.progress(t.step.typecheck);
  const typecheckStarted = performance.now();
  const child = Bun.spawn([bun, tsc, "--noEmit", "--pretty", "false"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, typecheck] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  stop();
  const typecheckMs = formatDuration(performance.now() - typecheckStarted);
  if (typecheck !== 0) {
    const problems = typeProblems(`${stdout}\n${stderr}`, cwd);
    s.step("fail", t.step.typecheck, s.num(problems.length, t.noun("error", problems.length), PALETTE.red), typecheckMs);
    s.line();
    if (problems.length === 0) ui.err.line(`${stdout}${stderr}`.trimEnd());
    return commandFailed(ui.err, t.failure.typecheck(problems.length), problems.slice(0, 20), typecheck);
  }
  s.step("ok", t.step.typecheck, s.muted(t.build.typecheckOk), typecheckMs);
  s.line();
  if (outfile === undefined) {
    s.banner("success", t.build.done(formatDuration(performance.now() - startedAt)));
    return 0;
  }
  s.section(t.section.binary);
  const stopCompile = s.progress(t.step.compile);
  const compileStarted = performance.now();
  const compiled = await compileBinaryAsync(bun, await projectEntry(cwd), outfile, { dotenv: options.dotenv, platform: options.platform });
  stopCompile();
  const compileMs = formatDuration(performance.now() - compileStarted);
  const relative = path.relative(cwd, outfile);
  if (compiled.exitCode !== 0) {
    s.step("fail", t.step.compile, "", compileMs);
    s.line();
    return commandFailed(ui.err, t.failure.command, [{ tag: "COMPILE", where: relative, cause: compiled.output.trim() || `bun build exited with code ${compiled.exitCode}` }], compiled.exitCode);
  }
  s.step("ok", t.step.compile, `${s.text(relative)}${s.dot}${s.strong(formatBytes(statSync(outfile).size))}`, compileMs);
  s.line();
  s.banner("success", t.build.binaryDone(relative));
  s.panel([
    s.panelRow(t.build.run, s.code(`./${relative}`)),
    "",
    s.muted(t.build.production),
    ...(options.dotenv ? [s.muted(t.build.dotenv)] : []),
  ]);
  s.line();
  return 0;
}

/** `src/a.ts(12,5): error TS2322: …` → a problem with the code around the line. */
export function typeProblems(output: string, cwd: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!match) {
      // tsc continues a message on indented lines.
      const last = problems.at(-1);
      if (last !== undefined && /^\s+\S/.test(line)) problems[problems.length - 1] = { ...last, cause: `${last.cause}\n${line.trim()}` };
      continue;
    }
    const [, file, lineText, columnText, code, message] = match as unknown as [string, string, string, string, string, string];
    const lineNumber = Number(lineText);
    const lines = readFrameLines(path.resolve(cwd, file), lineNumber);
    problems.push({
      tag: "TYPE",
      where: `${file}:${lineNumber}:${columnText}`,
      cause: message,
      ...(lines.length === 0 ? {} : { frame: { lines, line: lineNumber, column: Number(columnText), length: 1 } }),
      code,
    });
  }
  return problems;
}

/**
 * `bun build --compile` clones the running Bun executable into a temporary
 * `.<hash>.bun-build` file in its working directory and cannot remove it when
 * that executable is read-only or carries `uchg` (scripts/bazis-bun). Compile
 * from a private directory and remove it afterwards.
 *
 * By default a Bun executable reads `bunfig.toml` and `.env` files from the
 * directory it is started in: a `preload` in such a bunfig runs foreign code
 * inside the application, and a stray `.env` silently changes its settings.
 * The executable gets its settings from the real environment instead;
 * `dotenv: true` restores reading `.env`. A bunfig is never read.
 */
export function compileBinary(bun: string, entry: string, outfile: string, options: CompileOptions = {}): number {
  const workDir = mkdtempSync(path.join(tmpdir(), "bazis-compile-"));
  try {
    const result = Bun.spawnSync(compileArgs(bun, entry, outfile, options), { cwd: workDir, stdout: "inherit", stderr: "inherit" });
    return result.exitCode ?? 1;
  } finally {
    removeWorkDir(workDir);
  }
}

/** {@link compileBinary} without blocking, with the compiler's output captured for the screen. */
export async function compileBinaryAsync(bun: string, entry: string, outfile: string, options: CompileOptions = {}): Promise<{ exitCode: number; output: string }> {
  const workDir = mkdtempSync(path.join(tmpdir(), "bazis-compile-"));
  try {
    const child = Bun.spawn(compileArgs(bun, entry, outfile, options), { cwd: workDir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, output: `${stdout}${stderr}` };
  } finally {
    removeWorkDir(workDir);
  }
}

export function compileArgs(bun: string, entry: string, outfile: string, options: CompileOptions): string[] {
  const autoload = ["--no-compile-autoload-bunfig", options.dotenv === true ? "--compile-autoload-dotenv" : "--no-compile-autoload-dotenv"];
  const target = options.platform === undefined ? [] : [`--target=bun-${options.platform}`];
  return [bun, "build", "--compile", ...target, ...autoload, path.resolve(entry), "--outfile", path.resolve(outfile)];
}

function removeWorkDir(workDir: string): void {
  if (existsSync("/usr/bin/chflags")) Bun.spawnSync(["/usr/bin/chflags", "-R", "nouchg", workDir]);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    // The binary itself is complete; report the leftover without failing the build.
    console.error(`[bazis] temporary directory was not removed: ${workDir}`, error);
  }
}

async function projectEntry(cwd: string): Promise<string> {
  const configFile = Bun.file(path.join(cwd, "bazis.config.json"));
  if (!await configFile.exists()) throw new Error("bazis.config.json not found in the current directory.");
  const config = await configFile.json() as { defaultTarget?: string; targets?: Record<string, { entrypoints?: unknown }> };
  const entry = (config.targets?.[config.defaultTarget ?? ""]?.entrypoints as unknown[] | undefined)?.[0];
  if (typeof entry !== "string" || !entry) throw new Error("bazis.config.json has no entrypoint for its default target.");
  return path.resolve(cwd, entry);
}

/** `bin/<name>`, or `bin/<name>-<platform>` for another platform, so the local build is kept. */
async function defaultBinaryName(cwd: string, platform: string | undefined): Promise<string> {
  const name = await binaryName(cwd);
  return platform === undefined ? name : `${name}-${platform}`;
}

async function binaryName(cwd: string): Promise<string> {
  const manifest = Bun.file(path.join(cwd, "package.json"));
  const name = await manifest.exists() ? (await manifest.json() as { name?: unknown }).name : undefined;
  const base = typeof name === "string" ? name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9._-]+/gi, "-") : "";
  if (!base) throw new Error("package.json needs a name for the default binary path; pass --outfile.");
  return base;
}
