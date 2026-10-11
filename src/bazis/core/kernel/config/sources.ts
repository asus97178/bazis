import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { KernelError } from "../errors";
import type { ConfigSource } from "../types";

type ConfigTree = { [key: string]: ConfigTreeValue };
type ConfigTreeValue = string | number | boolean | null | ConfigTreeValue[] | ConfigTree;

/** In-memory defaults. Nested objects are flattened into dot keys. */
/** Prefix of framework environment variables: `BAZIS_DB__HOST` -> `db.host`. */
export const ENV_PREFIX = "BAZIS_";

export function memorySource(values: ConfigTree, description = "memory"): ConfigSource {
  return {
    description,
    load: () => flatten(values),
  };
}

/**
 * Environment variables. `BAZIS_DB__HOST=x` -> `db.host = "x"`:
 * the prefix is stripped, `__` becomes `.`, keys are lowercased.
 */
export function envSource(options?: {
  readonly prefix?: string;
  /** Override for tests; defaults to process.env. */
  readonly variables?: Record<string, string | undefined>;
}): ConfigSource {
  const prefix = options?.prefix ?? ENV_PREFIX;
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

/** Largest secret file read by {@link secretFilesSource}: keys and certificates are a few KiB. */
const SECRET_FILE_MAX_BYTES = 64 * 1024;

/**
 * Secret files of a directory, as Docker and Kubernetes mount them
 * (`/run/secrets`). Each file is one value; its name is the key, written as
 * the key (`db.password`) or as its variable (`BAZIS_DB__PASSWORD`). Trailing
 * line breaks are removed. Hidden entries (Kubernetes `..data`) and
 * directories are skipped. Errors name the file, never its content.
 */
export function secretFilesSource(directory: string, options?: { readonly optional?: boolean }): ConfigSource {
  return {
    description: `files(${directory})`,
    load: async () => {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (options?.optional === true && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return {};
        }
        throw new KernelError(`Secret directory "${directory}" cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      }
      const result: Record<string, string> = {};
      for (const name of names.sort()) {
        if (name.startsWith(".")) {
          continue;
        }
        const file = path.join(directory, name);
        let text: string;
        try {
          // stat follows the symlinks Kubernetes uses for each key.
          const info = await stat(file);
          if (!info.isFile()) {
            continue;
          }
          if (info.size > SECRET_FILE_MAX_BYTES) {
            throw new KernelError(`Secret file "${file}" is larger than ${SECRET_FILE_MAX_BYTES} bytes.`);
          }
          text = await Bun.file(file).text();
        } catch (error) {
          if (error instanceof KernelError) throw error;
          throw new KernelError(`Secret file "${file}" cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
        }
        const key = name.toUpperCase().startsWith(ENV_PREFIX)
          ? name.slice(ENV_PREFIX.length).toLowerCase().replaceAll("__", ".")
          : name.toLowerCase();
        if (key.length > 0) {
          result[key] = text.replace(/[\r\n]+$/, "");
        }
      }
      return result;
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
