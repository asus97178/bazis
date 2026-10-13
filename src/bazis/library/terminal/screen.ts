import { detectLanguage, type Language } from "./language";
import { messages, type Messages } from "./messages";
import { detectTerminal, Paint, PALETTE, colorAt, padEnd, padStart, widthOf, type TerminalStyle } from "./style";

/** Where a screen writes: `process.stdout`, `process.stderr` or a test buffer. */
export interface ScreenOutput {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

export type Status = "ok" | "fail" | "skip" | "warn" | "up" | "down" | "wait" | "info";

/** One problem of a failure screen: what, where, why and how to fix it. */
export interface Problem {
  /** Short class of the problem: `CONFIG`, `INFRA`, `DI`, `TIMEOUT`, `CODEGEN`. */
  readonly tag: string;
  /** Key, connection or `file:line`. */
  readonly where: string;
  readonly cause: string;
  readonly fixes?: readonly string[];
  readonly frame?: CodeFrame;
  /** Stable error code, such as `BAZIS_DI_DEPENDENCY_UNKNOWN`. */
  readonly code?: string;
  readonly declaredIn?: string;
  /** Extra lines (for example a stack) printed after the fixes. */
  readonly details?: readonly string[];
}

/** Lines around an error position, with the marked column range. */
export interface CodeFrame {
  /** `[lineNumber, text]` pairs in order. */
  readonly lines: readonly (readonly [number, string])[];
  readonly line: number;
  /** 1-based start column and length of the marked span. */
  readonly column?: number;
  readonly length?: number;
  readonly label?: string;
}

export interface TreeRow {
  readonly text: string;
  /** Rows nested under this one. */
  readonly children?: readonly TreeRow[];
}

const LOGO = Object.freeze(["█▀▀▄ ▄▀▀▄ ▀▀▀█ ▀█▀ █▀▀▀", "█▀▀▄ █▀▀█ ▄▀▀  ░█░ ▀▀▀█", "▀▀▀  ▀  ▀ ▀▀▀▀ ▀▀▀ ▀▀▀▀"]);
const SPINNER = Object.freeze(["◜", "◠", "◝", "◞", "◡", "◟"]);
const STEP_LABEL = 16;
const TIME = 8;

/** Mode badges of the logo: the command that runs. */
export const MODE = Object.freeze({
  dev: [PALETTE.yellow, PALETTE.orange] as readonly string[],
  test: ["#4cc9f0", "#7b61ff"] as readonly string[],
  build: ["#00f0ff", "#3dff7a"] as readonly string[],
  prod: [PALETTE.green, PALETTE.lime] as readonly string[],
  new: ["#ff2ee6", "#7b61ff"] as readonly string[],
  gen: ["#c77dff", "#ff2ee6"] as readonly string[],
  codegen: ["#00f0ff", "#c77dff"] as readonly string[],
});

/**
 * One terminal screen: the logo header, sections, steps with a spinner,
 * success and failure banners, panels and problem boxes. The same calls give
 * plain text without colour or animation when the output is not a terminal,
 * so CI logs keep the structure.
 */
export class Screen {
  readonly paint: Paint;
  readonly t: Messages;
  readonly style: TerminalStyle;
  readonly language: Language;
  private readonly badgeWidth: number;

  constructor(readonly output: ScreenOutput = process.stdout, options: { style?: TerminalStyle; language?: Language } = {}) {
    this.style = options.style ?? detectTerminal(output);
    this.language = options.language ?? detectLanguage();
    this.t = messages(this.language);
    this.paint = new Paint(this.style);
    this.badgeWidth = Math.max(...Object.values(this.t.badge).map((label) => widthOf(label))) + 2;
  }

  get width(): number {
    return this.style.width;
  }

  line(text = ""): void {
    this.output.write(`${text}\n`);
  }

  // ── text helpers ──────────────────────────────────────────────────────────

