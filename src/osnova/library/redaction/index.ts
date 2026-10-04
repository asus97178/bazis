const DEFAULT_REPLACEMENT = "***";
const CIRCULAR = "[Circular]";

const DEFAULT_SENSITIVE_FRAGMENTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "privatekey",
  "clientsecret",
  "credential",
  "sessionid",
];

const SECRET_TEXT_PATTERN =
  /\b(password|passwd|passphrase|secret|token|api[-_]?key|cookie|set-cookie|private[-_]?key|client[-_]?secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi;
const BEARER_TEXT_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export interface SensitiveRedactionOptions {
  readonly replacement?: string;
  readonly sensitiveKeys?: readonly (string | RegExp)[];
  readonly maxDepth?: number;
}

interface NormalizedRedactionOptions {
  readonly replacement: string;
  readonly sensitiveKeys: readonly (string | RegExp)[];
  readonly maxDepth: number;
}

export function redactSensitive<T>(value: T, options: SensitiveRedactionOptions = {}): T {
  return redactValue(value, undefined, normalizeOptions(options), new WeakSet<object>(), 0) as T;
}

export function redactSensitiveText(value: string, options: SensitiveRedactionOptions = {}): string {
  return redactText(value, normalizeOptions(options).replacement);
}

export function redactTraceValues<T>(values: readonly T[], options: SensitiveRedactionOptions = {}): readonly T[] {
  const replacement = normalizeOptions(options).replacement as T;
  return values.map(() => replacement);
}

export function isSensitiveKey(key: string, options: SensitiveRedactionOptions = {}): boolean {
  return keyIsSensitive(key, normalizeOptions(options));
}

function normalizeOptions(options: SensitiveRedactionOptions): NormalizedRedactionOptions {
  return {
    replacement: options.replacement ?? DEFAULT_REPLACEMENT,
    sensitiveKeys: options.sensitiveKeys ?? [],
    maxDepth: options.maxDepth ?? 8,
  };
}

function redactValue(
  value: unknown,
  key: string | undefined,
  options: NormalizedRedactionOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key !== undefined && keyIsSensitive(key, options)) {
    return options.replacement;
  }
  if (typeof value === "string") {
    return redactText(value, options.replacement);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (depth >= options.maxDepth) {
    return options.replacement;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  if (value instanceof Error) {
    return redactError(value, options, seen, depth);
  }
  if (isRedactedJsonObject(value)) {
    return options.replacement;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, options, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redactValue(childValue, childKey, options, seen, depth + 1);
  }
  return output;
}

function redactError(
  error: Error,
  options: NormalizedRedactionOptions,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactText(error.message, options.replacement),
  };
  if (error.stack !== undefined) {
    output.stack = redactText(error.stack, options.replacement);
  }
  for (const [key, value] of Object.entries(error)) {
    output[key] = redactValue(value, key, options, seen, depth + 1);
  }
  return output;
}

function isRedactedJsonObject(value: object): boolean {
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson !== "function") {
    return false;
  }
  try {
    return toJson.call(value) === DEFAULT_REPLACEMENT;
  } catch {
    return false;
  }
}

function keyIsSensitive(key: string, options: NormalizedRedactionOptions): boolean {
  const normalized = normalizeKey(key);
  if (DEFAULT_SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  for (const sensitiveKey of options.sensitiveKeys) {
    if (typeof sensitiveKey === "string") {
      const custom = normalizeKey(sensitiveKey);
      if (custom.length > 0 && normalized.includes(custom)) {
        return true;
      }
      continue;
    }
    sensitiveKey.lastIndex = 0;
    if (sensitiveKey.test(key)) {
      return true;
    }
  }
  return false;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactText(value: string, replacement: string): string {
  return value
    .replace(SECRET_TEXT_PATTERN, (_match, name: string, separator: string) => `${name}${separator}${replacement}`)
    .replace(BEARER_TEXT_PATTERN, (_match, scheme: string) => `${scheme} ${replacement}`);
}
