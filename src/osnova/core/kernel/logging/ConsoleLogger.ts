import { redactSensitive, type SensitiveRedactionOptions } from "../../../library/redaction";
import type { LogFields, LogLevel, Logger } from "./Logger";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVEL_SINK: Record<LogLevel, (message: string) => void> = {
  debug: (m) => console.debug(m),
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export interface ConsoleLoggerOptions {
  /** Minimum level emitted. Default: "info". */
  readonly minLevel?: LogLevel;
  /** Prefix tag, e.g. the app name. */
  readonly name?: string;
  /** Structured fields are redacted by default; pass false only for trusted local debugging. */
  readonly redaction?: SensitiveRedactionOptions | false;
}

function formatFields(fields: LogFields | undefined, redaction: SensitiveRedactionOptions | false): string {
  if (!fields) {
    return "";
  }
  try {
    if (Object.keys(fields).length === 0) return "";
    return ` ${JSON.stringify(redaction === false ? fields : redactSensitive(fields, redaction))}`;
  } catch {
    return " [Unserializable log fields]";
  }
}

/** Default {@link Logger}: single-line, level-filtered output to the console. */
export class ConsoleLogger implements Logger {
  private readonly threshold: number;
  private readonly prefix: string;
  private readonly redaction: SensitiveRedactionOptions | false;

  public constructor(options: ConsoleLoggerOptions = {}) {
    this.threshold = LEVEL_ORDER[options.minLevel ?? "info"];
    this.prefix = options.name ? `[${options.name}] ` : "";
    this.redaction = options.redaction ?? {};
  }

  public debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) {
      return;
    }
    LEVEL_SINK[level](`${this.prefix}${level}: ${message}${formatFields(fields, this.redaction)}`);
  }
}
