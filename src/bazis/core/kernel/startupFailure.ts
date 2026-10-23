import { inspect } from "node:util";
import { redactSensitive, redactSensitiveText } from "../../library/redaction";
import { ShutdownTimeoutError, StartupFailuresError, StartupTimeoutError } from "./errors";

const MAX_CAUSES = 5;
/** Properties already printed in the header, the frames or the cause chain. */
const SHOWN = new Set(["name", "message", "stack", "cause", "code", "errno", "errors", "failures"]);
/** Where in PostgreSQL's own sources the error was raised: nothing to act on. Hint, detail and the object names stay. */
const POSTGRES_INTERNALS = new Set(["file", "line", "routine", "severity", "severity_local"]);
const INSPECT = { depth: null, colors: false, customInspect: false, getters: false, maxArrayLength: null, maxStringLength: null } as const;

/**
 * Text of an application startup failure: `Name [code]: message`, the
 * stack frames, the remaining error properties (for example a schema
 * verification report or a PostgreSQL `detail`) and the `cause` chain. The
 * message is printed once as plain text instead of inside an inspected object.
 */
export function formatStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return inspect(redactSensitive(error), INSPECT);
  }
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSES && current !== undefined; depth += 1) {
    const prefix = depth === 0 ? "" : "Caused by: ";
    if (!(current instanceof Error)) {
      lines.push(prefix + inspect(redactSensitive(current), { depth: 2, colors: false, customInspect: false, getters: false }));
      break;
    }
    lines.push(`${prefix}${current.name}${codeOf(current)}: ${current.message}`);
    if (current instanceof AggregateError) {
      for (const inner of current.errors) lines.push(`  - ${inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner)}`);
    }
    // Services that failed together: the list above is the report; the
    // aggregate's own frames are the kernel's, not the application's.
    if (!(current instanceof StartupFailuresError)) lines.push(...(current.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)));
    // Timeouts already say their limit and what was pending in the message.
    const restated = current instanceof StartupTimeoutError || current instanceof ShutdownTimeoutError;
    const internals = current.name === "PostgresError" ? POSTGRES_INTERNALS : undefined;
    const details = restated ? {} : Object.fromEntries(Object.entries(current).filter(([name]) => !SHOWN.has(name) && !internals?.has(name)));
    if (Object.keys(details).length > 0) lines.push(inspect(redactSensitive(details), INSPECT));
    current = current.cause;
  }
  return redactSensitiveText(lines.join("\n"));
}

function codeOf(error: Error): string {
  const own = (error as unknown as Record<string, unknown>).code;
  // A message that already starts with its code ("ORM_X: …") is not prefixed twice.
  if (typeof own === "string" && error.message.startsWith(own)) return "";
  // Node style: `Error [ERR_X]: message`; a database error code such as 42P01 follows it.
  const fields = ["code", "errno"].flatMap((name) => {
    const value = (error as unknown as Record<string, unknown>)[name];
    return typeof value === "string" || typeof value === "number" ? [String(value)] : [];
  });
  return fields.length > 0 ? ` [${fields.join(", ")}]` : "";
}
