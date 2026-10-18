#!/usr/bin/env bun
import path from "node:path";
import { useTypeScriptCompilerApi } from "../core/scripts/typescriptApi";
import { detectLanguage, formatDuration, padEnd, PALETTE, type Language, type ScreenOutput } from "../library/terminal";
import { parseCliArgs, type ParsedGenerateArgs } from "./parseCli";
import { runCodegen, type CodegenOptions } from "./codegen";
import { generateProject } from "./generateProject";
import { runBuild, runDev, runTest } from "./build";
import { bazisVersion, commandFailed, commandHeader, createScreens, lineOutput, requiredBun, type CliOutput } from "./ui";

export const USAGE = `Usage:
  bazis new <Name> [options]                  Create a new application project
  bazis g module <Name> [options]             Atomic module (alias: m)
  bazis g pack <Name> --parts <a,b> [options] Composite module (aliases: p, module-pack)
  bazis codegen [--target <name|all>]         Generate DI wiring into src/generated/bazis
  bazis dev [--watch]                         Codegen, then run the app from source with
                                             BAZIS_ENV=development (unless set);
                                             --watch reruns both when src/ changes
  bazis test [<bun test args>]                Codegen, then bun test
  bazis build                                 Codegen and typecheck
  bazis build --bin [--outfile <path>]        Also compile a standalone executable (default bin/<name>)
  bazis build --bin --dotenv                  The executable also reads .env files from its working directory
  bazis build --bin --platform <os-arch>      For another platform, e.g. linux-x64, linux-arm64-musl
                                             (default output bin/<name>-<os-arch>)
  bazis --help
  bazis --version                             Print the bazis version (also -v)
  g can also be written as generate.
  --lang <en|ru> sets the output language (also BAZIS_LANG, "language" in bazis.config.json).

Generation options:
  --path <directory>    Exact project directory (new only; default: ./<name>)
  --framework <path>    Local bazis package directory (new only)
  --vendor              Copy the package into vendor/bazis instead of the npm dependency (new only)
  --link-framework      Depend on that local checkout through a file: link (new only)
  --modules-root <path>  Modules root (default: src/app/modules)
  --app-module <path>    Host module (default: {modules-root}/App.module.ts)
  --pack <Name>          Module only: add it as a part of the composite <Name>
                         ({modules-root}/<name>_modules/<module>_module)
  --empty               Module entry and MODULE.md only
  --minimal             Compact example CRUD and MODULE.md (default)
  --full                Example CRUD/list/cache/auth/background/AI and MODULE.md;
                        uses src/app/modules/auth helpers when the project has them.
                        To run, the host needs a cache (runApp({ cache: memory() }))
                        and a database provider. Legacy alias: --enterprise
  --parts <a,b,...>      Independent empty atomic parts; pack only, at least two
  --dry-run             Validate and list planned changes without writing
  --no-register         Skip host registration and automatic codegen
  --no-codegen          Generate and register without running codegen
  --target <name|all>    Codegen target (default: project's default target)
  --force               Overwrite scaffold files, including MODULE.md
  -h, --help            Show help at any position without changing files

Examples (from the project root):
  bunx bazis new MyApp --dry-run
  bunx bazis new MyApp
  bunx bazis g module Task --dry-run
  bunx bazis g m Guest --no-codegen
  bunx bazis g module Mailer --empty --no-register
  bunx bazis g pack DataManager --parts tables,fields,validators,records
  bunx bazis g module Prices --empty --pack Catalog
  bunx bazis codegen --target production
  bunx bazis dev --watch
  bunx bazis test
  bunx bazis build --bin

Read AGENTS.md and docs/architecture/MODULE_ARCHITECTURE.md before implementing.
`;

export interface CliRuntime {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly codegen: (cwd: string, target?: string, options?: CodegenOptions) => Promise<number>;
  /** Terminal outputs for colour and spinners; without them `log`/`error` get plain lines. */
  readonly stdout?: ScreenOutput;
  readonly stderr?: ScreenOutput;
  /** Output language when `--lang` is not given; detected from the environment otherwise. */
  readonly language?: Language;
  /** The running Bun: version and executable (default: this process). */
  readonly bun?: { readonly version: string; readonly path: string };
}

const defaultRuntime: CliRuntime = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  codegen: runCodegen,
  stdout: process.stdout,
  stderr: process.stderr,
};

