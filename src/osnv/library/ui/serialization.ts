import { createHash } from "node:crypto";

export type UiJsonPrimitive = string | number | boolean | null;
export type UiJsonValue = UiJsonPrimitive | readonly UiJsonValue[] | UiJsonObject;

export interface UiJsonObject {
  readonly [key: string]: UiJsonValue;
}

/**
 * Converts an input into a deeply frozen, key-sorted JSON value.
 *
 * The boundary is intentionally stricter than JSON.stringify: undefined,
 * non-finite numbers, sparse arrays, accessors, class instances, symbols,
 * functions and cycles are rejected instead of being silently changed.
 */
export function normalizeUiJsonValue(value: unknown, path = "$"): UiJsonValue {
  return normalizeValue(value, path, new WeakSet<object>());
}

export function normalizeUiJsonObject(value: unknown, path = "$"): UiJsonObject {
  const normalized = normalizeUiJsonValue(value, path);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError(path + " must be a plain JSON object.");
  }
  return normalized as UiJsonObject;
}

export function canonicalUiJson(value: unknown): string {
  return JSON.stringify(normalizeUiJsonValue(value));
}

export function uiDocumentRevision(value: unknown): string {
  const digest = createHash("sha256").update(canonicalUiJson(value)).digest("hex");
  return "sha256:" + digest;
}

function normalizeValue(value: unknown, path: string, active: WeakSet<object>): UiJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(path + " must be a finite JSON number.");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new TypeError(path + " contains a non-JSON " + typeof value + " value.");
  }

  if (active.has(value)) {
    throw new TypeError(path + " contains a circular reference.");
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return normalizeArray(value, path, active);
    }
    return normalizeObject(value, path, active);
  } finally {
    active.delete(value);
  }
}

function normalizeArray(value: readonly unknown[], path: string, active: WeakSet<object>): readonly UiJsonValue[] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(path + " must not contain symbol properties.");
  }

  const enumerableKeys = Object.keys(value);
  for (const key of enumerableKeys) {
    if (!isArrayIndex(key) || Number(key) >= value.length) {
      throw new TypeError(path + " must not contain non-index array properties.");
    }
  }

  const normalized: UiJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError(path + "[" + index + "] must not be an array hole.");
    }
    normalized.push(normalizeValue(value[index], path + "[" + index + "]", active));
  }
  return Object.freeze(normalized);
}

function normalizeObject(value: object, path: string, active: WeakSet<object>): UiJsonObject {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(path + " must be a plain JSON object.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(path + " must not contain symbol properties.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized: Record<string, UiJsonValue> = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      continue;
    }
    if (!descriptor.enumerable) {
      throw new TypeError(propertyPath(path, key) + " must be enumerable.");
    }
    if (!("value" in descriptor)) {
      throw new TypeError(propertyPath(path, key) + " must not be an accessor property.");
    }
    normalized[key] = normalizeValue(descriptor.value, propertyPath(path, key), active);
  }
  return Object.freeze(normalized) as UiJsonObject;
}

function isArrayIndex(key: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) {
    return false;
  }
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? path + "." + key
    : path + "[" + JSON.stringify(key) + "]";
}
