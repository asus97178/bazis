import path from "node:path";
import { pathToFileURL } from "node:url";
import { PALETTE } from "../library/terminal";
import { processToMermaid } from "../library/workflow";
import { isBazisModuleClass } from "../core/di/module/Module";
import type { BazisModuleRef } from "../core/di";
import { inspectProcesses, type ProcessInspection } from "../core/workflow/definitions_module/code/inspectProcesses";
import { commandFailed, commandHeader, type CliOutput } from "./ui";

/**
 * The application's root module, imported without starting anything: the
 * export `AppModule` of the app module file, or its only `@Module` class.
 */
export async function loadAppModule(cwd: string, appModule = "src/app/modules/App.module.ts"): Promise<{ readonly file: string; readonly root: BazisModuleRef }> {
  const file = path.resolve(cwd, appModule);
  if (!(await Bun.file(file).exists())) throw new Error(`App module not found: ${path.relative(cwd, file)}. Pass --app-module <path>.`);
  const exports = await import(pathToFileURL(file).href) as Record<string, unknown>;
  const modules = Object.entries(exports).filter(([, value]) => isBazisModuleClass(value));
  const chosen = modules.find(([name]) => name === "AppModule") ?? (modules.length === 1 ? modules[0] : undefined);
  if (!chosen) throw new Error(`${path.relative(cwd, file)} exports ${modules.length === 0 ? "no @Module class" : "several @Module classes and none is AppModule"}.`);
  return { file, root: chosen[1] as BazisModuleRef };
}

/** `bazis workflow check`: every process of the module tree against the Tools; exit code 1 on errors. */
export async function runWorkflowCheck(cwd: string, appModule: string | undefined, ui: CliOutput): Promise<number> {
  const s = ui.out;
  const t = s.t.workflow;
  const { file, root } = await loadAppModule(cwd, appModule);
  commandHeader(s, "workflow", cwd, [s.kv(t.app, s.text(path.relative(cwd, file)))]);
  const inspection = inspectProcesses(root);
  s.section(t.section, s.muted(`${inspection.processes.length} ${s.t.noun("process", inspection.processes.length)} · ${inspection.tools.length} ${s.t.noun("tool", inspection.tools.length)}`));
  if (inspection.processes.length === 0) s.line(`  ${s.muted(t.none)}`);
  for (const { process, module, errors, warnings } of inspection.processes) {
    const nodes = Object.keys(process.document.nodes ?? {}).length;
    s.step(errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok", process.key, s.muted(`${module} · ${nodes} ${s.t.noun("node", nodes)}`));
    s.tree([...errors.map((text) => ({ text: s.fg(PALETTE.red, text) })), ...warnings.map((text) => ({ text: s.fg(PALETTE.yellow, text) }))], s.style.color ? 9 : 4);
  }
  const errors = errorCount(inspection);
  s.line();
  if (errors > 0) {
    const problems = [
      ...inspection.errors.map((cause) => ({ tag: "WORKFLOW", where: "processes", cause })),
      ...inspection.processes.filter((entry) => entry.errors.length > 0).map((entry) => ({ tag: "WORKFLOW", where: `${entry.module} · ${entry.process.key}`, cause: entry.errors.join("\n") })),
    ];
    return commandFailed(ui.err, t.failed(errors), problems, 1, t.fix);
  }
  s.banner("success", t.passed(inspection.processes.length));
  return 0;
}

/** `bazis workflow diagram <key>`: the process as Mermaid on stdout, nothing else, so it can be redirected. */
export async function runWorkflowDiagram(cwd: string, key: string, appModule: string | undefined, log: (text: string) => void): Promise<number> {
  const { root } = await loadAppModule(cwd, appModule);
  const inspection = inspectProcesses(root);
  const entry = inspection.processes.find(({ process }) => process.key === key);
  if (!entry) {
    const keys = inspection.processes.map(({ process }) => process.key);
    throw new Error(`No process "${key}" is declared in code. ${keys.length === 0 ? "The modules declare no processes." : `Declared: ${keys.join(", ")}.`}`);
  }
  log(processToMermaid(entry.process.document).trimEnd());
  return 0;
}

function errorCount(inspection: ProcessInspection): number {
  return inspection.errors.length + inspection.processes.reduce((sum, entry) => sum + entry.errors.length, 0);
}
