import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { colorAt, formatBytes, formatDuration, MODE, PALETTE, Screen, padEnd, type Language, type ScreenOutput, type TreeRow } from "../../../library/terminal";
import type { ConfigInspection } from "../config/defineConfig";
import { ConfigValidationError } from "../config/ConfigValidationError";
import type { Kernel } from "../Kernel";
import { describeModules, type ModuleItem, type ModuleNode } from "./moduleTree";
import type { RouteFact, StartupReport } from "./StartupReport";
import { diagnoseStartupFailure, STARTUP_STAGES, type StartupStage } from "./startupProblems";

export interface StartupScreenOptions {
  readonly stdout?: ScreenOutput;
  readonly stderr?: ScreenOutput;
  readonly language?: Language;
  /** The logo and facts header; off when `bazis dev` already printed it. */
  readonly header?: boolean;
  /** The source directory `bazis dev --watch` restarts on. */
  readonly watch?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Whether the startup screen replaces the log line: `BAZIS_UI=1` turns it on,
 * `BAZIS_UI=0` off; by default it is on for an interactive terminal outside CI.
 */
export function startupScreenEnabled(env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean } = process.stdout): boolean {
  const flag = env.BAZIS_UI?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "log") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return stdout.isTTY === true && !env.CI && env.TERM !== "dumb";
}

const WAIT_DELAY_MS = 400;
const ROUTE_LIMIT = 30;

/**
 * The application's startup screen: what was configured, connected, created
 * and served, and a success banner with the links; or the failed stage with
 * one panel per problem. `Bazis.run` uses it on an interactive terminal.
 */
