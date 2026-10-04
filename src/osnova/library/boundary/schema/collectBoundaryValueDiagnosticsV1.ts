import {
  appendJsonPointerV1,
  OSNOVA_DIAGNOSTIC_LIMIT_V1,
  osnovaDiagnosticV1,
  type OsnovaDiagnosticV1,
} from "../diagnostics-v1";
import { canonicalBoundaryJsonV1 } from "../serialization/canonicalJsonV1";
import type { BoundaryJsonValue } from "../json/types-v1";
import type {
  BoundaryNumberSchemaV1,
  BoundarySchemaV1,
  BoundaryStringFormatV1,
} from "./types-v1";

export function collectBoundaryValueDiagnosticsV1(
  schema: BoundarySchemaV1,
  value: BoundaryJsonValue,
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) return;
  if (value === null && (schema.type === "null" || schema.nullable === true)) {
    return;
  }

  switch (schema.type) {
    case "null":
      diagnostics.push(valueDiagnostic(
        "BSV1_VALUE_TYPE",
        "Value must be null.",
        pointer,
      ));
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be a boolean.", pointer));
        return;
      }
      validateScalarEnum(schema.enum, value, pointer, diagnostics);
      return;
    case "string":
      if (typeof value !== "string") {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be a string.", pointer));
        return;
      }
      validateScalarEnum(schema.enum, value, pointer, diagnostics);
      validateString(schema, value, pointer, diagnostics);
      return;
    case "number":
      if (!isSupportedNumber(value)) {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be a finite supported number.", pointer));
        return;
      }
      validateScalarEnum(schema.enum, value, pointer, diagnostics);
      validateNumber(schema, value, pointer, diagnostics);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be a safe integer.", pointer));
        return;
      }
      validateScalarEnum(schema.enum, value, pointer, diagnostics);
      validateNumber(schema, value, pointer, diagnostics);
      return;
    case "array":
      if (!Array.isArray(value)) {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be an array.", pointer));
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MIN_ITEMS", "Array has fewer items than minItems.", pointer));
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MAX_ITEMS", "Array has more items than maxItems.", pointer));
      }
      if (schema.uniqueItems === true) {
        validateUniqueItems(value, pointer, diagnostics);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) break;
        collectBoundaryValueDiagnosticsV1(
          schema.items,
          value[index]!,
          appendJsonPointerV1(pointer, index),
          diagnostics,
        );
      }
      return;
    case "object":
      if (!isJsonObject(value)) {
        diagnostics.push(valueDiagnostic("BSV1_VALUE_TYPE", "Value must be an object.", pointer));
        return;
      }
      validateObject(schema, value, pointer, diagnostics);
  }
}

function validateString(
  schema: Extract<BoundarySchemaV1, { readonly type: "string" }>,
  value: string,
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MIN_LENGTH", "String is shorter than minLength.", pointer));
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MAX_LENGTH", "String is longer than maxLength.", pointer));
  }
  if (schema.format !== undefined && !matchesStringFormat(value, schema.format)) {
    addDiagnostic(diagnostics, valueDiagnostic(
      "BSV1_VALUE_FORMAT",
      `String does not match the ${schema.format} format.`,
      pointer,
    ));
  }
}

function validateNumber(
  schema: BoundaryNumberSchemaV1 | Extract<BoundarySchemaV1, { readonly type: "integer" }>,
  value: number,
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MINIMUM", "Number is below minimum.", pointer));
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_MAXIMUM", "Number is above maximum.", pointer));
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_EXCLUSIVE_MINIMUM", "Number is not above exclusiveMinimum.", pointer));
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_EXCLUSIVE_MAXIMUM", "Number is not below exclusiveMaximum.", pointer));
  }
}

