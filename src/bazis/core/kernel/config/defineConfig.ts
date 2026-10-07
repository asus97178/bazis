import { createToken, type InjectionToken } from "../../di";
import { Environment } from "../Environment";
import { KernelError } from "../errors";
import { Configuration } from "./Configuration";
import { Secret } from "./Secret";
import { ENV_PREFIX } from "./sources";
import { isSensitiveKey, redactSensitiveText } from "../../../library/redaction";

type Stand = "development" | "test" | "production";
type Primitive = string | number | boolean;
export interface SecretSpec { readonly __secret: true; readonly default?: string }
export function secret(value?: string): SecretSpec {
  return Object.freeze(value === undefined ? { __secret: true } : { __secret: true, default: value });
}
export interface ConfigEnum<T extends string | number = string | number> {
  readonly __enum: true;
  readonly values: readonly T[];
  readonly default: T;
}
export function configEnum<const V extends readonly [string | number, ...(string | number)[]]>(values: V, defaultValue: V[number]): ConfigEnum<V[number]> {
  if (!values.length || !values.includes(defaultValue) || values.some(value => typeof value !== typeof defaultValue || (typeof value === "number" && !Number.isFinite(value)))) {
    throw new KernelError("configEnum requires non-empty homogeneous finite values and a declared default.");
  }
  return Object.freeze({ __enum: true, values: Object.freeze([...values]), default: defaultValue });
}
type Cell = Primitive | SecretSpec | ConfigEnum;
type Defaults = Record<string, Cell>;
export type ConfigValueType = Primitive | Secret;
export type ConfigShape = Record<string, ConfigValueType>;
type Resolved<V> = V extends SecretSpec ? Secret : V extends ConfigEnum<infer E> ? E : V extends number ? number : V extends boolean ? boolean : string;
type ResolveAll<D extends Defaults> = { [K in keyof D]: Resolved<D[K]> };
type WidenCell<V> = V extends SecretSpec ? SecretSpec : V extends ConfigEnum<infer E> ? E : V extends number ? number : V extends boolean ? boolean : string;
type CellFor<T> = [T] extends [Secret] ? SecretSpec : [T] extends [string] ? (string extends T ? string : ConfigEnum<T & string>) : [T] extends [number] ? (number extends T ? number : ConfigEnum<T & number>) : [T] extends [boolean] ? (boolean extends T ? boolean : never) : never;
type Declaration<T extends object> = { [K in keyof T]: CellFor<T[K]> };
type OverrideFor<T> = T extends Secret ? SecretSpec : T;
interface Rules<T extends object> {
  readonly env?: Partial<{ [K in keyof T]: string | readonly string[] }>;
  readonly validate?: Partial<{ [K in keyof T]: (value: T[K]) => string | undefined }>;
}
export interface ConfigSchema<D extends Defaults> extends Rules<ResolveAll<D>> {
  readonly default: D;
  readonly development?: Partial<{ [K in keyof D]: WidenCell<D[K]> }>;
  readonly test?: Partial<{ [K in keyof D]: WidenCell<D[K]> }>;
  readonly production?: Partial<{ [K in keyof D]: WidenCell<D[K]> }>;
}
export interface SchemaFor<T extends object> extends Rules<T> {
  readonly default: Declaration<T>;
  readonly development?: Partial<{ [K in keyof T]: OverrideFor<T[K]> }>;
  readonly test?: Partial<{ [K in keyof T]: OverrideFor<T[K]> }>;
  readonly production?: Partial<{ [K in keyof T]: OverrideFor<T[K]> }>;
}
export interface ValidatableConfig {
  ensureValid(environment?: Stand): void;
  /** Derived declarations create a fresh view from this kernel's source snapshot. */
  resolve?(environment?: Stand, configuration?: Configuration): ValidatableConfig;
}
export interface AppConfig<T extends object> extends ValidatableConfig {
  get<K extends keyof T>(key: K): T[K];
  has<K extends keyof T>(key: K): boolean;
  resolve?(environment?: Stand, configuration?: Configuration): AppConfig<T>;
}
export interface ConfigInspection {
  readonly key: string;
  readonly type: "string" | "number" | "boolean" | "secret";
  readonly env: readonly string[];
  readonly source: string;
  readonly value: Primitive;
}
export interface ConfigView<T extends object> extends AppConfig<T> {
  readonly environment: Stand;
  inspect(): readonly ConfigInspection[];
}
export interface ConfigDefinition<T extends object> extends AppConfig<T> {
  readonly token: InjectionToken<ConfigView<T>>;
  resolve(environment?: Stand, configuration?: Configuration): ConfigView<T>;
}
const definitions = new WeakSet<object>();
export function isConfigDefinition(config: ValidatableConfig): config is ConfigDefinition<object> {
  return definitions.has(config);
}
export function processConfiguration(): Configuration {
  const values = new Map<string, string>();
  const origins = new Map<string, { source: string; priority: number }>();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith(ENV_PREFIX) && value !== undefined) {
      const key = name.slice(ENV_PREFIX.length).toLowerCase().replaceAll("__", ".");
      values.set(key, value);
      origins.set(key, { source: "env(BAZIS_*)", priority: 0 });
    }
  }
  return new Configuration(values, origins);
}
/**
 * Why an environment variable name cannot be used for a key, or undefined.
 * Aliases are read from the same BAZIS_* variables as the generated names,
 * so they share the prefix.
 */
