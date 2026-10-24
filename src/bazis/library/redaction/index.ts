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
// Credentials in a URL: postgres://user:password@host, https://token@host.
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi;

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

/** Values shorter than this are not remembered: masking them would hide ordinary words ("postgres"). */
export const MIN_REMEMBERED_SECRET_LENGTH = 10;
const rememberedSecrets = new Set<string>();
let longestFirst: readonly string[] = [];

/**
 * Remembers a secret value: from now on every redaction removes it wherever it
 * appears, also in plain text without a marker such as `password=`. `Secret`
 * calls it for every configuration secret. Process-wide; values shorter than
 * {@link MIN_REMEMBERED_SECRET_LENGTH} are recognised only by their shape.
 */
export function rememberSecretValue(value: string): void {
  // A connection URL keeps naming its server: only its password is the secret,
  // and the userinfo pattern already hides user:password@ in the URL itself.
  const password = urlPassword(value);
  if (password !== undefined) {
    if (password !== "") rememberSecretValue(password);
    return;
  }
  if (value.length < MIN_REMEMBERED_SECRET_LENGTH || rememberedSecrets.has(value)) return;
  rememberedSecrets.add(value);
  // A longer value first, so a secret that contains another one goes whole.
  longestFirst = [...rememberedSecrets].sort((left, right) => right.length - left.length);
}

/** The decoded password of a URL with userinfo (`""` for user only), or undefined for other values. */
function urlPassword(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
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
  // `seen` holds the objects on the current path only: an object reached
  // again through another branch is a shared reference, not a cycle.
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  try {
    return redactObject(value, options, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function redactObject(
  value: object,
  options: NormalizedRedactionOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
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
  let text = value;
  for (const secret of longestFirst) if (text.includes(secret)) text = text.replaceAll(secret, replacement);
  return text
    .replace(SECRET_TEXT_PATTERN, (_match, name: string, separator: string) => `${name}${separator}${replacement}`)
    .replace(BEARER_TEXT_PATTERN, (_match, scheme: string) => `${scheme} ${replacement}`)
    .replace(URL_USERINFO_PATTERN, (_match, scheme: string, userinfo: string) =>
      `${scheme}${userinfo.includes(":") ? `${replacement}:${replacement}` : replacement}@`);
}