export class StartupScreen {
  private readonly out: Screen;
  private readonly err: Screen;
  private readonly header: boolean;
  private readonly watch?: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: StartupScreenOptions = {}) {
    this.env = options.env ?? process.env;
    this.out = new Screen(options.stdout ?? process.stdout, { language: options.language });
    this.err = new Screen(options.stderr ?? process.stderr, { language: this.out.language });
    this.header = options.header ?? this.env.BAZIS_UI_HEADER !== "0";
    this.watch = options.watch ?? (this.env.BAZIS_UI_WATCH || undefined);
  }

  /** A spinner while the start takes long, naming what it waits for. Returns its stop. */
  waiting(kernel: Kernel): () => void {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop = this.out.progress(this.out.t.step.connections, () => {
        const pending = kernel.startingServices;
        return pending.length === 0 ? "" : `${this.out.muted(this.out.t.infra.waiting)} ${this.out.strong(pending.join(", "))}`;
      });
    }, WAIT_DELAY_MS);
    timer.unref?.();
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }

  // ── success ───────────────────────────────────────────────────────────────

  started(kernel: Kernel): void {
    const s = this.out;
    const t = s.t;
    const report = kernel.report;
    if (this.header) this.printHeader(s, kernel.environment.name, kernel.environment.isProduction);

    const config = configRows(kernel);
    const sections = groupSections(config);
    const devSecrets = config.filter((row) => row.type === "secret" && (row.source === "default" || row.source === "development"));
    s.section(t.section.configuration, s.muted(t.config.environment(kernel.environment.name)));
    s.step("ok", t.step.config, [s.num(sections.size, t.noun("section", sections.size)), ...(devSecrets.length ? [s.num(devSecrets.length, t.config.devDefault(devSecrets.length), PALETTE.yellow)] : [])].join(s.dot), formatDuration(kernel.buildTimings.configMs));
    s.tree([...sections].map(([name, rows]) => ({
      text: `${padEnd(s.strong(name), 10)}${s.text(rows.filter((row) => row.type !== "secret").map((row) => `${shortKey(row.key)} ${String(row.value)}`).join(" · ") || "—")}`,
      children: rows.filter((row) => row.type === "secret").map((row) => ({
        text: devSecrets.includes(row)
          ? `${s.fg(PALETTE.yellow, shortKey(row.key))} ${s.muted(t.config.devDefaultNote(row.env[0] ?? ""))}`
          : `${s.text(shortKey(row.key))} ${s.muted(`*** · ${row.source}`)}`,
      })),
    })), this.indent);
    s.line();

    const connections = report.connections;
    if (connections.length > 0) {
      const infraMs = stageMs(kernel, "infrastructure");
      s.section(t.section.infrastructure);
      s.step("ok", t.step.connections, `${s.num(connections.length, t.infra.up(connections.length), PALETTE.lime)}${connections.length > 1 ? `${s.dot}${s.muted(t.infra.parallel)}` : ""}`, formatDuration(infraMs));
      s.tree(connections.map((connection) => ({
        text: `${s.badge("up")}  ${padEnd(s.strong(connection.name), 9)}${padEnd(s.strong(connection.kind ?? "", PALETTE.table), 20)}${[
          ...(connection.address ? [s.text(connection.address)] : []),
          ...(connection.details ?? []).map((detail) => s.muted(detail)),
          ...(connection.ms === undefined ? [] : [s.fg(PALETTE.lime, formatDuration(connection.ms))]),
        ].join(s.dot)}`,
      })), this.indent);
      s.line();
    }

    const schemas = report.schemas;
    if (schemas.length > 0) {
      const operations = schemas.flatMap((schema) => [...schema.migrated.map((name) => `migration ${name}`), ...schema.applied]);
      s.section(t.section.schema, s.muted([...new Set(schemas.map((schema) => schema.mode))].join(", ")));
      s.step("ok", t.step.schema, operations.length === 0 ? s.muted(t.schema.none) : [s.num(operations.length, t.noun("operation", operations.length)), s.num(schemas.length, t.noun("schema", schemas.length))].join(s.dot), formatDuration(stageMs(kernel, "schema")));
      const shown = operations.slice(0, 12).map((operation) => ({ text: `${s.strong("+", PALETTE.lime)} ${s.text(operation)}` }));
      if (operations.length > 12) shown.push({ text: s.muted(`… ${t.common.plus} ${operations.length - 12}`) });
      s.tree(shown, this.indent);
      for (const warning of schemas.flatMap((schema) => schema.warnings)) report.warn(warning);
      s.line();
    }

    const routes = report.routeFacts.filter((route) => !route.builtIn);
    const modules = kernel.rootModule === undefined ? [] : describeModules(kernel.rootModule);
    const moduleCount = countModules(modules);
    if (moduleCount > 0) {
      s.section(t.section.modules, [s.num(moduleCount, t.noun("module", moduleCount)), s.num(routes.length, t.noun("route", routes.length))].join(s.dot));
      s.line();
      this.printModules(modules, routes);
      s.line();
    }

    if (routes.length > 0) {
      const open = routes.filter((route) => route.open && route.access !== "anonymous");
      s.section(t.section.routes, [s.num(routes.length, t.noun("route", routes.length)), ...(open.length ? [s.num(open.length, t.routes.open, PALETTE.orange)] : [])].join(s.dot));
      s.line();
      this.printRoutes(routes);
      const builtIn = report.routeFacts.filter((route) => route.builtIn);
      if (builtIn.length) s.line(`     ${s.faint(t.common.plus)} ${builtIn.map((route) => s.text(`${route.method} ${route.path}`)).join(s.dot)}`);
      s.line();
    }

    const warnings = [
      ...(routes.some((route) => route.open && route.access !== "anonymous")
        ? [t.warnings.openRoutes(routes.filter((route) => route.open && route.access !== "anonymous").length)] : []),
      ...devSecrets.map((row) => t.warnings.devSecret(row.key)),
      ...report.warnings,
    ];
    if (warnings.length > 0) {
      s.section(t.section.warnings, s.strong(String(warnings.length), PALETTE.orange));
      for (const warning of warnings) s.warning(warning);
      s.line();
    }

    this.printTimings(kernel);

    const app = appInfo().name ?? "app";
    const total = formatDuration(kernel.startupDurationMs);
    const listener = report.listeners[0];
    s.banner("success", listener === undefined ? t.ready.worker(app, total) : t.ready.running(app, total));
    const rows: string[] = [];
    if (listener !== undefined) {
      rows.push(s.panelRow(t.ready.local, s.link(listener.url)));
      const local = ["127.0.0.1", "localhost", "::1"].includes(listener.hostname);
      rows.push(s.panelRow(t.ready.network, local ? s.muted(t.ready.notExposed(listener.hostname)) : s.link(`http://${networkAddress() ?? listener.hostname}:${listener.port}`)));
      if (listener.health) rows.push(s.panelRow(t.ready.health, s.link(listener.health)));
      if (listener.docs) rows.push(s.panelRow(t.ready.docs, s.link(listener.docs)));
      rows.push("");
    }
    rows.push(s.muted(this.watch === undefined ? t.ready.noWatch : t.ready.watching(this.watch)));
    s.panel(rows);
    s.line();
    s.divider(t.common.logs);
  }

  private get indent(): number {
    return this.out.style.color ? 9 : 4;
  }

  private printModules(modules: readonly ModuleNode[], routes: readonly RouteFact[]): void {
    const s = this.out;
    const t = s.t;
    const icons: Record<ModuleItem["kind"], [string, string, string]> = {
      controller: ["⇄", PALETTE.route, t.modules.controller],
      gateway: ["⇄", PALETTE.route, "gateway"],
      service: ["◆", PALETTE.service, t.modules.service],
      table: ["▦", PALETTE.table, t.modules.table],
      background: ["↻", PALETTE.job, t.modules.background],
      tool: ["✦", PALETTE.tool, t.modules.tool],
      exports: ["↗", PALETTE.export, t.modules.exports],
    };
    const itemText = (item: ModuleItem): string => {
      const [icon, color, label] = icons[item.kind];
      let text = item.text;
      if (item.kind === "controller" && item.controller !== undefined) {
        const own = routes.filter((route) => route.handler.startsWith(`${item.controller}.`));
        text = [item.text, ...(own.length ? [commonPrefix(own.map((route) => route.path))] : []), `${own.length} ${t.noun("route", own.length)}`].join(" · ");
      }
      return `${s.strong(icon, color)} ${padEnd(s.fg(color, label), 11)}${s.text(text)}`;
    };
    const rows = (nodes: readonly ModuleNode[]): TreeRow[] => nodes.map((node) => {
      const pack = node.pack ? ` ${s.style.color ? s.paint.gradientBg(" PACK ", ["#7b61ff", "#ff2ee6"], PALETTE.white) : "[PACK]"}` : "";
      const items = node.items.map((item) => ({ text: itemText(item) }));
      const empty = items.length === 0 && node.children.length === 0 ? [{ text: s.muted(t.modules.emptyHint) }] : [];
      return { text: `${s.strong(node.name)}${pack}`, children: [...items, ...empty, ...rows(node.children)] };
    });
    const roots = modules.length === 1 ? modules[0]! : undefined;
    if (roots !== undefined) {
      s.line(`     ${s.bold(s.style.color ? s.paint.gradient(`◉ ${roots.name}`, PALETTE.brand) : `◉ ${roots.name}`)}`);
      const body = [...roots.items.map((item) => ({ text: itemText(item) })), ...rows(roots.children)];
      s.tree(body.length > 0 ? body : [{ text: s.muted(t.modules.emptyHint) }], 5);
    } else {
      s.tree(rows(modules), 5);
    }
  }

  private printRoutes(routes: readonly RouteFact[]): void {
    const s = this.out;
    const t = s.t;
    const shown = routes.slice(0, ROUTE_LIMIT);
    const pathWidth = Math.min(34, Math.max(...shown.map((route) => route.path.length)) + 2);
    const handlerWidth = Math.min(34, Math.max(...shown.map((route) => route.handler.length)) + 2);
    for (const route of shown) {
      const color = PALETTE.methods[route.method] ?? PALETTE.muted;
      const method = s.style.color ? s.paint.bg(colorAt([color, PALETTE.ink], 0.75), s.strong(padEnd(` ${route.method}`, 8), color)) : padEnd(route.method, 7);
      const access = route.access === "anonymous" ? s.muted(`○ ${t.routes.open}`) : route.open ? s.fg(PALETTE.orange, `○ ${t.routes.open}`) : s.fg(PALETTE.lime, `🔒 ${t.routes.protected}`);
      s.line(`     ${method}  ${padEnd(s.text(route.path), pathWidth)}${padEnd(s.muted(route.handler), handlerWidth)}${access}${route.notes?.length ? `  ${s.faint(route.notes.join(" · "))}` : ""}`);
    }
    if (routes.length > shown.length) s.line(`     ${s.muted(`… ${t.common.plus} ${routes.length - shown.length}`)}`);
  }

  private printTimings(kernel: Kernel): void {
    const s = this.out;
    const t = s.t;
    const memory = process.memoryUsage().rss;
    s.section(t.section.startup, `${s.muted(t.common.memory)} ${s.text(formatBytes(memory))}`);
    const bars: [string, number, string][] = [
      [t.startup.configuration, kernel.buildTimings.configMs, "#00f0ff"],
      [t.startup.container, kernel.buildTimings.containerMs, "#4cc9f0"],
      [t.startup.infrastructure, stageMs(kernel, "infrastructure"), "#7b61ff"],
      [t.startup.schema, stageMs(kernel, "schema"), "#b15cff"],
      [t.startup.services, stageMs(kernel, "services"), "#ff2ee6"],
    ];
    const total = Math.max(kernel.startupDurationMs, ...bars.map((bar) => bar[1]));
    for (const [label, ms, color] of bars) s.bar(label, ms, total, color, formatDuration(ms));
    s.line();
  }

  private printHeader(s: Screen, environment: string, production: boolean): void {
    const t = s.t;
    const app = appInfo();
    const mode = environment === "development" ? "dev" : environment === "test" ? "test" : "prod";
    const main = Bun.main ? path.relative(process.cwd(), Bun.main) || Bun.main : "";
    s.header(mode, MODE[mode as keyof typeof MODE] ?? MODE.prod, [
      `${s.strong(app.name ?? "app")}${app.version ? ` ${s.muted(app.version)}` : ""}`,
      [s.kv("bazis", s.text(bazisVersion() ?? "?")), s.kv("bun", s.text(Bun.version)), s.kv(t.meta.pid, s.text(String(process.pid)))].join(s.dot),
      [
        s.kv(t.meta.env, s.strong(environment, production ? PALETTE.lime : PALETTE.yellow)),
        s.kv(t.meta.watch, this.watch === undefined ? s.muted(t.meta.off) : s.strong(t.meta.on, PALETTE.lime)),
        ...(main ? [s.kv(t.meta.src, s.text(main))] : []),
      ].join(s.dot),
    ]);
  }

  // ── failure ───────────────────────────────────────────────────────────────

  /** The failed stage with the stages before and after it, and one panel per problem. */
  failed(error: unknown, kernel?: Kernel, built?: StartupReport): void {
    const s = this.err;
    const t = s.t;
    const report: StartupReport | undefined = kernel?.report ?? built;
    const diagnosis = diagnoseStartupFailure(error, s, { report, failedServices: kernel?.failedServices });
    if (this.header) this.printHeader(s, kernel?.environment.name ?? process.env.BAZIS_ENV ?? process.env.NODE_ENV ?? "development", (kernel?.environment.isProduction) ?? false);

    const failedIndex = STARTUP_STAGES.indexOf(diagnosis.stage);
    const titles: Record<StartupStage, [string, string]> = {
      configuration: [t.section.configuration, t.step.config],
      modules: [t.section.modules, t.step.modules],
      infrastructure: [t.section.infrastructure, t.step.connections],
      schema: [t.section.schema, t.step.schema],
      services: [t.section.startup, t.step.services],
    };
    const skipReason: Partial<Record<StartupStage, string>> = {
      configuration: t.failure.skipConfig,
      infrastructure: t.failure.skipInfra,
    };
    STARTUP_STAGES.forEach((stage, index) => {
      const [section, step] = titles[stage];
      if (index < failedIndex) {
        // Stages that did not run at all (no connections, no schema) stay out.
        const detail = this.passedDetail(stage, kernel, report);
        if (detail === undefined) return;
        s.section(section);
        s.step("ok", step, detail);
        s.line();
        return;
      }
      if (index === failedIndex) {
        const problems = diagnosis.problems.length;
        s.section(section, s.strong(`${problems} ${t.noun("problem", problems)}`, PALETTE.red), true);
        s.step("fail", step, this.failedDetail(stage, kernel, diagnosis.problems.length));
        this.failedTree(stage, error, kernel);
        s.line();
        return;
      }
      if (index === failedIndex + 1 || (stage === "services" && index > failedIndex)) {
        s.section(section);
        s.step("skip", step, s.muted(skipReason[diagnosis.stage] ?? t.failure.skipEarlier));
        s.line();
      }
    });

    s.banner("failed", diagnosis.title);
    s.problems(diagnosis.problems);
    s.footer(this.watch === undefined ? t.failure.exitNothing(1) : t.failure.exitWatch(1, this.watch));
  }

  private passedDetail(stage: StartupStage, kernel: Kernel | undefined, report: StartupReport | undefined): string | undefined {
    const s = this.err;
    const t = s.t;
    if (stage === "configuration") {
      const count = groupSections(report?.config ?? []).size;
      return s.num(count, t.noun("section", count));
    }
    if (kernel === undefined) return undefined;
    if (stage === "modules") {
      const count = kernel.rootModule === undefined ? 0 : countModules(describeModules(kernel.rootModule));
      return s.num(count, t.noun("module", count));
    }
    if (stage === "infrastructure") {
      const connections = kernel.report.connections;
      return connections.length === 0 ? undefined : s.num(connections.length, t.infra.up(connections.length), PALETTE.lime);
    }
    if (stage === "schema") {
      const operations = kernel.report.schemas.reduce((sum, schema) => sum + schema.applied.length + schema.migrated.length, 0);
      return kernel.report.schemas.length === 0 ? undefined : s.num(operations, t.noun("operation", operations));
    }
    return undefined;
  }

  private failedDetail(stage: StartupStage, kernel: Kernel | undefined, problems: number): string {
    const s = this.err;
    const t = s.t;
    if (stage === "infrastructure" && kernel !== undefined) {
      const connections = kernel.report.connections;
      const down = connections.filter((connection) => connection.status !== "up").length;
      return `${s.num(down, t.infra.failed(connections.length), PALETTE.red)}${connections.length > 1 ? `${s.dot}${s.muted(t.infra.parallel)}` : ""}`;
    }
    return s.num(problems, t.noun("problem", problems), PALETTE.red);
  }

  private failedTree(stage: StartupStage, error: unknown, kernel: Kernel | undefined): void {
    const s = this.err;
    if (stage === "configuration" && error instanceof ConfigValidationError) {
      const sections = new Map<string, string[]>();
      for (const issue of error.issues) sections.set(issue.section || "app", [...(sections.get(issue.section || "app") ?? []), shortKey(issue.key)]);
      s.tree([...sections].map(([name, keys]) => ({ text: `${padEnd(s.strong(name, PALETTE.red), 10)}${keys.map((key) => s.fg(PALETTE.red, key)).join(s.dot)}` })), this.indent);
      return;
    }
    if (stage !== "infrastructure" || kernel === undefined) return;
    s.tree(kernel.report.connections.map((connection) => {
      const status = connection.status === "up" ? "up" : connection.status === "wait" ? "wait" : "down";
      const reason = connection.status === "up"
        ? [connection.kind ? s.text(connection.kind) : "", connection.ms === undefined ? "" : s.fg(PALETTE.lime, formatDuration(connection.ms))].filter(Boolean).join(s.dot)
        : connection.status === "wait"
          ? s.fg(PALETTE.orange, s.t.infra.connectTimeout(error instanceof Error && "timeoutMs" in error ? `${Number((error as { timeoutMs: number }).timeoutMs) / 1000} s` : "…"))
          : s.fg(PALETTE.red, firstLine(connection.error));
      return { text: `${s.badge(status)}  ${padEnd(s.strong(connection.name), 9)}${padEnd(s.fg(PALETTE.table, (connection.kind ?? "").split(" ")[0] ?? ""), 13)}${reason}` };
    }), this.indent);
  }
}

