import { InfraError } from "./InfraConnector";
import type { AppConfig } from "../kernel/config/defineConfig";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

/**
 * Minimal dynamic access to a declarative subsystem config.
 *
 * Connectors accept a typed config (`AppConfig<...Shape>`): at the call site
 * this guarantees that the required keys are declared with the right types.
 * Inside, the connector reads them by name; the runtime shape is known from
 * `Shape`, so a narrow cast to this reader is acceptable here.
 */
export interface ConfigReader {
  get(key: string): unknown;
  has(key: string): boolean;
}

/** Narrow cast of a config to the dynamic reader (the shape is type-checked at the input). */
export function reader(config: object, configs?: ConfigRegistry): ConfigReader {
  return (configs?.get(config as AppConfig<object>) ?? config) as ConfigReader;
}

/** Reads a required non-empty string value or fails with a clear error. */
export function requireValue(value: unknown, field: string, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InfraError(`Infra connector "${kind}": "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * Environment variables that set the given keys of a config, for the fix
 * hints of a connection failure: `BAZIS_DB__HOST`.
 */
export function settingNames(config: object, configs: ConfigRegistry | undefined, keys: readonly string[]): string[] {
  const view = configs?.get(config as AppConfig<object>) as { inspect?: () => readonly { key: string; env: readonly string[] }[] } | undefined;
  const rows = view?.inspect?.() ?? [];
  return keys.flatMap((key) => rows.find((row) => row.key === key || row.key.endsWith(`.${key}`))?.env.slice(0, 1) ?? []);
}