function environmentNameProblem(name: string, claimed: ReadonlySet<string>): string | undefined {
  if (!name.startsWith(ENV_PREFIX)) return `must start with ${ENV_PREFIX}: configuration reads only ${ENV_PREFIX}* variables (for example ${ENV_PREFIX}${name.replace(/^[^A-Za-z0-9]+/, "").toUpperCase() || "NAME"})`;
  if (name.length === ENV_PREFIX.length) return `needs a name after ${ENV_PREFIX}`;
  if (!/^[A-Z0-9_-]+$/.test(name)) return "may contain only A-Z, 0-9, _ and -";
  if (claimed.has(name)) return "is already used by another key of this configuration";
  return undefined;
}

function isSecret(cell: Cell): cell is SecretSpec { return typeof cell === "object" && cell !== null && "__secret" in cell; }
function isEnum(cell: Cell): cell is ConfigEnum { return typeof cell === "object" && cell !== null && "__enum" in cell; }
function copyCell(cell: Cell): Cell {
  if (isSecret(cell)) return secret(cell.default);
  if (isEnum(cell)) return Object.freeze({ ...cell, values: Object.freeze([...cell.values]) });
  if (["string", "number", "boolean"].includes(typeof cell)) return cell;
  throw new KernelError("Configuration supports only primitive values, secret() and configEnum().");
}
function safeValue(key: string, value: ConfigValueType): Primitive {
  if (value instanceof Secret || (typeof value === "string" && isSensitiveKey(key))) return "***";
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) { url.username = "***"; url.password = "***"; return redactSensitiveText(url.toString()); }
  } catch { /* Most strings are not URLs. */ }
  return redactSensitiveText(value);
}
export function defineConfig<const D extends Defaults>(schema: ConfigSchema<D>): ConfigDefinition<ResolveAll<D>>;
export function defineConfig<const D extends Defaults>(prefix: string, schema: ConfigSchema<D>): ConfigDefinition<ResolveAll<D>>;
export function defineConfig<T extends object>(schema: SchemaFor<T>): ConfigDefinition<T>;
export function defineConfig<T extends object>(prefix: string, schema: SchemaFor<T>): ConfigDefinition<T>;
export function defineConfig(prefixOrSchema: string | ConfigSchema<Defaults>, maybeSchema?: ConfigSchema<Defaults>): ConfigDefinition<ConfigShape> {
  const prefix = typeof prefixOrSchema === "string" ? prefixOrSchema : "";
  const input = typeof prefixOrSchema === "string" ? maybeSchema! : prefixOrSchema;
  const schema = Object.freeze({
    default: Object.freeze(Object.fromEntries(Object.entries(input.default).map(([key, value]) => [key, copyCell(value)]))),
    ...Object.fromEntries((["development", "test", "production"] as const).map(stand => [stand, Object.freeze(Object.fromEntries(Object.entries(input[stand] ?? {}).map(([key, value]) => [key, copyCell(value as Cell)])))])),
  }) as ConfigSchema<Defaults>;
  const validators = { ...input.validate };
  const keys = Object.keys(schema.default);
  const fullKey = (key: string) => prefix ? `${prefix}.${key}` : key;
  const names = new Map<string, readonly string[]>();
  const claimed = new Set<string>();
  for (const key of keys) {
    const alias = input.env?.[key];
    const env = [...new Set([`${ENV_PREFIX}${fullKey(key).replaceAll(".", "__").toUpperCase()}`, ...(typeof alias === "string" ? [alias] : alias ?? [])])];
    for (const name of env) {
      const problem = environmentNameProblem(name, claimed);
      if (problem) throw new KernelError(`Configuration key "${fullKey(key)}": environment variable "${name}" ${problem}.`);
      claimed.add(name);
    }
    names.set(key, Object.freeze(env));
  }
  for (const stand of ["development", "test", "production"] as const) {
    for (const key of Object.keys(schema[stand] ?? {})) if (!keys.includes(key)) throw new KernelError(`Unknown configuration key: ${fullKey(key)}.`);
  }
  const resolve = (environment: Stand = Environment.fromProcess().name, configuration = processConfiguration()): ConfigView<ConfigShape> => {
    if (!["development", "test", "production"].includes(environment)) throw new KernelError("Unknown configuration environment.");
    const values = new Map<string, ConfigValueType>();
    const inspection: ConfigInspection[] = [];
    const issues: string[] = [];
    for (const key of keys) {
      const base = schema.default[key]!;
      const override = schema[environment]?.[key];
      const cell = override ?? base;
      const type = isSecret(base) ? "secret" : isEnum(base) ? typeof base.default : typeof base;
      const candidates: { raw: string; source: string; priority: number }[] = [];
      for (const name of names.get(key)!) {
        const sourceKey = name.slice(ENV_PREFIX.length).toLowerCase().replaceAll("__", ".");
        const raw = configuration.get(sourceKey);
        if (raw === undefined) continue;
        const origin = configuration.origin(sourceKey);
        candidates.push({ raw, ...origin });
      }
      const priority = Math.max(...candidates.map(candidate => candidate.priority));
      const winners = candidates.filter(candidate => candidate.priority === priority);
      const selected = winners[0];
      if (winners.some(candidate => candidate.raw !== selected?.raw)) issues.push(`${fullKey(key)} — conflicting environment aliases`);
      const raw = selected?.raw ?? (isSecret(cell) || isEnum(cell) ? cell.default : cell);
      let value: ConfigValueType | undefined;
      if (type === "secret") {
        if (typeof raw !== "string" || !raw.trim()) issues.push(`${fullKey(key)} — required non-empty secret is not set (${names.get(key)!.join(", ")})`);
        else value = new Secret(raw);
      } else if (type === "number") {
        const parsed = Number(raw);
        if (raw === undefined || (typeof raw === "string" && !raw.trim()) || !Number.isFinite(parsed)) issues.push(`${fullKey(key)} — expected a finite number`);
        else value = parsed;
      } else if (type === "boolean") {
        const normalized = String(raw).toLowerCase();
        if (normalized === "true" || normalized === "1") value = true;
        else if (normalized === "false" || normalized === "0") value = false;
        else issues.push(`${fullKey(key)} — expected a boolean`);
      } else if (typeof raw === "string") value = raw;
      else issues.push(`${fullKey(key)} — expected a string`);
      if (value === undefined) continue;
      if (isEnum(base) && !base.values.includes(value as string | number)) issues.push(`${fullKey(key)} — value is not one of the declared enum values`);
      try {
        const issue = validators[key]?.(value);
        if (issue) issues.push(`${fullKey(key)} — ${issue}`);
      } catch { issues.push(`${fullKey(key)} — validator failed`); }
      values.set(key, value);
      inspection.push(Object.freeze({ key: fullKey(key), type: type as ConfigInspection["type"], env: names.get(key)!, source: selected?.source ?? (override === undefined ? "default" : environment), value: safeValue(fullKey(key), value) }));
    }
    if (issues.length) {
      // "key — text", not "key: text": the console redaction would read
      // "db.password: required" as a secret value and hide the word "required".
      let message = issues.join("; ");
      for (const [key, value] of values) {
        const sensitive = value instanceof Secret ? value.reveal() : typeof value === "string" && isSensitiveKey(key) ? value : undefined;
        if (sensitive) message = message.replaceAll(sensitive, "***");
      }
      throw new KernelError(`Invalid configuration (environment "${environment}"): ${message}.`);
    }
    const rows = Object.freeze(inspection);
    return Object.freeze({
      environment,
      get: <K extends keyof ConfigShape>(key: K): ConfigShape[K] => values.get(String(key)) as ConfigShape[K],
      has: <K extends keyof ConfigShape>(key: K) => values.has(String(key)),
      ensureValid(stand?: Stand) { if (stand !== undefined && stand !== environment) throw new KernelError("A resolved configuration view cannot change environment."); },
      inspect: () => rows,
    });
  };
  const definition: ConfigDefinition<ConfigShape> = Object.freeze({
    token: Object.freeze(createToken<ConfigView<ConfigShape>>(`Config:${prefix || "default"}`)),
    resolve,
    get: <K extends keyof ConfigShape>(key: K): ConfigShape[K] => resolve().get(key),
    has: <K extends keyof ConfigShape>(key: K) => resolve().has(key),
    ensureValid(environment?: Stand) { resolve(environment); },
  });
  definitions.add(definition);
  return definition;
}
