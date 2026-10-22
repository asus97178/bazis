import { DiError } from "./DiError";

const CONFIGURATION_ERROR = Symbol.for("bazis.configurationError");

/**
 * Marks an error found in the application's declarations — a module, a
 * connector, a config — as a configuration error: the start prints it as one
 * `[bazis] configuration error` line instead of a stack. The error keeps its
 * class; the same error is returned.
 */
export function markConfigurationError<T>(error: T): T {
  if (error instanceof Error && !Object.prototype.hasOwnProperty.call(error, CONFIGURATION_ERROR)) {
    Object.defineProperty(error, CONFIGURATION_ERROR, { value: true });
  }
  return error;
}

/** A DI error, or an error marked with {@link markConfigurationError}. */
export function isConfigurationError(error: unknown): error is Error {
  return error instanceof DiError || (error instanceof Error && (error as unknown as Record<symbol, unknown>)[CONFIGURATION_ERROR] === true);
}