/** `--lang ru` / `--lang=ru` anywhere in the arguments; the rest goes to the parser. */
export function extractLanguage(argv: readonly string[]): { readonly argv: readonly string[]; readonly lang?: string } {
  const rest: string[] = [];
  let lang: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    // After `test`, arguments belong to bun test.
    if (rest[0] === "test") { rest.push(arg); continue; }
    if (arg === "--lang") { lang = argv[++index]; continue; }
    if (arg.startsWith("--lang=")) { lang = arg.slice("--lang=".length); continue; }
    rest.push(arg);
  }
  return { argv: rest, ...(lang === undefined ? {} : { lang }) };
}

export async function runCli(argv: readonly string[], runtime: CliRuntime = defaultRuntime): Promise<number> {
  const extracted = extractLanguage(argv);
  const language = detectLanguage({ flag: extracted.lang ?? runtime.language });
  const ui = createScreens(runtime.stdout ?? lineOutput(runtime.log), runtime.stderr ?? lineOutput(runtime.error), language);
  const codegen = (cwd: string, target?: string, options?: CodegenOptions) => runtime.codegen(cwd, target, { ui, ...options });
  const parsed = parseCliArgs(extracted.argv);
  if (parsed.kind === "help") {
    runtime.log(USAGE.trim());
    return parsed.help ? 0 : 1;
  }
  if (parsed.kind === "version") {
    runtime.log(bazisVersion());
    return 0;
  }
  // `#!/usr/bin/env bun` runs the CLI on the first bun in PATH, which may be
  // older than the one the user called; stop before it fails somewhere later.
  const bun = runtime.bun ?? { version: Bun.version, path: process.execPath };
  const required = requiredBun();
  if (required !== undefined && !Bun.semver.satisfies(bun.version, required)) {
    const t = ui.err.t.errors;
    return commandFailed(ui.err, ui.err.t.failure.command, [{ tag: "BUN", where: bun.path, cause: t.bunTooOld(required, bun.version), fixes: [t.bunWhich(bun.path), t.bunUpgrade] }], 1);
  }
  if (parsed.kind === "error") {
    return commandFailed(ui.err, ui.err.t.failure.command, [{ tag: "CLI", where: "bazis", cause: parsed.message, fixes: [ui.err.t.errors.unknown] }], 1);
  }
  const cwd = process.cwd();
  try {
    if (parsed.kind === "codegen") return await runCodegenCommand(cwd, parsed.target, codegen, ui);
    if (parsed.kind === "dev") return await runDev(cwd, codegen, ui, { watch: parsed.watch });
    if (parsed.kind === "test") return await runTest(cwd, parsed.args, codegen, ui);
    if (parsed.kind === "build") return await runBuild(cwd, { bin: parsed.bin, outfile: parsed.outfile, dotenv: parsed.dotenv, platform: parsed.platform }, codegen, ui);
    if (parsed.kind === "new") return await runNew(parsed, ui);
    // Module registration parses the host module with the TypeScript API: load it
    // only after switching TypeScript 7 to @typescript/typescript6.
    useTypeScriptCompilerApi(cwd);
    return await runGenerate(cwd, parsed.args, codegen, ui);
  } catch (error) {
    return commandFailed(ui.err, ui.err.t.failure.command, [{ tag: "CLI", where: parsed.kind === "generate" ? `g ${parsed.args.generator}` : parsed.kind, cause: error instanceof Error ? error.message : String(error) }], 1);
  }
}

async function runCodegenCommand(cwd: string, target: string | undefined, codegen: CliRuntime["codegen"], ui: CliOutput): Promise<number> {
  const s = ui.out;
  const t = s.t;
  const startedAt = performance.now();
  commandHeader(s, "codegen", cwd, [s.kv(t.meta.target, s.text(target ?? "default"))]);
  s.section(t.section.build);
  const exitCode = await codegen(cwd, target, { ui });
  if (exitCode !== 0) return exitCode;
  s.line();
  s.banner("success", t.codegen.done(formatDuration(performance.now() - startedAt)));
  return 0;
}

