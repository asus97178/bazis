/**
 * A configuration source produces a flat map of dot-separated keys to string
 * values (e.g. "db.host" -> "localhost"). Later sources override earlier ones.
 */
export interface ConfigSource {
  /** Shown in diagnostics and error messages. */
  readonly description: string;
  load(): Record<string, string> | Promise<Record<string, string>>;
}
