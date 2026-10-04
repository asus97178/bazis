import { createToken } from "../../di";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured context attached to a log line. */
export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * Minimal structured logging port. Inject via {@link LOGGER}; the kernel
 * registers a {@link ConsoleLogger} by default (override with
 * `Osnova.createBuilder(...).useLogger(...)`).
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const LOGGER = createToken<Logger>("Logger");