  fg(color: string, text: string): string { return this.paint.fg(color, text); }
  bold(text: string): string { return this.paint.bold(text); }
  strong(text: string, color: string = PALETTE.white): string { return this.paint.bold(this.paint.fg(color, text)); }
  muted(text: string): string { return this.paint.fg(PALETTE.muted, text); }
  faint(text: string): string { return this.paint.fg(PALETTE.faint, text); }
  text(text: string): string { return this.paint.fg(PALETTE.text, text); }
  /** Code, a variable or a command inside a sentence. */
  code(text: string): string { return this.paint.bold(this.paint.fg(PALETTE.yellow, text)); }
  link(url: string): string { return this.paint.link(url, PALETTE.link); }
  get dot(): string { return this.faint(" · "); }
  /** `12 files`: the number stands out. */
  num(value: number | string, word: string, color: string = PALETTE.white): string {
    return `${this.strong(String(value), color)} ${this.muted(word)}`;
  }
  kv(key: string, value: string): string { return `${this.muted(key)} ${value}`; }
  cause(text: string): string { return `${this.strong("✖", PALETTE.red)}  ${this.text(text)}`; }
  fix(text: string): string { return `${this.strong("➜", PALETTE.lime)}  ${text}`; }

  badge(status: Status): string {
    const label = this.t.badge[status];
    const text = this.bold(padEnd(` ${label}`, this.badgeWidth));
    if (!this.style.color) return `[${padEnd(label, this.badgeWidth - 2)}]`;
    switch (status) {
      case "ok": return this.paint.bg(PALETTE.green, this.paint.fg(PALETTE.ink, text));
      case "fail": return this.paint.bg(PALETTE.red, this.paint.fg(PALETTE.white, text));
      case "skip": return this.paint.bg("#2a3350", this.paint.fg(PALETTE.muted, text));
      case "warn": return this.paint.bg("#b45309", this.paint.fg(PALETTE.white, text));
      case "up": return this.paint.bg("#0e3b2a", this.paint.fg(PALETTE.lime, text));
      case "down": return this.paint.bg("#4a0f1d", this.paint.fg(PALETTE.red, text));
      case "wait": return this.paint.bg("#4a3a0f", this.paint.fg(PALETTE.orange, text));
      case "info": return this.paint.bg("#1b2a4a", this.paint.fg(PALETTE.link, text));
    }
  }

  // ── blocks ────────────────────────────────────────────────────────────────

  /** The logo with a mode badge and three lines of facts next to it. */
  header(mode: string, stops: readonly string[], meta: readonly string[]): void {
    this.line();
    const badge = this.style.color ? this.paint.gradientBg(`  ${mode.toUpperCase()}  `, stops, PALETTE.ink) : `[${mode.toUpperCase()}]`;
    for (let index = 0; index < LOGO.length; index += 1) {
      const logo = this.style.color ? this.paint.gradient(LOGO[index]!, PALETTE.brand) : LOGO[index]!;
      const lead = index === 0 ? `${badge}  ` : "";
      this.line(`  ${logo}    ${lead}${meta[index] ?? ""}`);
    }
    this.line();
  }

  /** `── TITLE ────── aside`; red when the stage failed. */
  section(title: string, aside = "", failed = false): void {
    const label = ` ${title} `;
    const rule = "─".repeat(Math.max(4, this.width - widthOf(label) - widthOf(aside) - 6));
    const lead = failed ? this.fg(PALETTE.red, "──") : this.paint.gradient("──", PALETTE.brand);
    const tail = this.style.color ? this.paint.gradient(rule, failed ? ["#5c1a2a", "#26304d"] : [PALETTE.faint, "#26304d"]) : rule;
    this.line(`  ${lead}${this.strong(label, failed ? PALETTE.red : PALETTE.white)}${tail}${aside ? ` ${aside}` : ""}`);
  }

  /** A finished step: badge, label, details and the time on the right. */
  step(status: Status, label: string, detail = "", time = ""): void {
    const color = status === "fail" ? PALETTE.red : status === "skip" ? PALETTE.muted : PALETTE.white;
    const width = Math.max(10, this.width - STEP_LABEL - TIME - this.badgeWidth - 4);
    this.line(`  ${this.badge(status)}  ${padEnd(this.strong(label, color), STEP_LABEL)}${padEnd(detail, width)}${padStart(this.muted(time), TIME)}`);
  }

