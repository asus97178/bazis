import { KernelError } from "../errors";
import type { ConfigSource } from "../types";

type ConfigTree = { [key: string]: ConfigTreeValue };
type ConfigTreeValue = string | number | boolean | null | ConfigTreeValue[] | ConfigTree;

/** In-memory defaults. Nested objects are flattened into dot keys. */
export function memorySource(values: ConfigTree, description = "memory"): ConfigSource {
  return {
    description,
    load: () => flatten(values),
  };
}

/**
 * Environment variables. `OSNOVA_DB__HOST=x` -> `db.host = "x"`:
 * the prefix is stripped, `__` becomes `.`, keys are lowercased.
 */
export function envSource(options?: {
  readonly prefix?: string;
  /** Override for tests; defaults to process.env. */
  readonly variables?: Record<string, string | undefined>;
}): ConfigSource {
  const prefix = options?.prefix ?? "OSNOVA_";
  return {
    description: `env(${prefix}*)`,
    load: () => {
      const variables = options?.variables ?? process.env;
      const result: Record<string, string> = {};
      for (const [name, value] of Object.entries(variables)) {
        if (value === undefined || !name.startsWith(prefix)) {
          continue;
        }
        const key = name.slice(prefix.length).toLowerCase().replaceAll("__", ".");
        if (key.length > 0) {
          result[key] = value;
        }
      }
      return result;
    },
  };
}

/** CLI arguments in the form `--db.host=localhost`. */
export function argsSource(argv: readonly string[] = Bun.argv.slice(2)): ConfigSource {
  return {
    description: "args",
    load: () => {
      const result: Record<string, string> = {};
      for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] as string;
        if (!arg.startsWith("--")) {
          continue;
        }
        const separator = arg.indexOf("=");
        if (separator <= 2) {
          continue;
        }
        result[arg.slice(2, separator)] = arg.slice(separator + 1);
      }
      return result;
    },
  };
}

/**
 * JSON config file read at runtime via Bun.file — the file lives next to the
 * compiled binary, not inside it. Nested objects are flattened into dot keys.
 */
export function jsonFileSource(path: string, options?: { readonly optional?: boolean }): ConfigSource {
  return {
    description: `json(${path})`,
    load: async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        if (options?.optional === true) {
          return {};
        }
        throw new KernelError(`Configuration file not found: "${path}".`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        // Parser messages may quote the input, including credentials.
        throw new KernelError(`Configuration file "${path}" is not valid JSON.`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new KernelError(`Configuration file "${path}" must contain a JSON object at the top level.`);
      }
      return flatten(parsed as ConfigTree);
    },
  };
}

function flatten(tree: ConfigTree, prefix = "", into: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const fullKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          flatten(item, `${fullKey}.${index}`, into);
        } else if (item !== null && item !== undefined) {
          into[`${fullKey}.${index}`] = String(item);
        }
      }
      continue;
    }
    if (typeof value === "object") {
      flatten(value, fullKey, into);
      continue;
    }
    into[fullKey] = String(value);
  }
  return into;
}
