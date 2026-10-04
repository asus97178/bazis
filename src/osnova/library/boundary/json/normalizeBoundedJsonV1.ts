import { types as nodeUtilTypes } from "node:util";
import {
  appendJsonPointerV1,
  finalizeOsnovaDiagnosticsV1,
  osnovaDiagnosticV1,
  type OsnovaDiagnosticsV1,
  type OsnovaDiagnosticV1,
} from "../diagnostics-v1";
import {
  boundaryJsonLimitsV1,
  type BoundaryJsonLimitOverridesV1,
  type BoundaryJsonLimitsV1,
} from "./limits-v1";
import type { BoundaryJsonObject, BoundaryJsonValue } from "./types-v1";

export interface NormalizeBoundedJsonV1Options {
  readonly limits?: BoundaryJsonLimitOverridesV1;
}

export type NormalizeBoundedJsonV1Result =
  | ({ readonly ok: true; readonly value: BoundaryJsonValue } & OsnovaDiagnosticsV1)
  | ({ readonly ok: false } & OsnovaDiagnosticsV1);

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UTF8 = new TextEncoder();

export function normalizeBoundedJsonV1(
  input: unknown,
  options: NormalizeBoundedJsonV1Options = {},
): NormalizeBoundedJsonV1Result {
  const limits = boundaryJsonLimitsV1(options.limits);
  try {
    const normalizer = new JsonValueNormalizerV1(limits);
    const value = normalizer.normalize(input, "", 1);
    const encodedBytes = UTF8.encode(JSON.stringify(value)).byteLength;
    if (encodedBytes > limits.maxEncodedBytes) {
      return failure(diagnostic(
        "WF_JSON_TOO_LARGE",
        "Normalized JSON input exceeds the encoded byte ceiling.",
        "",
      ));
    }
    return Object.freeze({
      ok: true,
      value,
      diagnostics: Object.freeze([]),
      truncated: false,
    });
  } catch (error) {
    if (error instanceof JsonNormalizeFailureV1) {
      return failure(error.diagnostic);
    }
    throw error;
  }
}

class JsonValueNormalizerV1 {
  private values = 0;
  private objectMembers = 0;
  private arrayItems = 0;
  private totalStringBytes = 0;
  private readonly active = new WeakSet<object>();

  constructor(private readonly limits: BoundaryJsonLimitsV1) {}

  normalize(value: unknown, pointer: string, depth: number): BoundaryJsonValue {
    if (depth > this.limits.maxDepth) {
      this.fail("WF_JSON_DEPTH_LIMIT", "JSON nesting depth exceeds the framework ceiling.", pointer);
    }
    this.values += 1;
    if (this.values > this.limits.maxValues) {
      this.fail("WF_JSON_VALUE_LIMIT", "JSON value count exceeds the framework ceiling.", pointer);
    }

    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      this.checkString(value, pointer, false);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        this.fail("WF_JSON_NUMBER_OUT_OF_RANGE", "JSON number is outside the supported finite safe range.", pointer);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") {
      this.fail("WF_JSON_MALFORMED", "Value is not representable in the bounded JSON data model.", pointer);
    }
    if (nodeUtilTypes.isProxy(value)) {
      this.fail("WF_JSON_MALFORMED", "Proxy objects are not representable in the bounded JSON data model.", pointer);
    }
    if (this.active.has(value)) {
      this.fail("WF_JSON_MALFORMED", "Circular references are not representable in JSON.", pointer);
    }

