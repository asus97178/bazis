/**
 * Terminal capabilities and colour helpers. Every helper degrades to plain
 * text when colour is off, so the same rendering code serves a terminal, a CI
 * log and a file.
 */

export interface TerminalStyle {
  /** 24-bit colour escapes. */
  readonly color: boolean;
  /** Spinners and in-place redraws: only on an interactive terminal. */
  readonly animate: boolean;
  /** Clickable OSC 8 links. */
  readonly links: boolean;
  /** Columns for full-width lines (clamped to 72..110). */
  readonly width: number;
}

interface StreamLike {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

/**
 * Colour on an interactive terminal; `NO_COLOR` turns it off and
 * `FORCE_COLOR` (anything but `0`) turns it on, as in other CLIs. CI logs and
 * redirected output get plain text without animation.
 */
export function detectTerminal(stream: StreamLike = process.stdout, env: NodeJS.ProcessEnv = process.env): TerminalStyle {
  const interactive = stream.isTTY === true && env.TERM !== "dumb" && !env.CI;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const color = env.NO_COLOR === undefined && (forced || interactive);
  const columns = typeof stream.columns === "number" && stream.columns > 0 ? stream.columns - 4 : 96;
  return Object.freeze({ color, animate: interactive, links: color && interactive, width: Math.max(72, Math.min(110, columns)) });
}

export const PLAIN: TerminalStyle = Object.freeze({ color: false, animate: false, links: false, width: 96 });

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

/** Colour at position `t` (0..1) of a gradient through `stops`. */
export function colorAt(stops: readonly string[], t: number): string {
  if (stops.length === 1) return stops[0]!;
  const segment = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  return mix(stops[segment]!, stops[segment + 1]!, t * (stops.length - 1) - segment);
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

/** Text as the terminal shows it: escapes removed. */
export function plain(text: string): string {
  return text.replace(ANSI, "");
}

/** Visible width in columns. */
export function widthOf(text: string): number {
  return [...plain(text)].length;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - widthOf(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - widthOf(text))) + text;
}

/** Colour primitives bound to one terminal: no-ops when colour is off. */
export class Paint {
  constructor(readonly style: TerminalStyle) {}

  fg(hex: string, text: string): string {
    if (!this.style.color) return text;
    const [r, g, b] = rgb(hex);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }

  bg(hex: string, text: string): string {
    if (!this.style.color) return text;
    const [r, g, b] = rgb(hex);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
  }

  bold(text: string): string {
    return this.style.color ? `\x1b[1m${text}\x1b[22m` : text;
  }

  gradient(text: string, stops: readonly string[]): string {
    if (!this.style.color) return text;
    const chars = [...text];
    return chars.map((char, index) => this.fg(colorAt(stops, chars.length === 1 ? 0 : index / (chars.length - 1)), char)).join("");
  }

  gradientBg(text: string, stops: readonly string[], ink: string): string {
    if (!this.style.color) return text;
    const chars = [...text];
    return chars.map((char, index) => this.bg(colorAt(stops, chars.length === 1 ? 0 : index / (chars.length - 1)), this.fg(ink, this.bold(char)))).join("");
  }

  /** A clickable link where the terminal supports it, otherwise the URL itself. */
  link(url: string, color: string): string {
    const text = this.bold(this.fg(color, url));
    if (!this.style.links) return text;
    return `\x1b]8;;${url}\x1b\\\x1b[4m${text}\x1b[24m\x1b]8;;\x1b\\`;
  }
}

/** The bazis palette. */
export const PALETTE = Object.freeze({
  brand: ["#00f0ff", "#7b61ff", "#ff2ee6"] as readonly string[],
  success: ["#00c853", "#3dff7a", "#00f0ff"] as readonly string[],
  failure: ["#ff2e5b", "#ff3d8b", "#ff2ee6"] as readonly string[],
  lime: "#3dff7a",
  green: "#00c853",
  yellow: "#ffe14d",
  orange: "#ff9f1c",
  red: "#ff2e5b",
  pink: "#ff2ee6",
  white: "#ffffff",
  text: "#f1f5f9",
  muted: "#8b9bb4",
  faint: "#4b5a78",
  ink: "#0b1020",
  panel: "#1b2140",
  link: "#5ce1ff",
  route: "#ffd60a",
  service: "#c77dff",
  table: "#00d4ff",
  job: "#ff8c42",
  tool: "#ff4fd8",
  export: "#7ee8fa",
  methods: { GET: "#3dff7a", POST: "#ffd60a", PUT: "#4cc9f0", PATCH: "#c77dff", DELETE: "#ff2e5b", HEAD: "#8b9bb4", OPTIONS: "#8b9bb4" } as Readonly<Record<string, string>>,
});