  /**
   * A step in progress: a spinner on a terminal, nothing elsewhere. The
   * returned function clears the line; the caller then prints the result
   * with {@link step}.
   */
  progress(label: string, note?: () => string): () => void {
    if (!this.style.animate) return () => undefined;
    let frame = 0;
    const draw = () => {
      const spinner = this.paint.bg(PALETTE.panel, this.strong(` ${SPINNER[frame % SPINNER.length]} `, colorAt(PALETTE.brand, (frame % 12) / 11)));
      frame += 1;
      this.output.write(`\r\x1b[2K  ${spinner}   ${this.strong(label, PALETTE.text)}${this.muted(" …")}${note ? ` ${note()}` : ""}`);
    };
    draw();
    const timer = setInterval(draw, 80);
    timer.unref?.();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.output.write("\r\x1b[2K");
    };
  }

  /** Runs `work` with a spinner and prints its step line. */
  async run<T>(label: string, work: () => Promise<T>, done: (result: T, ms: number) => { status?: Status; detail?: string } = () => ({})): Promise<T> {
    const started = performance.now();
    const stop = this.progress(label);
    try {
      const result = await work();
      stop();
      const ms = performance.now() - started;
      const shown = done(result, ms);
      this.step(shown.status ?? "ok", label, shown.detail ?? "", formatDuration(ms));
      return result;
    } catch (error) {
      stop();
      this.step("fail", label, "", formatDuration(performance.now() - started));
      throw error;
    }
  }

  /** Rows under a step, drawn as a tree: `├─`, `│`, `└─`. */
  tree(rows: readonly TreeRow[], indent = 9): void {
    const walk = (items: readonly TreeRow[], prefix: string) => {
      items.forEach((row, index) => {
        const last = index === items.length - 1;
        this.line(`${" ".repeat(indent)}${this.faint(prefix + (last ? "└─ " : "├─ "))}${row.text}`);
        if (row.children?.length) walk(row.children, prefix + (last ? "   " : "│  "));
      });
    };
    walk(rows, "");
  }

  /** A full-width gradient banner: SUCCESS / FAILED and what it means. */
  banner(kind: "success" | "failed", text: string): void {
    const word = kind === "success" ? this.t.banner.success : this.t.banner.failed;
    const icon = kind === "success" ? "✔" : "✖";
    const content = `  ${icon}  ${word}   ${text}`;
    if (!this.style.color) {
      const rule = "═".repeat(this.width);
      this.line(`  ${rule}`);
      this.line(`  ${content}`);
      this.line(`  ${rule}`);
      this.line();
      return;
    }
    const stops = kind === "success" ? PALETTE.success : PALETTE.failure;
    const ink = kind === "success" ? PALETTE.ink : PALETTE.white;
    const width = Math.max(this.width, widthOf(content) + 2);
    this.line(`  ${this.paint.gradientBg(" ".repeat(width), stops, ink)}`);
    this.line(`  ${this.paint.gradientBg(padEnd(content, width), stops, ink)}`);
    this.line(`  ${this.paint.gradientBg(" ".repeat(width), stops, ink)}`);
    this.line();
  }

  /** A rounded box with gradient borders: links and next steps. */
  panel(rows: readonly string[]): void {
    const width = this.width - 2;
    const stops = ["#00f0ff", "#7b61ff"];
    const border = (text: string) => this.style.color ? this.paint.gradient(text, stops) : text;
    this.line(`  ${border(`╭${"─".repeat(width)}╮`)}`);
    for (const row of rows) {
      this.line(`  ${this.fg("#00f0ff", "│")} ${padEnd(row, width - 1)}${this.fg("#7b61ff", "│")}`);
    }
    this.line(`  ${border(`╰${"─".repeat(width)}╯`)}`);
  }

  /** `➜  Label     value` row of a {@link panel}. */
  panelRow(label: string, value: string): string {
    return `${this.strong("➜", PALETTE.lime)}  ${padEnd(this.strong(label), 11)}${value}`;
  }

