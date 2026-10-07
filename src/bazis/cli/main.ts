#!/usr/bin/env bun
import { generateModule, generateModulePack } from "./generateModule";
import { parseCliArgs } from "./parseCli";
import { runCodegen } from "./codegen";
import { generateProject } from "./generateProject";
import { runBuild, runDev, runTest } from "./build";

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
  bazis --help
  g can also be written as generate.

Generation options:
  --path <directory>    Exact project directory (new only; default: ./<name>)
  --framework <path>    Local bazis package directory (new only)
  --vendor              Copy the package into vendor/bazis instead of the npm dependency (new only)
  --link-framework      Depend on that local checkout through a file: link (new only)
  --modules-root <path>  Modules root (default: src/app/modules)
  --app-module <path>    Host module (default: {modules-root}/App.module.ts)
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
  bunx bazis codegen --target production
  bunx bazis dev --watch
  bunx bazis test
  bunx bazis build --bin

Read AGENTS.md and docs/architecture/MODULE_ARCHITECTURE.md before implementing.
`;

export interface CliRuntime {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly codegen: (cwd: string, target?: string) => Promise<number>;
}

const defaultRuntime: CliRuntime = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  codegen: runCodegen,
};

export async function runCli(argv: readonly string[], runtime: CliRuntime = defaultRuntime): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    runtime.log(USAGE.trim());
    return parsed.help ? 0 : 1;
  }
  if (parsed.kind === "error") {
    runtime.error(`[bazis] ${parsed.message}`);
    runtime.error("Use bazis --help to list commands and options.");
    return 1;
  }
  try {
    if (parsed.kind === "codegen") return await runtime.codegen(process.cwd(), parsed.target);
    if (parsed.kind === "dev") return await runDev(process.cwd(), runtime.codegen, runtime.log, { watch: parsed.watch });
    if (parsed.kind === "test") return await runTest(process.cwd(), parsed.args, runtime.codegen);
    if (parsed.kind === "build") return await runBuild(process.cwd(), { bin: parsed.bin, outfile: parsed.outfile }, runtime.codegen, runtime.log);
    if (parsed.kind === "new") {
      const result = await generateProject({ name: parsed.name, outputPath: parsed.outputPath, frameworkPath: parsed.frameworkPath, linkFramework: parsed.linkFramework, vendor: parsed.vendor, dryRun: parsed.dryRun });
      runtime.log(`[bazis] ${result.dryRun ? "planned" : "created"} project: ${result.projectDir}`);
      for (const file of result.files) runtime.log(`  + ${file}`);
      runtime.log(result.frameworkMode === "registry"
        ? `[bazis] Framework dependency: "bazis": "${result.dependency}" from npm.`
        : result.frameworkMode === "snapshot"
        ? `[bazis] vendor/bazis: ${result.frameworkFileCount} package files${result.dryRun ? " planned" : " copied"}. Keep this directory in version control.`
        : "[bazis] Framework is linked to an external checkout (--link-framework).");
      if (!result.dryRun) runtime.log(`[bazis] Next: cd ${result.projectDir} && bun install && bunx bazis dev`);
      return 0;
    }
    const args = parsed.args;
    const options = {
      name: args.name, modulesRoot: args.modulesRoot, appModulePath: args.appModule,
      register: args.register, force: args.force, dryRun: args.dryRun,
    };
    const result = args.generator === "pack"
      ? await generateModulePack({ ...options, parts: args.parts })
      : await generateModule({ ...options, profile: args.profile });
    runtime.log(`[bazis] ${result.dryRun ? "planned" : "generated"} ${args.generator}: ${result.moduleDir}`);
    for (const change of result.changes) runtime.log(`  ${change.action === "create" ? "+" : "~"} ${change.path}`);
    for (const warning of result.warnings) runtime.log(`[bazis] ${warning}`);
    if (result.dryRun) {
      runtime.log("[bazis] dry-run: no files written; codegen not run.");
      return 0;
    }
    if (result.registered) runtime.log("[bazis] connected in host module.");
    if (!args.codegen || !result.registered) {
      runtime.log(`[bazis] codegen skipped: ${!args.codegen ? "--no-codegen" : "module is not connected by this command"}.`);
      return 0;
    }
    runtime.log("[bazis] running codegen...");
    const exitCode = await runtime.codegen(process.cwd(), args.target);
    if (exitCode !== 0) runtime.error("[bazis] codegen failed; scaffold files were kept. Fix the error and run bazis codegen.");
    return exitCode;
  } catch (error) {
    runtime.error(`[bazis] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));