function validateObject(
  schema: Extract<BoundarySchemaV1, { readonly type: "object" }>,
  value: Readonly<Record<string, BoundaryJsonValue>>,
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  const keys = Object.keys(value).sort(compareText);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    addDiagnostic(diagnostics, valueDiagnostic(
      "BSV1_VALUE_MIN_PROPERTIES",
      "Object has fewer properties than minProperties.",
      pointer,
    ));
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    addDiagnostic(diagnostics, valueDiagnostic(
      "BSV1_VALUE_MAX_PROPERTIES",
      "Object has more properties than maxProperties.",
      pointer,
    ));
  }

  for (const required of schema.required ?? []) {
    if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) break;
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      addDiagnostic(diagnostics, valueDiagnostic(
        "BSV1_VALUE_REQUIRED",
        "Required object property is missing.",
        appendJsonPointerV1(pointer, required),
      ));
    }
  }

  const properties = schema.properties ?? Object.freeze(Object.create(null)) as Readonly<Record<string, BoundarySchemaV1>>;
  const additional = schema.additionalProperties ?? false;
  for (const key of keys) {
    if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) break;
    const propertyPointer = appendJsonPointerV1(pointer, key);
    const propertySchema = properties[key];
    if (propertySchema !== undefined) {
      collectBoundaryValueDiagnosticsV1(propertySchema, value[key]!, propertyPointer, diagnostics);
      continue;
    }
    if (additional === false) {
      addDiagnostic(diagnostics, valueDiagnostic(
        "BSV1_VALUE_ADDITIONAL_PROPERTY",
        "Additional object properties are not allowed.",
        propertyPointer,
      ));
      continue;
    }
    collectBoundaryValueDiagnosticsV1(additional, value[key]!, propertyPointer, diagnostics);
  }
}

function validateScalarEnum<T extends null | boolean | number | string>(
  values: readonly T[] | undefined,
  value: T,
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  if (values !== undefined && !values.some((candidate) => Object.is(candidate, value))) {
    addDiagnostic(diagnostics, valueDiagnostic("BSV1_VALUE_ENUM", "Value is not one of the allowed enum values.", pointer));
  }
}

function validateUniqueItems(
  values: readonly BoundaryJsonValue[],
  pointer: string,
  diagnostics: OsnovaDiagnosticV1[],
): void {
  const firstByCanonicalValue = new Map<string, number>();
  for (let index = 0; index < values.length; index += 1) {
    if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) break;
    const canonical = canonicalBoundaryJsonV1(values[index]);
    const first = firstByCanonicalValue.get(canonical);
    if (first !== undefined) {
      addDiagnostic(diagnostics, valueDiagnostic(
        "BSV1_VALUE_UNIQUE_ITEMS",
        `Array item duplicates item at index ${first}.`,
        appendJsonPointerV1(pointer, index),
      ));
    } else {
      firstByCanonicalValue.set(canonical, index);
    }
  }
}

function matchesStringFormat(value: string, format: BoundaryStringFormatV1): boolean {
  switch (format) {
    case "date":
      return isDate(value);
    case "time":
      return isTime(value);
    case "date-time": {
      const separator = value.indexOf("T");
      return separator > 0 && isDate(value.slice(0, separator)) && isTime(value.slice(separator + 1));
    }
    case "uuid":
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
    case "email":
      return isEmail(value);
    case "decimal":
      return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value);
    case "int64-string":
      return isInt64String(value);
  }
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function isTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offsetHour = match[5] === undefined ? 0 : Number(match[5]);
  const offsetMinute = match[6] === undefined ? 0 : Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function isEmail(value: string): boolean {
  if (value.length > 254 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator !== value.indexOf("@")) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (domain.length === 0 || domain.length > 253) return false;
  return domain.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function isInt64String(value: string): boolean {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    const integer = BigInt(value);
    return integer >= -9_223_372_036_854_775_808n && integer <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isSupportedNumber(value: BoundaryJsonValue): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function isJsonObject(value: BoundaryJsonValue): value is Readonly<Record<string, BoundaryJsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueDiagnostic(code: string, message: string, pointer: string): OsnovaDiagnosticV1 {
  return osnovaDiagnosticV1({ severity: "error", stage: "schema", code, message, pointer });
}

function addDiagnostic(
  diagnostics: OsnovaDiagnosticV1[],
  diagnostic: OsnovaDiagnosticV1,
): void {
  if (diagnostics.length > OSNOVA_DIAGNOSTIC_LIMIT_V1) return;
  diagnostics.push(diagnostic);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