  /** One problem box: `1/2 CONFIG db.password`, the cause, a code frame, the fixes. */
  problem(index: number, total: number, problem: Problem): void {
    const width = this.width - 2;
    const stops = [PALETTE.red, PALETTE.pink];
    const counter = this.style.color ? this.paint.bg(PALETTE.red, this.strong(` ${index}/${total} `)) : `${index}/${total}`;
    const tag = this.style.color ? this.paint.bg("#4a0f1d", this.strong(` ${problem.tag} `, PALETTE.red)) : `[${problem.tag}]`;
    const title = ` ${counter} ${tag} ${this.strong(problem.where)} `;
    const fill = "─".repeat(Math.max(2, width - widthOf(title) - 1));
    this.line(`  ${this.fg(PALETTE.red, "╭─")}${title}${this.style.color ? this.paint.gradient(fill, stops) : fill}${this.fg(PALETTE.pink, "╮")}`);
    const rows: string[] = [];
    for (const [lineIndex, causeLine] of problem.cause.split("\n").entries()) rows.push(lineIndex === 0 ? this.cause(causeLine) : `   ${this.text(causeLine)}`);
    if (problem.frame) rows.push("", ...this.frame(problem.frame));
    if (problem.fixes?.length) rows.push("", ...problem.fixes.map((fix) => this.fix(fix)));
    if (problem.declaredIn) rows.push(`${this.faint(`   ${this.t.common.declaredIn}`)} ${this.text(problem.declaredIn)}`);
    if (problem.code) rows.push(`${this.faint(`   ${this.t.common.code}`)} ${this.muted(problem.code)}`);
    if (problem.details?.length) rows.push("", ...problem.details.map((detail) => this.faint(detail)));
    for (const row of rows) {
      for (const piece of wrap(row, width - 1)) this.line(`  ${this.fg(PALETTE.red, "│")} ${padEnd(piece, width - 1)}${this.fg(PALETTE.pink, "│")}`);
    }
    this.line(`  ${this.style.color ? this.paint.gradient(`╰${"─".repeat(width)}╯`, stops) : `╰${"─".repeat(width)}╯`}`);
  }

  /** Every problem with a blank line between them. */
  problems(problems: readonly Problem[]): void {
    problems.forEach((problem, index) => {
      this.problem(index + 1, problems.length, problem);
      this.line();
    });
  }

  frame(frame: CodeFrame): string[] {
    const numberWidth = Math.max(...frame.lines.map(([number]) => String(number).length));
    const rows: string[] = [];
    for (const [number, text] of frame.lines) {
      const gutter = `${padStart(String(number), numberWidth + 2)} │`;
      if (number !== frame.line) {
        rows.push(`${this.faint(gutter)} ${this.muted(text)}`);
        continue;
      }
      const column = frame.column ?? 0;
      const length = Math.max(1, frame.length ?? 1);
      const marked = column > 0
        ? `${this.text(text.slice(0, column - 1))}${this.paint.bg("#4a0f1d", this.strong(text.slice(column - 1, column - 1 + length), PALETTE.red))}${this.text(text.slice(column - 1 + length))}`
        : this.text(text);
      rows.push(`${this.strong(gutter, PALETTE.red)} ${marked}`);
      if (column > 0) {
        rows.push(`${this.faint(`${" ".repeat(numberWidth + 2)} │`)} ${this.fg(PALETTE.red, `${" ".repeat(column - 1)}${"^".repeat(length)}${frame.label ? ` ${frame.label}` : ""}`)}`);
      }
    }
    return rows;
  }

  warning(text: string): void {
    this.line(`  ${this.badge("warn")}  ${this.text(text)}`);
  }

  footer(text: string): void {
    this.line(`  ${this.muted(text)}`);
    this.line();
  }

  /** A horizontal bar of a timing chart. */
  bar(label: string, value: number, total: number, color: string, suffix: string): void {
    const size = 46;
    const filled = total > 0 ? Math.max(1, Math.round((value / total) * size)) : 1;
    const bar = this.style.color ? `${this.fg(color, "█".repeat(filled))}${this.fg(PALETTE.panel, "█".repeat(size - filled))}` : `${"#".repeat(filled)}${".".repeat(size - filled)}`;
    this.line(`     ${padEnd(this.muted(label), 18)}${bar} ${padStart(this.text(suffix), 9)}`);
  }

  /** `─── logs ─────` before the application's own output. */
  divider(title: string): void {
    this.line(`  ${this.faint(`─── ${title} ${"─".repeat(Math.max(4, this.width - widthOf(title) - 5))}`)}`);
  }
}

/** `0.4 ms`, `41 ms`, `1.2 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `512 B`, `48 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Splits a styled line by visible width, keeping words together where possible. */
function wrap(text: string, width: number): string[] {
  if (widthOf(text) <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && widthOf(candidate) > width) {
      lines.push(current);
      current = `   ${word}`;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
