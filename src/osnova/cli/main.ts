#!/usr/bin/env bun
import { generateModule, generateModulePack } from "./generateModule";
import { parseCliArgs } from "./parseCli";
import { runCodegen } from "./codegen";
import { generateProject } from "./generateProject";
import { AgentClientService, parseAgentRun } from "./AgentClient.service";

export const USAGE = `Usage:
  osnova new <Name> [options]                Create a new application project
  osnova g module <Name> [options]           Atomic module (alias: m)
  osnova g pack <Name> --parts <a,b> [options] Composite module (aliases: p, module-pack)
  osnova codegen [--target <name|all>]       Run the project's di:generate script
  osnova agent run <id> --server <origin> --auth-file <path> --message <text>
  osnova --help
  g can also be written as generate.

Generation options:
  --path <directory>    Exact project directory (new only; default: ./<name>)
  --framework <path>    Local Osnova package directory (new only)
  --link-framework      Link that checkout instead of copying vendor/osnova (new only)
  --modules-root <path>  Modules root (default: src/app/modules)
  --app-module <path>    Host module (default: {modules-root}/App.module.ts)
  --empty               Module entry and MODULE.md only
  --minimal             Compact example CRUD and MODULE.md (default)
  --full                Example CRUD/list/cache/auth/background/AI and MODULE.md
                        Requires the project's src/app/modules/auth helpers
                        Legacy alias: --enterprise
  --parts <a,b,...>      Independent empty atomic parts; pack only, at least two
  --dry-run             Validate and list planned changes without writing
  --no-register         Skip host registration and automatic codegen
  --no-codegen          Generate and register without running codegen
  --target <name|all>    Codegen target (default: project's default target)
  --force               Overwrite scaffold files, including MODULE.md
  -h, --help            Show help at any position without changing files

Examples (from the project root):
  bun run osnova new MyApp --dry-run
  bun run osnova new MyApp
  bun run osnova g module Task --dry-run
  bun run osnova g m Guest --no-codegen
  bun run osnova g module Mailer --empty --no-register
  bun run osnova g pack DataManager --parts tables,fields,validators,records
  bun run osnova codegen --target production

In this repository, run Bun through scripts/osnova-bun with OSNOVA_BUN_BIN.
Agent execution uses a client account. Auth file (chmod 600): {"server":"http://127.0.0.1:3000","email":"...","password":"..."}.
Optional agent settings: --model <id> --reasoning <effort>. Output is the completed response.
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
  if (argv[0] === "agent" && !argv.some(arg => arg === "--help" || arg === "-h")) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      runtime.log(await new AgentClientService().run(parseAgentRun(argv.slice(1)), controller.signal));
      return 0;
    } catch (error) {
      runtime.error("[osnova] " + (error instanceof Error ? error.message : "Agent request failed."));
      return controller.signal.aborted ? 130 : 1;
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  }
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    runtime.log(USAGE.trim());
    return parsed.help ? 0 : 1;
  }
  if (parsed.kind === "error") {
    runtime.error(`[osnova] ${parsed.message}`);
    runtime.error("Use osnova --help to list commands and options.");
    return 1;
  }
  try {
    if (parsed.kind === "codegen") return await runtime.codegen(process.cwd(), parsed.target);
    if (parsed.kind === "new") {
      const result = await generateProject({ name: parsed.name, outputPath: parsed.outputPath, frameworkPath: parsed.frameworkPath, linkFramework: parsed.linkFramework, dryRun: parsed.dryRun });
      runtime.log(`[osnova] ${result.dryRun ? "planned" : "created"} project: ${result.projectDir}`);
      for (const file of result.files) runtime.log(`  + ${file}`);
      runtime.log(result.frameworkMode === "snapshot"
        ? `[osnova] vendor/osnova: ${result.frameworkFileCount} package files${result.dryRun ? " planned" : " copied"}. Keep this directory in version control.`
        : "[osnova] Framework is linked to an external checkout (--link-framework).");
      if (!result.dryRun) runtime.log(`[osnova] Next: cd ${result.projectDir} && bun install && bun run dev`);
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
    runtime.log(`[osnova] ${result.dryRun ? "planned" : "generated"} ${args.generator}: ${result.moduleDir}`);
    for (const change of result.changes) runtime.log(`  ${change.action === "create" ? "+" : "~"} ${change.path}`);
    for (const warning of result.warnings) runtime.log(`[osnova] ${warning}`);
    if (result.dryRun) {
      runtime.log("[osnova] dry-run: no files written; codegen not run.");
      return 0;
    }
    if (result.registered) runtime.log("[osnova] connected in host module.");
    if (!args.codegen || !result.registered) {
      runtime.log(`[osnova] codegen skipped: ${!args.codegen ? "--no-codegen" : "module is not connected by this command"}.`);
      return 0;
    }
    runtime.log("[osnova] running di:generate...");
    const exitCode = await runtime.codegen(process.cwd(), args.target);
    if (exitCode !== 0) runtime.error("[osnova] codegen failed; scaffold files were kept. Fix the error and run osnova codegen.");
    return exitCode;
  } catch (error) {
    runtime.error(`[osnova] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));
