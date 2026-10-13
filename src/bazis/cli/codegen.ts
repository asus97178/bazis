import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PALETTE, formatDuration, type Problem, type Screen } from "../library/terminal";
import { commandFailed, createScreens, readFrameLines, type CliOutput } from "./ui";

const GENERATOR = "core/scripts/di-generate.ts";

/** What the generator reports through `BAZIS_CODEGEN_REPORT`. */
export interface CodegenReport {
  readonly ok: boolean;
  readonly ms: number;
  readonly targets: readonly {
    readonly name: string; readonly sources: number; readonly deps: number; readonly controllers: number;
    readonly requestModels: number; readonly listModels: number; readonly tools: number; readonly ms: number;
  }[];
  readonly outputs: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface CodegenOptions {
  readonly ui?: CliOutput;
  /** The last line of a failure: the exit code, or what `dev --watch` does next. */
  readonly footer?: string;
}

/**
 * Runs the framework generator for the project in `cwd` and renders its
 * result as the `codegen` step: counts and generated files, warnings, and on
 * failure one problem per error with the code around it. Returns its exit code.
 */
export async function runCodegen(cwd: string, target?: string, options: CodegenOptions = {}): Promise<number> {
  if (target !== undefined) {
    const configFile = Bun.file(path.join(cwd, "bazis.config.json"));
    if (!await configFile.exists()) throw new Error("--target requires bazis.config.json in the current directory.");
    const config = await configFile.json();
    if (target !== "all" && !Object.hasOwn(config.targets ?? {}, target)) throw new Error(`Unknown codegen target: ${target}`);
  }
  const ui = options.ui ?? createScreens(process.stdout, process.stderr);
  const s = ui.out;
  const generator = resolveGenerator(cwd);
  // TypeScript 7 has no compiler API: the preload switches it to @typescript/typescript6.
  const preload = path.join(path.dirname(generator), "typescriptApiPreload.ts");
  const args = [await resolveBun(cwd), ...(existsSync(preload) ? ["--preload", preload] : []), generator, ...(target === undefined ? [] : ["--target", target])];
  const workDir = mkdtempSync(path.join(tmpdir(), "bazis-codegen-"));
  const reportFile = path.join(workDir, "report.json");
  const stop = s.progress(s.t.step.codegen);
  const startedAt = performance.now();
  try {
    const child = Bun.spawn(args, { cwd, env: { ...process.env, BAZIS_CODEGEN_REPORT: reportFile }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    stop();
    const report = readReport(reportFile);
    if (report === undefined) {
      // The generator did not get to its report: show what it printed.
      s.step("fail", s.t.step.codegen, "", formatDuration(performance.now() - startedAt));
      ui.err.line([stdout, stderr].filter((text) => text.trim()).join("\n").trimEnd());
      return exitCode === 0 ? 1 : exitCode;
    }
    renderCodegen(ui, report, cwd, options.footer);
    return report.ok && exitCode === 0 ? 0 : (exitCode || 1);
  } finally {
    stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function readReport(file: string): CodegenReport | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CodegenReport;
  } catch {
    return undefined;
  }
}

export function renderCodegen(ui: CliOutput, report: CodegenReport, cwd: string, footer?: string): void {
  const s = ui.out;
  const t = s.t;
  const time = formatDuration(report.ms);
  const target = report.targets.find((item) => item.name === "production") ?? report.targets[0];
  if (!report.ok) {
    s.step("fail", t.step.codegen, `${s.num(report.errors.length, t.noun("error", report.errors.length), PALETTE.red)}${report.warnings.length ? `${s.dot}${s.num(report.warnings.length, t.noun("warning", report.warnings.length), PALETTE.orange)}` : ""}`, time);
    printWarnings(s, report.warnings);
    s.line();
    commandFailed(ui.err, t.failure.codegen(report.errors.length), report.errors.map((error) => codegenProblem(error, cwd, ui.err)), 1, footer);
    return;
  }
  const counts = target === undefined ? [] : [
    s.num(target.sources, t.noun("file", target.sources)),
    s.num(target.deps, t.noun("dep", target.deps)),
    s.num(target.controllers, t.noun("controller", target.controllers)),
    s.num(target.requestModels, t.noun("requestModel", target.requestModels)),
    s.num(target.listModels, t.noun("list", target.listModels)),
    s.num(target.tools, t.noun("tool", target.tools)),
  ];
  s.step("ok", t.step.codegen, counts.join(s.dot), time);
  const directories = new Map<string, string[]>();
  for (const output of report.outputs) {
    const directory = path.dirname(output);
    directories.set(directory, [...(directories.get(directory) ?? []), path.basename(output, ".ts")]);
  }
  s.tree([...directories].map(([directory, files]) => ({ text: `${s.muted(`${directory}/`)} ${s.text(files.join(" · "))}` })), s.style.color ? 9 : 4);
  printWarnings(s, report.warnings);
}

function printWarnings(s: Screen, warnings: readonly string[]): void {
  for (const warning of warnings) {
    const unassigned = /^BAZIS_CODEGEN_SOURCE_UNASSIGNED: ([^:]+):/.exec(warning);
    if (unassigned) {
      s.warning(`${s.t.codegen.unreachable(unassigned[1]!)}${s.dot}${s.muted(s.t.codegen.unreachableFix)}`);
    } else {
      s.warning(warning);
    }
  }
}

/** `CODE: file:line: message` → a problem with the code around the line. */
export function codegenProblem(error: string, cwd: string, screen: Screen): Problem {
  const t = screen.t;
  const parsed = /^([A-Z][A-Z0-9_]+): (?:([^\s:]+\.tsx?):(\d+): )?([\s\S]*)$/.exec(error);
  if (parsed === null) return { tag: "CODEGEN", where: "codegen", cause: error };
  const [, code, file, lineText, message] = parsed as unknown as [string, string, string | undefined, string | undefined, string];
  const tag = code.startsWith("BAZIS_DI_") ? "DI" : code.startsWith("BAZIS_HTTP_") ? "HTTP" : "CODEGEN";
  const fixes: string[] = [];
  let frame: Problem["frame"];
  let line = lineText === undefined ? undefined : Number(lineText);
  if (file !== undefined && line !== undefined) {
    const type = /has type "([^"]+)"/.exec(message)?.[1];
    // The location is the class; the parameter with that type is a few lines below.
    if (type !== undefined) line = parameterLine(path.resolve(cwd, file), line, type) ?? line;
    const lines = readFrameLines(path.resolve(cwd, file), line);
    const text = lines.find(([number]) => number === line)?.[1] ?? "";
    const column = type === undefined ? -1 : text.search(new RegExp(`(?<=:\\s*)${escapeRegExp(type)}\\b`));
    frame = lines.length === 0 ? undefined : {
      lines,
      line,
      ...(column >= 0 ? { column: column + 1, length: type!.length } : {}),
    };
    if (type === "SQL") fixes.push(t.codegen.sqlFix);
    else if (type === "RedisClient") fixes.push(t.codegen.redisFix);
    else if (code === "BAZIS_DI_DEPENDENCY_UNKNOWN") fixes.push(t.codegen.unknownDepFix);
  }
  return {
    tag,
    where: file === undefined ? code : `${file}:${line}`,
    cause: message.trim(),
    fixes,
    ...(frame === undefined ? {} : { frame }),
    code,
  };
}

/** The first line from `from` on that declares something of type `type`. */
function parameterLine(file: string, from: number, type: string): number | undefined {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const pattern = new RegExp(`:\\s*${escapeRegExp(type)}\\b`);
    for (let index = from - 1; index < Math.min(lines.length, from + 40); index += 1) {
      if (pattern.test(lines[index] ?? "")) return index + 1;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
