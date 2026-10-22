import { DiError, isConfigurationError } from "../../di";
import { ServiceValidationError } from "../../di/errors/ServiceValidationError";
import { redactSensitiveText } from "../../../library/redaction";
import type { Problem, Screen } from "../../../library/terminal";
import { ConfigValidationError, type ConfigIssue } from "../config/ConfigValidationError";
import { KernelError, StartupFailuresError, StartupTimeoutError } from "../errors";
import type { ConnectionFact, StartupReport } from "./StartupReport";
import { formatStartupFailure } from "../startupFailure";

/** Startup stages in execution order. */
export const STARTUP_STAGES = ["configuration", "modules", "infrastructure", "schema", "services"] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];

/** Which stage failed, the banner text and one problem per cause. */
export interface StartupDiagnosis {
  readonly stage: StartupStage;
  readonly title: string;
  readonly problems: readonly Problem[];
}

export interface StartupFailureContext {
  readonly report?: StartupReport;
  /** Hosted services whose start failed. */
  readonly failedServices?: readonly string[];
}

/**
 * Turns a startup failure into problems a person can act on: every invalid
 * configuration key, every refused connection, a missing DI registration with
 * what to connect. An unknown error keeps its text and stack.
 */
export function diagnoseStartupFailure(error: unknown, screen: Screen, context: StartupFailureContext = {}): StartupDiagnosis {
  const t = screen.t;
  if (error instanceof ConfigValidationError) {
    const problems = error.issues.map((issue) => configProblem(issue, screen));
    return { stage: "configuration", title: t.failure.config(problems.length), problems };
  }
  if (error instanceof StartupTimeoutError) {
    const seconds = `${Math.round(error.timeoutMs / 100) / 10} s`;
    const pending = error.pending ?? "";
    return {
      stage: stageOf(pending.split(", ")[0] ?? ""),
      title: t.failure.timeout(seconds),
      problems: [{
        tag: "TIMEOUT",
        where: pending || "start",
        cause: t.failure.timeoutCause(pending || "start", seconds),
        fixes: [t.infra.hint.deadline, screen.code(t.infra.hint.raiseLimit)],
      }],
    };
  }
  const down = (context.report?.connections ?? []).filter((connection) => connection.status === "down");
  if (down.length > 0) {
    const total = context.report?.connections.length ?? down.length;
    return { stage: "infrastructure", title: t.failure.infra(down.length, total), problems: down.map((connection) => connectionProblem(connection, screen)) };
  }
  if (error instanceof ServiceValidationError) {
    return { stage: "modules", title: t.failure.di, problems: diProblems(error.issues, screen) };
  }
  if (error instanceof DiError) {
    return { stage: "modules", title: t.failure.di, problems: diProblems([error.message], screen) };
  }
  if (error instanceof StartupFailuresError) {
    return {
      stage: stageOf(error.failures[0]?.name ?? ""),
      title: t.failure.app,
      problems: error.failures.map((failure) => genericProblem(failure.error, failure.name)),
    };
  }
  const failed = context.failedServices?.[0];
  const stage = (error instanceof KernelError || isConfigurationError(error)) && failed === undefined ? "configuration" : stageOf(failed ?? "");
  return { stage, title: t.failure.app, problems: [genericProblem(error, failed)] };
}

/** `infra:db` → infrastructure, `schema:TaskDbContext` → schema, the rest → services. */
function stageOf(name: string): StartupStage {
  if (name.startsWith("infra:")) return "infrastructure";
  if (name.startsWith("schema:")) return "schema";
  return "services";
}

function configProblem(issue: ConfigIssue, screen: Screen): Problem {
  const t = screen.t;
  const variables = issue.env.map((name) => screen.code(name)).join(" / ");
  const causes: Record<ConfigIssue["kind"], string> = {
    "missing-secret": t.config.issue.missingSecret,
    "empty-secret": t.config.issue.emptySecret,
    "development-secret": t.config.issue.devSecret,
    number: t.config.issue.number,
    boolean: t.config.issue.boolean,
    string: t.config.issue.string,
    enum: t.config.issue.enumValue((issue.allowed ?? []).join(", ")),
    validator: issue.message,
    conflict: t.config.issue.conflict,
  };
  const fixes: string[] = [];
  if (issue.kind === "missing-secret") fixes.push(`${t.config.fix.setVariable(variables)}, ${t.config.fix.orSecretFile}`);
  else if (issue.kind === "empty-secret") fixes.push(t.config.fix.emptySecret);
  else if (issue.kind === "development-secret") fixes.push(t.config.fix.setVariable(variables), t.config.fix.orProduction(screen.code(issue.key.split(".").at(-1) ?? issue.key)));
  else fixes.push(t.config.fix.change(issue.source === undefined ? variables : screen.code(issue.source)));
  // The wrong value and the variable that brought it.
  const got = /got (".*?") \((\S+)\)$|^(".*?") is not allowed.*\((\S+)\)$/.exec(issue.message);
  const detail = got === null ? "" : `\n${t.config.issue.got(redactSensitiveText(got[1] ?? got[3] ?? ""), got[2] ?? got[4] ?? "")}`;
  return {
    tag: "CONFIG",
    where: issue.key,
    cause: `${causes[issue.kind]}${detail}`,
    fixes,
    ...(issue.declaredIn === undefined ? {} : { declaredIn: issue.declaredIn }),
  };
}