    this.active.add(value);
    try {
      return Array.isArray(value)
        ? this.normalizeArray(value, pointer, depth)
        : this.normalizeObject(value, pointer, depth);
    } finally {
      this.active.delete(value);
    }
  }

  private normalizeArray(value: readonly unknown[], pointer: string, depth: number): readonly BoundaryJsonValue[] {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      this.fail("WF_JSON_MALFORMED", "JSON arrays cannot contain symbol properties.", pointer);
    }
    if (value.length > this.limits.maxItemsPerArray) {
      this.fail("WF_JSON_ARRAY_LIMIT", "JSON array item count exceeds the framework ceiling.", pointer);
    }
    this.arrayItems += value.length;
    if (this.arrayItems > this.limits.maxArrayItems) {
      this.fail("WF_JSON_ARRAY_LIMIT", "Total JSON array items exceed the framework ceiling.", pointer);
    }

    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (!isArrayIndex(key) || Number(key) >= value.length) {
        this.fail("WF_JSON_MALFORMED", "JSON arrays cannot contain custom properties.", pointer);
      }
    }

    const output: BoundaryJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemPointer = appendJsonPointerV1(pointer, index);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        this.fail("WF_JSON_MALFORMED", "Sparse arrays are not representable in JSON.", itemPointer);
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        this.fail("WF_JSON_MALFORMED", "JSON array items must be enumerable data properties.", itemPointer);
      }
      output.push(this.normalize(descriptor.value, itemPointer, depth + 1));
    }
    return Object.freeze(output);
  }

  private normalizeObject(value: object, pointer: string, depth: number): BoundaryJsonObject {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      this.fail("WF_JSON_MALFORMED", "JSON objects must be plain or null-prototype objects.", pointer);
    }
    const keys: string[] = [];
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length > this.limits.maxMembersPerObject) {
        this.fail("WF_JSON_OBJECT_LIMIT", "JSON object member count exceeds the framework ceiling.", pointer);
      }
    }
    keys.sort(compareUtf16);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      this.fail("WF_JSON_MALFORMED", "JSON objects cannot contain symbol properties.", pointer);
    }
    this.objectMembers += keys.length;
    if (this.objectMembers > this.limits.maxObjectMembers) {
      this.fail("WF_JSON_OBJECT_LIMIT", "Total JSON object members exceed the framework ceiling.", pointer);
    }

    const output = Object.create(null) as Record<string, BoundaryJsonValue>;
    for (const key of keys) {
      const propertyPointer = appendJsonPointerV1(pointer, key);
      this.checkString(key, propertyPointer, true);
      if (FORBIDDEN_KEYS.has(key)) {
        this.fail(
          "WF_JSON_FORBIDDEN_PROPERTY",
          "The JSON property name is forbidden at every nesting level.",
          propertyPointer,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        this.fail("WF_JSON_MALFORMED", "JSON object members must be enumerable data properties.", propertyPointer);
      }
      output[key] = this.normalize(descriptor.value, propertyPointer, depth + 1);
    }
    return Object.freeze(output);
  }

  private checkString(value: string, pointer: string, key: boolean): void {
    const byteCeiling = key ? this.limits.maxKeyBytes : this.limits.maxStringBytes;
    if (value.length > byteCeiling) {
      this.fail(
        key ? "WF_JSON_KEY_LIMIT" : "WF_JSON_STRING_LIMIT",
        key
          ? "JSON property name exceeds the framework byte ceiling."
          : "JSON string exceeds the framework byte ceiling.",
        pointer,
      );
    }
    if (hasLoneSurrogate(value)) {
      this.fail("WF_JSON_INVALID_UNICODE", "JSON strings must contain Unicode scalar values.", pointer);
    }
    const byteLength = UTF8.encode(value).byteLength;
    if (byteLength > byteCeiling) {
      this.fail(
        key ? "WF_JSON_KEY_LIMIT" : "WF_JSON_STRING_LIMIT",
        key
          ? "JSON property name exceeds the framework byte ceiling."
          : "JSON string exceeds the framework byte ceiling.",
        pointer,
      );
    }
    this.totalStringBytes += byteLength;
    if (this.totalStringBytes > this.limits.maxTotalStringBytes) {
      this.fail("WF_JSON_STRING_LIMIT", "Total decoded JSON string bytes exceed the framework ceiling.", pointer);
    }
  }

  private fail(code: string, message: string, pointer: string): never {
    throw new JsonNormalizeFailureV1(diagnostic(code, message, pointer));
  }
}

class JsonNormalizeFailureV1 extends Error {
  constructor(readonly diagnostic: OsnovaDiagnosticV1) {
    super(diagnostic.message);
    this.name = "JsonNormalizeFailureV1";
  }
}

function failure(diagnosticValue: OsnovaDiagnosticV1): NormalizeBoundedJsonV1Result {
  const finalized = finalizeOsnovaDiagnosticsV1([diagnosticValue]);
  return Object.freeze({ ok: false, ...finalized });
}

function diagnostic(code: string, message: string, pointer: string): OsnovaDiagnosticV1 {
  return osnovaDiagnosticV1({ severity: "error", stage: "decode", code, message, pointer });
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function isArrayIndex(key: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
