import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODE, PALETTE, Screen, formatDuration, type Language, type Problem, type ScreenOutput } from "../library/terminal";

/** Where the CLI writes: the terminal, or a test buffer of lines. */
export interface CliOutput {
  readonly out: Screen;
  readonly err: Screen;
}

/** A line sink (`console.log`, a test array) as a screen output without colour. */
export function lineOutput(sink: (line: string) => void): ScreenOutput {
  let pending = "";
  return {
    isTTY: false,
    write(text: string) {
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) sink(line.trimEnd());
    },
  };
}

export function createScreens(stdout: ScreenOutput, stderr: ScreenOutput, language?: Language): CliOutput {
  const out = new Screen(stdout, { language });
  return { out, err: new Screen(stderr, { language: out.language, style: stderr === stdout ? out.style : undefined }) };
}

/** The project of the working directory: name and version from `package.json`. */
export function projectInfo(cwd: string): { name?: string; version?: string } {
  try {
    const json = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return { ...(typeof json.name === "string" ? { name: json.name } : {}), ...(typeof json.version === "string" ? { version: json.version } : {}) };
  } catch {
    return {};
  }
}

/** Version of the bazis package this CLI belongs to. */
export function bazisVersion(): string {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    if (!existsSync(file)) return "?";
    const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "?";
  } catch {
    return "?";
  }
}

/** The logo with the command badge: project, versions, and the command's own facts. */
export function commandHeader(screen: Screen, mode: keyof typeof MODE, cwd: string, facts: readonly string[], project = projectInfo(cwd)): void {
  screen.header(mode, MODE[mode], [
    project.name ? `${screen.strong(project.name)}${project.version ? ` ${screen.muted(project.version)}` : ""}` : screen.muted(path.basename(cwd)),
    [screen.kv("bazis", screen.text(bazisVersion())), screen.kv("bun", screen.text(Bun.version))].join(screen.dot),
    facts.join(screen.dot),
  ]);
}

/** A failed command: the banner, its problems and the exit code. */
export function commandFailed(screen: Screen, title: string, problems: readonly Problem[], exitCode: number, footer?: string): number {
  screen.banner("failed", title);
  screen.problems(problems);
  screen.footer(footer ?? screen.t.failure.exit(exitCode));
  return exitCode;
}

/** Lines `from..to` of a file around `line` (1-based) for a code frame. */
export function readFrameLines(file: string, line: number, around = 2): (readonly [number, string])[] {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const from = Math.max(1, line - around), to = Math.min(lines.length, line + around);
    const result: (readonly [number, string])[] = [];
    for (let number = from; number <= to; number += 1) result.push([number, lines[number - 1] ?? ""]);
    return result;
  } catch {
    return [];
  }
}

export function took(screen: Screen, ms: number): string {
  return screen.muted(formatDuration(ms));
}

export { PALETTE };
