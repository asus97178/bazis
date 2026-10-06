import { ConfigKeyMissingError, KernelError } from "../errors";
import type { ConfigSource } from "../types";
import { Secret } from "./Secret";

/**
 * Immutable merged configuration: a flat map of dot-separated keys
 * ("db.host") to string values. Built once from layered sources
 * (defaults -> file -> env -> CLI), later sources override earlier ones.
 */
export class Configuration {
  private readonly values: ReadonlyMap<string, string>;
  private readonly origins: ReadonlyMap<string, { readonly source: string; readonly priority: number }>;

  public constructor(values: ReadonlyMap<string, string>, origins: ReadonlyMap<string, { readonly source: string; readonly priority: number }> = new Map()) {
    this.values = new Map([...values].map(([key, value]) => [key.toLowerCase(), value]));
    this.origins = new Map([...origins].map(([key, value]) => [key.toLowerCase(), Object.freeze({ ...value })]));
  }

  public static empty(): Configuration {
    return new Configuration(new Map());
  }

  public has(key: string): boolean {
    return this.values.has(key.toLowerCase());
  }

  public get(key: string): string | undefined {
    return this.values.get(key.toLowerCase());
  }

  public origin(key: string): { readonly source: string; readonly priority: number } {
    return this.origins.get(key.toLowerCase()) ?? { source: "configuration", priority: 0 };
  }

  public getOrDefault(key: string, defaultValue: string): string {
    return this.get(key) ?? defaultValue;
  }

  public require(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      throw new ConfigKeyMissingError(key);
    }
    return value;
  }

  public getNumber(key: string): number | undefined {
    const raw = this.get(key);
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isFinite(parsed)) {
      throw new KernelError(`Configuration key "${key}" must be a finite number.`);
    }
    return parsed;
  }

  public requireNumber(key: string): number {
    const value = this.getNumber(key);
    if (value === undefined) {
      throw new ConfigKeyMissingError(key);
    }
    return value;
  }

  public getBoolean(key: string): boolean | undefined {
    const raw = this.get(key);
    if (raw === undefined) {
      return undefined;
    }
    const normalized = raw.toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    throw new KernelError(`Configuration key "${key}" is not a boolean.`);
  }

  /** Wraps the value into a Secret so it cannot leak through logs. */
  public getSecret(key: string): Secret | undefined {
    const raw = this.get(key);
    return raw === undefined ? undefined : new Secret(raw);
  }

  public requireSecret(key: string): Secret {
    return new Secret(this.require(key));
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

/** Merges sources in order: later sources win. */
export async function loadConfiguration(sources: readonly ConfigSource[]): Promise<Configuration> {
  const merged = new Map<string, string>();
  const origins = new Map<string, { source: string; priority: number }>();
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index] as ConfigSource;
    const values = await source.load();
    for (const [key, value] of Object.entries(values)) {
      merged.set(key.toLowerCase(), value);
      origins.set(key.toLowerCase(), { source: source.description ?? `source[${index}]`, priority: index });
    }
  }
  return new Configuration(merged, origins);
}
