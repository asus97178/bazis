import { KernelError } from "../errors";

export type ConfigIssueKind = "missing-secret" | "development-secret" | "number" | "boolean" | "string" | "enum" | "validator" | "conflict";

/** One invalid configuration key, with what can change it. */
export interface ConfigIssue {
  /** Full key: `db.password`. */
  readonly key: string;
  /** Config prefix: `db`; empty for a config without one. */
  readonly section: string;
  readonly kind: ConfigIssueKind;
  /** The problem without the key: `expected a finite number, got "x" (BAZIS_DB__PORT)`. */
  readonly message: string;
  /** Environment variables that set the key. */
  readonly env: readonly string[];
  /** The variable that supplied the wrong value. */
  readonly source?: string;
  readonly allowed?: readonly string[];
  /** The file with the `defineConfig` call. */
  readonly declaredIn?: string;
  readonly environment: "development" | "test" | "production";
}

/**
 * The configuration is invalid. `issues` lists every invalid key of every
 * config at once, so the startup screen shows them together.
 */
export class ConfigValidationError extends KernelError {
  public readonly issues: readonly ConfigIssue[];

  public constructor(public readonly environment: string, issues: readonly ConfigIssue[]) {
    // "key — text", not "key: text": the console redaction would read
    // "db.password: required" as a secret value and hide the word "required".
    super(`Invalid configuration (environment "${environment}"): ${issues.map((issue) => `${issue.key} — ${issue.message}`).join("; ")}.`);
    this.issues = Object.freeze([...issues]);
  }
}
