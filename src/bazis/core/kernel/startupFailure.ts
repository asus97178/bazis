import { inspect } from "node:util";
import { redactSensitive, redactSensitiveText } from "../../library/redaction";

const MAX_CAUSES = 5;
/** Properties already printed in the header, the frames or the cause chain. */
const SHOWN = new Set(["name", "message", "stack", "cause", "code", "errno", "errors"]);
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
    lines.push(...(current.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)));
    const details = Object.fromEntries(Object.entries(current).filter(([name]) => !SHOWN.has(name)));
    if (Object.keys(details).length > 0) lines.push(inspect(redactSensitive(details), INSPECT));
    current = current.cause;
  }
  return redactSensitiveText(lines.join("\n"));
}

function codeOf(error: Error): string {
  // Node style: `Error [ERR_X]: message`; a database error code such as 42P01 follows it.
  const fields = ["code", "errno"].flatMap((name) => {
    const value = (error as unknown as Record<string, unknown>)[name];
    return typeof value === "string" || typeof value === "number" ? [String(value)] : [];
  });
  return fields.length > 0 ? ` [${fields.join(", ")}]` : "";
}