async function runNew(parsed: Extract<ReturnType<typeof parseCliArgs>, { kind: "new" }>, ui: CliOutput): Promise<number> {
  const s = ui.out;
  const t = s.t;
  const result = await generateProject({ name: parsed.name, outputPath: parsed.outputPath, frameworkPath: parsed.frameworkPath, linkFramework: parsed.linkFramework, vendor: parsed.vendor, dryRun: parsed.dryRun });
  const relative = path.relative(process.cwd(), result.projectDir) || ".";
  commandHeader(s, "new", process.cwd(), [s.kv(t.meta.path, s.text(relative)), ...(result.dryRun ? [s.fg(PALETTE.yellow, t.common.dryRun)] : [])], { name: parsed.name, version: "0.1.0" });
  s.section(t.section.project, s.muted(relative));
  s.step("ok", t.step.files, s.num(result.files.length, t.noun("file", result.files.length)));
  s.tree(result.files.map((file) => ({ text: `${s.strong("+", PALETTE.lime)} ${s.text(path.relative(result.projectDir, path.resolve(result.projectDir, file)))}` })), s.style.color ? 9 : 4);
  s.line();
  s.line(`  ${s.strong("◆", PALETTE.service)}  ${s.text(result.frameworkMode === "registry"
    ? t.project.dependency(result.dependency)
    : result.frameworkMode === "snapshot" ? t.project.vendor(result.frameworkFileCount) : t.project.linked)}`);
  s.line();
  s.banner("success", result.dryRun ? t.project.planned(parsed.name) : t.project.created(parsed.name));
  if (!result.dryRun) {
    const step = (number: number, command: string, note: string) => `${s.strong(String(number), PALETTE.lime)}  ${padEnd(command, 32)}${s.muted(note)}`;
    s.panel([
      step(1, s.code(`cd ${relative}`), ""),
      step(2, s.code("bun install"), t.project.install),
      step(3, s.code("bunx bazis dev"), t.project.dev),
      step(4, s.link("http://127.0.0.1:3000/health"), t.project.open),
    ]);
    s.line();
  }
  return 0;
}

async function runGenerate(cwd: string, args: ParsedGenerateArgs, codegen: CliRuntime["codegen"], ui: CliOutput): Promise<number> {
  const s = ui.out;
  const t = s.t;
  const { generateModule, generateModulePack } = await import("./generateModule");
  const options = {
    name: args.name, modulesRoot: args.modulesRoot, appModulePath: args.appModule,
    register: args.register, force: args.force, dryRun: args.dryRun,
  };
  const kind = t.module.kind[args.generator];
  commandHeader(s, "gen", cwd, [
    s.kv(kind, s.strong(args.name)),
    ...(args.generator === "module" ? [s.kv("profile", s.text(args.profile))] : [s.kv("parts", s.text(args.parts.join(", ")))]),
    ...(args.dryRun ? [s.fg(PALETTE.yellow, t.common.dryRun)] : []),
  ]);
  const result = args.generator === "pack"
    ? await generateModulePack({ ...options, parts: args.parts })
    : await generateModule({ ...options, profile: args.profile, pack: args.pack });
  s.section(t.section.files, s.muted(path.relative(cwd, result.moduleDir) || result.moduleDir));
  s.step("ok", t.step.files, s.num(result.changes.length, t.noun("change", result.changes.length)));
  s.tree(result.changes.map((change) => ({ text: `${change.action === "create" ? s.strong("+", PALETTE.lime) : s.strong("~", PALETTE.yellow)} ${s.text(change.path)}` })), s.style.color ? 9 : 4);
  for (const warning of result.warnings) s.warning(warning);
  s.line();
  const host = result.changes.find((change) => change.action === "update")?.path;
  if (result.registered) s.line(`  ${s.strong("↗", PALETTE.export)}  ${s.text(t.module.registered(host ?? "App.module.ts"))}`);
  else s.warning(t.module.notRegistered);
  // What the module needs from the application to run.
  if (args.generator === "module" && args.profile !== "empty") s.line(`  ${s.strong("◆", PALETTE.service)}  ${s.muted(t.module.needsDb)}`);
  if (args.generator === "module" && args.profile === "full") s.line(`  ${s.strong("◆", PALETTE.service)}  ${s.muted(t.module.needsCache)}`);
  s.line();
  if (result.dryRun) {
    s.banner("success", t.module.planned(kind, args.name));
    return 0;
  }
  if (result.registered && args.codegen) {
    s.section(t.section.build);
    const exitCode = await codegen(cwd, args.target);
    if (exitCode !== 0) {
      ui.err.footer(t.module.keptOnFailure);
      return exitCode;
    }
    s.line();
  } else if (result.registered) {
    s.line(`  ${s.muted(t.module.codegenSkipped)}`);
    s.line();
  }
  s.banner("success", t.module.created(kind, args.name));
  return 0;
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));
