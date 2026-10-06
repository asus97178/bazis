import {
  appendJsonPointerV1,
  finalizeBazisDiagnosticsV1,
  BAZIS_DIAGNOSTIC_LIMIT_V1,
  bazisDiagnosticV1,
  type BazisDiagnosticsV1,
  type BazisDiagnosticV1,
} from "../diagnostics-v1";
import {
  isBoundaryJsonObject,
  type BoundaryJsonObject,
  type BoundaryJsonValue,
} from "../json/types-v1";
import { normalizeBoundedJsonV1 } from "../json/normalizeBoundedJsonV1";
import { collectBoundaryValueDiagnosticsV1 } from "./collectBoundaryValueDiagnosticsV1";
import {
  BOUNDARY_SCHEMA_MAX_DEPTH_V1,
  BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1,
  BOUNDARY_SCHEMA_MAX_NODES_V1,
  type BoundarySchemaTypeV1,
  type BoundarySchemaV1,
  type BoundaryStringFormatV1,
} from "./types-v1";

export interface DecodeBoundarySchemaV1Options {
  readonly pointer?: string;
}

export type DecodeBoundarySchemaV1Result =
  | ({ readonly ok: true; readonly schema: BoundarySchemaV1 } & BazisDiagnosticsV1)
  | ({ readonly ok: false } & BazisDiagnosticsV1);

const SCHEMA_TYPES = new Set<BoundarySchemaTypeV1>([
  "null",
  "boolean",
  "string",
  "number",
  "integer",
  "array",
  "object",
]);

const STRING_FORMATS = new Set<BoundaryStringFormatV1>([
  "date",
  "time",
  "date-time",
  "uuid",
  "email",
  "decimal",
  "int64-string",
]);

const COMMON_PROPERTIES = [
  "type",
  "title",
  "description",
  "nullable",
  "readOnly",
  "writeOnly",
  "secret",
  "default",
] as const;