function configRows(kernel: Kernel): readonly ConfigInspection[] {
  return kernel.report.config;
}

/** Rows by config prefix: `db.host` → `db`. */
function groupSections(rows: readonly ConfigInspection[]): Map<string, ConfigInspection[]> {
  const sections = new Map<string, ConfigInspection[]>();
  for (const row of rows) {
    const name = row.key.includes(".") ? row.key.slice(0, row.key.indexOf(".")) : "app";
    sections.set(name, [...(sections.get(name) ?? []), row]);
  }
  return sections;
}

function shortKey(key: string): string {
  return key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
}

function stageMs(kernel: Kernel, stage: "infrastructure" | "schema" | "services"): number {
  return kernel.startTimings
    .filter((timing) => {
      const name = timing.names[0] ?? "";
      if (name.startsWith("infra:")) return stage === "infrastructure";
      if (name.startsWith("schema:") || timing.phase < 0) return stage === "schema";
      return stage === "services";
    })
    .reduce((sum, timing) => sum + timing.ms, 0);
}

function countModules(nodes: readonly ModuleNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countModules(node.children), 0);
}

function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "/";
  const split = paths.map((value) => value.split("/").filter(Boolean));
  const first = split[0]!;
  let length = 0;
  while (length < first.length && !first[length]!.startsWith(":") && split.every((parts) => parts[length] === first[length])) length += 1;
  return `/${first.slice(0, length).join("/")}`;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Infra connector "[^"]+": /, "").split("\n")[0] ?? "";
}

let cachedApp: { name?: string; version?: string } | undefined;

/** Name and version of the application from `package.json` of the working directory. */
function appInfo(): { name?: string; version?: string } {
  if (cachedApp !== undefined) return cachedApp;
  try {
    const json = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    cachedApp = { ...(typeof json.name === "string" ? { name: json.name } : {}), ...(typeof json.version === "string" ? { version: json.version } : {}) };
  } catch {
    cachedApp = {};
  }
  return cachedApp;
}

let cachedBazis: string | undefined | null = null;

function bazisVersion(): string | undefined {
  if (cachedBazis !== null) return cachedBazis;
  try {
    const file = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    cachedBazis = typeof version === "string" ? version : undefined;
  } catch {
    cachedBazis = undefined;
  }
  return cachedBazis;
}

/** The first external IPv4 address, for the Network link. */
function networkAddress(): string | undefined {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const item of list ?? []) if (item.family === "IPv4" && !item.internal) return item.address;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