function connectionProblem(connection: ConnectionFact, screen: Screen): Problem {
  const t = screen.t;
  const message = redactSensitiveText(errorText(connection.error)).replace(/^Infra connector "[^"]+": /, "");
  const pick = (pattern: RegExp) => (connection.settings ?? []).filter((name) => pattern.test(name)).map((name) => screen.code(name)).join(", ");
  // Credentials for an authentication failure, the address for the rest.
  const credentials = pick(/USER|PASSWORD|KEY|TOKEN|SECRET/i);
  const settings = pick(/HOST|PORT|URL|DATABASE|ADDRESS/i);
  const fixes: string[] = [];
  const kind = (connection.kind ?? connection.name).split(" ")[0] ?? connection.name;
  if (/password authentication failed|authentication failed|WRONGPASS|NOAUTH|401|403|invalid api key|unauthorized/i.test(message)) {
    fixes.push(t.infra.hint.password(credentials || connection.name));
  } else if (/database "[^"]+" does not exist|3D000/i.test(message)) {
    fixes.push(t.infra.hint.database);
  } else if (/ENOTFOUND|getaddrinfo|could not resolve|DNS/i.test(message)) {
    fixes.push(t.infra.hint.dns);
    if (settings) fixes.push(t.infra.hint.address(settings));
  } else if (/within \d+ ?ms|timed? ?out|no answer/i.test(message)) {
    fixes.push(t.infra.hint.timeout);
    if (settings) fixes.push(t.infra.hint.address(settings));
  } else if (/ECONNREFUSED|refused|Connection closed|not reachable|cannot reach|failed to connect|unable to connect/i.test(message)) {
    fixes.push(t.infra.hint.refused(kind));
    if (settings) fixes.push(t.infra.hint.address(settings));
  } else if (settings) {
    fixes.push(t.infra.hint.address(settings));
  }
  return {
    tag: "INFRA",
    where: connection.address === undefined ? connection.name : `${connection.name} · ${connection.address}`,
    cause: message,
    fixes,
  };
}

/** One problem per DI issue; every consumer of a missing database is one problem. */
function diProblems(issues: readonly string[], screen: Screen): Problem[] {
  const t = screen.t;
  const problems: Problem[] = [];
  const database: string[] = [];
  for (const issue of issues) {
    const missing = /Missing dependency "([^"]+)" for "([^"]+)"/.exec(issue);
    if (missing?.[1] === "DatabaseProvider") {
      // The ORM lifecycle is a consumer too; the contexts name the modules.
      if (missing[2] !== "IHostedService") database.push(missing[2]!);
      continue;
    }
    problems.push({ tag: "DI", where: missing?.[2] ?? "container", cause: redactSensitiveText(issue) });
  }
  if (database.length > 0) {
    problems.unshift({
      tag: "DI",
      where: "DatabaseProvider",
      cause: `${t.failure.dbMissing(database.join(", "))}\nMissing dependency "DatabaseProvider"`,
      fixes: [screen.code(t.failure.dbFix)],
    });
  }
  return problems;
}

function genericProblem(error: unknown, where: string | undefined): Problem {
  const text = errorText(error);
  const name = error instanceof Error ? error.name : "Error";
  const stack = formatStartupFailure(error).split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 6);
  return {
    tag: name === "Error" ? "ERROR" : name.replace(/Error$/, "").toUpperCase() || "ERROR",
    where: where ?? name,
    cause: redactSensitiveText(text),
    ...(stack.length === 0 ? {} : { details: stack.map((line) => line.trim()) }),
  };
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return [error.message, ...error.errors.map((inner) => `- ${inner instanceof Error ? inner.message : String(inner)}`)].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