const TYPE_PROPERTIES: Readonly<Record<BoundarySchemaTypeV1, readonly string[]>> = Object.freeze({
  null: Object.freeze(["enum"]),
  boolean: Object.freeze(["enum"]),
  string: Object.freeze(["enum", "minLength", "maxLength", "format"]),
  number: Object.freeze(["enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]),
  integer: Object.freeze(["enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]),
  array: Object.freeze(["items", "minItems", "maxItems", "uniqueItems"]),
  object: Object.freeze([
    "properties",
    "required",
    "minProperties",
    "maxProperties",
    "additionalProperties",
  ]),
});

const UTF8 = new TextEncoder();
const MAX_TITLE_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 8_192;

export function decodeBoundarySchemaV1(
  input: unknown,
  options: DecodeBoundarySchemaV1Options = {},
): DecodeBoundarySchemaV1Result {
  const pointer = options.pointer ?? "";
  const normalized = normalizeBoundedJsonV1(input);
  if (!normalized.ok) {
    const diagnostics = pointer === ""
      ? normalized.diagnostics
      : Object.freeze(normalized.diagnostics.map((item) => bazisDiagnosticV1({
          ...item,
          pointer: pointer + item.pointer,
        })));
    return Object.freeze({
      ok: false,
      diagnostics,
      truncated: normalized.truncated,
    });
  }

  const decoder = new BoundarySchemaDecoderV1();
  const schema = decoder.decode(normalized.value, pointer, 1);
  const finalized = finalizeBazisDiagnosticsV1(decoder.diagnostics);
  if (schema === undefined || finalized.diagnostics.length > 0) {
    return Object.freeze({ ok: false, ...finalized });
  }
  return Object.freeze({ ok: true, schema, ...finalized });
}

class BoundarySchemaDecoderV1 {
  readonly diagnostics: BazisDiagnosticV1[] = [];
  private nodes = 0;
  private nodeLimitReported = false;

  decode(input: BoundaryJsonValue, pointer: string, depth: number): BoundarySchemaV1 | undefined {
    if (depth > BOUNDARY_SCHEMA_MAX_DEPTH_V1) {
      this.add(
        "BSV1_SCHEMA_DEPTH_LIMIT",
        "Boundary Schema nesting depth exceeds the v1 ceiling.",
        pointer,
      );
      return undefined;
    }
    this.nodes += 1;
    if (this.nodes > BOUNDARY_SCHEMA_MAX_NODES_V1) {
      if (!this.nodeLimitReported) {
        this.nodeLimitReported = true;
        this.add(
          "BSV1_SCHEMA_NODE_LIMIT",
          "Boundary Schema node count exceeds the v1 ceiling.",
          pointer,
        );
      }
      return undefined;
    }
    if (!isBoundaryJsonObject(input)) {
      this.add("BSV1_SCHEMA_OBJECT", "A Boundary Schema node must be an object.", pointer);
      return undefined;
    }

    const rawType = input.type;
    const typePointer = appendJsonPointerV1(pointer, "type");
    if (typeof rawType !== "string" || !SCHEMA_TYPES.has(rawType as BoundarySchemaTypeV1)) {
      this.add(
        rawType === undefined ? "BSV1_SCHEMA_REQUIRED" : "BSV1_SCHEMA_TYPE",
        rawType === undefined
          ? "Boundary Schema property 'type' is required."
          : "Boundary Schema 'type' is not supported by v1.",
        typePointer,
      );
      this.rejectUnknownProperties(input, pointer, undefined);
      return undefined;
    }

    const type = rawType as BoundarySchemaTypeV1;
    const diagnosticsBefore = this.diagnostics.length;
    this.rejectUnknownProperties(input, pointer, type);
    const output = Object.create(null) as Record<string, unknown>;
    output.type = type;
    this.decodeCommon(input, output, pointer);

    switch (type) {
      case "null":
      case "boolean":
      case "string":
      case "number":
      case "integer":
        this.decodeScalar(input, output, pointer, type);
        break;
      case "array":
        this.decodeArray(input, output, pointer, depth);
        break;
      case "object":
        this.decodeObject(input, output, pointer, depth);
        break;
    }

    if (hasOwn(input, "default")) {
      output.default = cloneBoundaryJsonValue(input.default!);
    }

    const schema = Object.freeze(output) as unknown as BoundarySchemaV1;
    if (hasOwn(input, "default") && this.diagnostics.length === diagnosticsBefore) {
      collectBoundaryValueDiagnosticsV1(
        schema,
        output.default as BoundaryJsonValue,
        appendJsonPointerV1(pointer, "default"),
        this.diagnostics,
      );
    }
    return schema;
  }

  private decodeCommon(
    input: BoundaryJsonObject,
    output: Record<string, unknown>,
    pointer: string,
  ): void {
    const title = this.optionalString(input, "title", pointer);
    if (title !== undefined) {
      output.title = title;
      if (UTF8.encode(title).byteLength > MAX_TITLE_BYTES) {
        this.add(
          "BSV1_SCHEMA_TITLE_LIMIT",
          "Boundary Schema title exceeds 256 UTF-8 bytes.",
          appendJsonPointerV1(pointer, "title"),
        );
      }
    }
    const description = this.optionalString(input, "description", pointer);
    if (description !== undefined) {
      output.description = description;
      if (UTF8.encode(description).byteLength > MAX_DESCRIPTION_BYTES) {
        this.add(
          "BSV1_SCHEMA_DESCRIPTION_LIMIT",
          "Boundary Schema description exceeds 8192 UTF-8 bytes.",
          appendJsonPointerV1(pointer, "description"),
        );
      }
    }
    for (const property of ["nullable", "readOnly", "writeOnly", "secret"] as const) {
      const value = this.optionalBoolean(input, property, pointer);
      if (value !== undefined) output[property] = value;
    }
  }

  private decodeScalar(
    input: BoundaryJsonObject,
    output: Record<string, unknown>,
    pointer: string,
    type: "null" | "boolean" | "string" | "number" | "integer",
  ): void {
    const enumeration = this.optionalEnum(input, pointer, type);
    if (enumeration !== undefined) output.enum = enumeration;

    if (type === "string") {
      const minimum = this.optionalCount(input, "minLength", pointer);
      const maximum = this.optionalCount(input, "maxLength", pointer);
      if (minimum !== undefined) output.minLength = minimum;
      if (maximum !== undefined) output.maxLength = maximum;
      this.checkOrderedRange(minimum, maximum, pointer, "minLength", "maxLength");

      if (hasOwn(input, "format")) {
        const format = input.format;
        if (typeof format !== "string" || !STRING_FORMATS.has(format as BoundaryStringFormatV1)) {
          this.add(
            "BSV1_SCHEMA_FORMAT",
            "Boundary Schema string format is not supported by v1.",
            appendJsonPointerV1(pointer, "format"),
          );
        } else {
          output.format = format;
        }
      }
      return;
    }

    if (type === "number" || type === "integer") {
      const minimum = this.optionalNumber(input, "minimum", pointer);
      const maximum = this.optionalNumber(input, "maximum", pointer);
      const exclusiveMinimum = this.optionalNumber(input, "exclusiveMinimum", pointer);
      const exclusiveMaximum = this.optionalNumber(input, "exclusiveMaximum", pointer);
      if (minimum !== undefined) output.minimum = minimum;
      if (maximum !== undefined) output.maximum = maximum;
      if (exclusiveMinimum !== undefined) output.exclusiveMinimum = exclusiveMinimum;
      if (exclusiveMaximum !== undefined) output.exclusiveMaximum = exclusiveMaximum;
      this.checkNumericRange(minimum, maximum, exclusiveMinimum, exclusiveMaximum, pointer);
    }
  }

  private decodeArray(
    input: BoundaryJsonObject,
    output: Record<string, unknown>,
    pointer: string,
    depth: number,
  ): void {
    const itemsPointer = appendJsonPointerV1(pointer, "items");
    if (!hasOwn(input, "items")) {
      this.add("BSV1_SCHEMA_REQUIRED", "Array schema property 'items' is required.", itemsPointer);
    } else {
      const items = this.decode(input.items!, itemsPointer, depth + 1);
      if (items !== undefined) output.items = items;
    }

    const minimum = this.optionalCount(input, "minItems", pointer);
    const maximum = this.optionalCount(input, "maxItems", pointer);
    if (minimum !== undefined) output.minItems = minimum;
    if (maximum !== undefined) output.maxItems = maximum;
    this.checkOrderedRange(minimum, maximum, pointer, "minItems", "maxItems");

    if (hasOwn(input, "uniqueItems")) {
      if (input.uniqueItems !== true) {
        this.add(
          "BSV1_SCHEMA_UNIQUE_ITEMS",
          "Boundary Schema uniqueItems, when present, must be true.",
          appendJsonPointerV1(pointer, "uniqueItems"),
        );
      } else {
        output.uniqueItems = true;
      }
    }
  }

  private decodeObject(
    input: BoundaryJsonObject,
    output: Record<string, unknown>,
    pointer: string,
    depth: number,
  ): void {
    let declaredProperties = new Set<string>();
    if (hasOwn(input, "properties")) {
      const propertiesPointer = appendJsonPointerV1(pointer, "properties");
      if (!isBoundaryJsonObject(input.properties!)) {
        this.add("BSV1_SCHEMA_PROPERTIES", "Boundary Schema properties must be an object.", propertiesPointer);
      } else {
        const properties = Object.create(null) as Record<string, BoundarySchemaV1>;
        const keys = Object.keys(input.properties!).sort(compareText);
        declaredProperties = new Set(keys);
        for (const key of keys) {
          const propertySchema = this.decode(
            input.properties![key]!,
            appendJsonPointerV1(propertiesPointer, key),
            depth + 1,
          );
          if (propertySchema !== undefined) properties[key] = propertySchema;
        }
        output.properties = Object.freeze(properties);
      }
    }

    if (hasOwn(input, "required")) {
      const requiredPointer = appendJsonPointerV1(pointer, "required");
      if (!Array.isArray(input.required)) {
        this.add("BSV1_SCHEMA_REQUIRED_LIST", "Boundary Schema required must be an array.", requiredPointer);
      } else {
        const required: string[] = [];
        const seen = new Set<string>();
        for (let index = 0; index < input.required.length; index += 1) {
          const entry = input.required[index];
          const entryPointer = appendJsonPointerV1(requiredPointer, index);
          if (typeof entry !== "string") {
            this.add("BSV1_SCHEMA_REQUIRED_NAME", "Required property names must be strings.", entryPointer);
            continue;
          }
          if (seen.has(entry)) {
            this.add("BSV1_SCHEMA_REQUIRED_DUPLICATE", "Required property names must be unique.", entryPointer);
            continue;
          }
          seen.add(entry);
          required.push(entry);
          if (!declaredProperties.has(entry)) {
            this.add(
              "BSV1_SCHEMA_REQUIRED_UNKNOWN",
              "Required property must be declared in properties.",
              entryPointer,
            );
          }
        }
        output.required = Object.freeze(required);
      }
    }

    const minimum = this.optionalCount(input, "minProperties", pointer);
    const maximum = this.optionalCount(input, "maxProperties", pointer);
    if (minimum !== undefined) output.minProperties = minimum;
    if (maximum !== undefined) output.maxProperties = maximum;
    this.checkOrderedRange(minimum, maximum, pointer, "minProperties", "maxProperties");

    if (hasOwn(input, "additionalProperties")) {
      const additionalPointer = appendJsonPointerV1(pointer, "additionalProperties");
      if (input.additionalProperties === false) {
        output.additionalProperties = false;
      } else if (isBoundaryJsonObject(input.additionalProperties!)) {
        const additional = this.decode(input.additionalProperties!, additionalPointer, depth + 1);
        if (additional !== undefined) output.additionalProperties = additional;
      } else {
        this.add(
          "BSV1_SCHEMA_ADDITIONAL_PROPERTIES",
          "Boundary Schema additionalProperties must be false or a schema object.",
          additionalPointer,
        );
      }
    }
  }

  private optionalEnum(
    input: BoundaryJsonObject,
    pointer: string,
    type: "null" | "boolean" | "string" | "number" | "integer",
  ): readonly (null | boolean | string | number)[] | undefined {
    if (!hasOwn(input, "enum")) return undefined;
    const enumPointer = appendJsonPointerV1(pointer, "enum");
    if (!Array.isArray(input.enum)) {
      this.add("BSV1_SCHEMA_ENUM", "Boundary Schema enum must be an array.", enumPointer);
      return undefined;
    }
    if (input.enum.length < 1 || input.enum.length > BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1) {
      this.add(
        "BSV1_SCHEMA_ENUM_LIMIT",
        "Boundary Schema enum must contain between 1 and 256 values.",
        enumPointer,
      );
    }
    const output: (null | boolean | string | number)[] = [];
    for (let index = 0; index < input.enum.length; index += 1) {
      const value = input.enum[index]!;
      const itemPointer = appendJsonPointerV1(enumPointer, index);
      if (!matchesScalarType(value, type)) {
        this.add(
          "BSV1_SCHEMA_ENUM_TYPE",
          "Boundary Schema enum value must have the declared scalar type.",
          itemPointer,
        );
        continue;
      }
      if (output.some((existing) => Object.is(existing, value))) {
        this.add("BSV1_SCHEMA_ENUM_DUPLICATE", "Boundary Schema enum values must be unique.", itemPointer);
        continue;
      }
      output.push(value);
    }
    return Object.freeze(output);
  }

  private optionalString(
    input: BoundaryJsonObject,
    property: string,
    pointer: string,
  ): string | undefined {
    if (!hasOwn(input, property)) return undefined;
    const value = input[property];
    if (typeof value !== "string") {
      this.add(
        "BSV1_SCHEMA_KEYWORD_TYPE",
        `Boundary Schema '${property}' must be a string.`,
        appendJsonPointerV1(pointer, property),
      );
      return undefined;
    }
    return value;
  }

  private optionalBoolean(
    input: BoundaryJsonObject,
    property: string,
    pointer: string,
  ): boolean | undefined {
    if (!hasOwn(input, property)) return undefined;
    const value = input[property];
    if (typeof value !== "boolean") {
      this.add(
        "BSV1_SCHEMA_KEYWORD_TYPE",
        `Boundary Schema '${property}' must be a boolean.`,
        appendJsonPointerV1(pointer, property),
      );
      return undefined;
    }
    return value;
  }

  private optionalCount(
    input: BoundaryJsonObject,
    property: string,
    pointer: string,
  ): number | undefined {
    if (!hasOwn(input, property)) return undefined;
    const value = input[property];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      this.add(
        "BSV1_SCHEMA_COUNT",
        `Boundary Schema '${property}' must be a non-negative safe integer.`,
        appendJsonPointerV1(pointer, property),
      );
      return undefined;
    }
    return value;
  }

  private optionalNumber(
    input: BoundaryJsonObject,
    property: string,
    pointer: string,
  ): number | undefined {
    if (!hasOwn(input, property)) return undefined;
    const value = input[property];
    if (!isSupportedNumber(value)) {
      this.add(
        "BSV1_SCHEMA_NUMBER",
        `Boundary Schema '${property}' must be a finite supported number.`,
        appendJsonPointerV1(pointer, property),
      );
      return undefined;
    }
    return value;
  }

  private rejectUnknownProperties(
    input: BoundaryJsonObject,
    pointer: string,
    type: BoundarySchemaTypeV1 | undefined,
  ): void {
    const allowed = new Set<string>(COMMON_PROPERTIES);
    if (type !== undefined) {
      for (const property of TYPE_PROPERTIES[type]) allowed.add(property);
    }
    for (const key of Object.keys(input).sort(compareText)) {
      if (!allowed.has(key)) {
        this.add(
          "BSV1_SCHEMA_UNKNOWN_PROPERTY",
          "Property is not supported by this Boundary Schema node type.",
          appendJsonPointerV1(pointer, key),
        );
      }
    }
  }

  private checkOrderedRange(
    minimum: number | undefined,
    maximum: number | undefined,
    pointer: string,
    minimumName: string,
    maximumName: string,
  ): void {
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      this.add(
        "BSV1_SCHEMA_RANGE",
        `Boundary Schema '${minimumName}' cannot exceed '${maximumName}'.`,
        pointer,
      );
    }
  }

  private checkNumericRange(
    minimum: number | undefined,
    maximum: number | undefined,
    exclusiveMinimum: number | undefined,
    exclusiveMaximum: number | undefined,
    pointer: string,
  ): void {
    const lower = strongestLowerBound(minimum, exclusiveMinimum);
    const upper = strongestUpperBound(maximum, exclusiveMaximum);
    if (
      lower !== undefined
      && upper !== undefined
      && (lower.value > upper.value || (lower.value === upper.value && (lower.exclusive || upper.exclusive)))
    ) {
      this.add(
        "BSV1_SCHEMA_RANGE",
        "Boundary Schema numeric constraints describe an empty range.",
        pointer,
      );
    }
  }

  private add(code: string, message: string, pointer: string): void {
    if (this.diagnostics.length > BAZIS_DIAGNOSTIC_LIMIT_V1) return;
    this.diagnostics.push(bazisDiagnosticV1({
      severity: "error",
      stage: "schema",
      code,
      message,
      pointer,
    }));
  }
}

interface NumericBound {
  readonly value: number;
  readonly exclusive: boolean;
}

function strongestLowerBound(
  minimum: number | undefined,
  exclusiveMinimum: number | undefined,
): NumericBound | undefined {
  if (minimum === undefined) {
    return exclusiveMinimum === undefined ? undefined : { value: exclusiveMinimum, exclusive: true };
  }
  if (exclusiveMinimum === undefined || minimum > exclusiveMinimum) {
    return { value: minimum, exclusive: false };
  }
  return { value: exclusiveMinimum, exclusive: true };
}

function strongestUpperBound(
  maximum: number | undefined,
  exclusiveMaximum: number | undefined,
): NumericBound | undefined {
  if (maximum === undefined) {
    return exclusiveMaximum === undefined ? undefined : { value: exclusiveMaximum, exclusive: true };
  }
  if (exclusiveMaximum === undefined || maximum < exclusiveMaximum) {
    return { value: maximum, exclusive: false };
  }
  return { value: exclusiveMaximum, exclusive: true };
}

function matchesScalarType(
  value: BoundaryJsonValue,
  type: "null" | "boolean" | "string" | "number" | "integer",
): value is null | boolean | string | number {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return isSupportedNumber(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
  }
}

function isSupportedNumber(value: BoundaryJsonValue | undefined): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function cloneBoundaryJsonValue(value: BoundaryJsonValue): BoundaryJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneBoundaryJsonValue));
  }
  const object = value as BoundaryJsonObject;
  const output = Object.create(null) as Record<string, BoundaryJsonValue>;
  for (const key of Object.keys(object).sort(compareText)) {
    output[key] = cloneBoundaryJsonValue(object[key]!);
  }
  return Object.freeze(output);
}

function hasOwn(input: BoundaryJsonObject, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, property);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
