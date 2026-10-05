import { describe, expect, test } from "bun:test";
import type { OsnvDiagnosticV1 } from "../diagnostics-v1";
import { normalizeBoundedJsonV1 } from "../json/normalizeBoundedJsonV1";
import type { BoundaryJsonValue } from "../json/types-v1";
import {
  BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1,
  BOUNDARY_SCHEMA_V1_DOMAIN,
  boundarySchemaHashV1,
  decodeBoundarySchemaV1,
  validateBoundaryValueV1,
  type BoundarySchemaV1,
} from "../schema";

describe("Osnv Boundary Schema v1", () => {
  test("decodes the closed dialect into a deeply frozen typed schema", () => {
    const result = decode({
      type: "object",
      title: "Create invoice",
      description: "A complete boundary contract.",
      properties: {
        id: { type: "string", format: "uuid", readOnly: true },
        amount: { type: "string", format: "decimal", minLength: 1 },
        tags: {
          type: "array",
          items: { type: "string", enum: ["new", "priority"] },
          maxItems: 10,
          uniqueItems: true,
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
      },
      required: ["id", "amount"],
      additionalProperties: false,
      default: {
        id: "00112233-4455-6677-8899-aabbccddeeff",
        amount: "0.00",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual([]);
    expect(result.schema.type).toBe("object");
    expect(Object.isFrozen(result.schema)).toBe(true);
    if (result.schema.type !== "object") return;
    expect(Object.isFrozen(result.schema.properties)).toBe(true);
    expect(Object.isFrozen(result.schema.required)).toBe(true);
    expect(Object.isFrozen(result.schema.default)).toBe(true);
    const tags = result.schema.properties?.tags;
    expect(tags?.type).toBe("array");
    expect(Object.isFrozen(tags)).toBe(true);
    if (tags?.type === "array") {
      expect(Object.isFrozen(tags.items)).toBe(true);
      expect(Object.isFrozen((tags.items as Extract<BoundarySchemaV1, { type: "string" }>).enum)).toBe(true);
    }
    const metadata = result.schema.properties?.metadata;
    expect(metadata?.type).toBe("object");
    if (metadata?.type === "object" && metadata.additionalProperties !== false) {
      expect(Object.isFrozen(metadata.additionalProperties)).toBe(true);
    }
  });

  test("keeps omitted defaults omitted and treats additionalProperties as closed at validation time", () => {
    const result = decode({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.schema.type !== "object") return;

    expect(Object.prototype.hasOwnProperty.call(result.schema, "additionalProperties")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.schema, "required")).toBe(false);
    const validation = validateBoundaryValueV1(result.schema, normalized({ name: "ok", extra: true }));
    expect(validation.ok).toBe(false);
    expect(codes(validation.diagnostics)).toEqual(["BSV1_VALUE_ADDITIONAL_PROPERTY"]);
    expect(validation.diagnostics[0]?.pointer).toBe("/extra");
  });

  test("rejects unknown and type-specific keywords with deterministic pointers", () => {
    const result = decode({
      type: "string",
      additionalProperties: false,
      oneOf: [],
      pattern: ".*",
      $ref: "#/anything",
      minimum: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.pointer)).toEqual([
      "/$ref",
      "/additionalProperties",
      "/minimum",
      "/oneOf",
      "/pattern",
    ]);
    expect(new Set(codes(result.diagnostics))).toEqual(new Set(["BSV1_SCHEMA_UNKNOWN_PROPERTY"]));
    expect(result.diagnostics.every((item) => item.stage === "schema" && item.severity === "error")).toBe(true);
  });

  test("requires an explicit supported type and array items", () => {
    const missingType = decode({ title: "missing" });
    expect(missingType.ok).toBe(false);
    expect(missingType.diagnostics[0]).toEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_REQUIRED",
      pointer: "/type",
    }));

    const unsupportedType = decode({ type: "union" });
    expect(unsupportedType.ok).toBe(false);
    expect(unsupportedType.diagnostics[0]).toEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_TYPE",
      pointer: "/type",
    }));

    const missingItems = decode({ type: "array" });
    expect(missingItems.ok).toBe(false);
    expect(missingItems.diagnostics[0]).toEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_REQUIRED",
      pointer: "/items",
    }));
  });

  test("accepts only homogeneous, unique, bounded scalar enums", () => {
    for (const schema of [
      { type: "null", enum: [null] },
      { type: "boolean", enum: [false, true] },
      { type: "string", enum: ["a", "b"] },
      { type: "number", enum: [1.5, 2] },
      { type: "integer", enum: [1, 2] },
    ]) {
      expect(decode(schema).ok).toBe(true);
    }

    const heterogeneous = decode({ type: "integer", enum: [1, "2", 3] });
    expect(heterogeneous.ok).toBe(false);
    expect(heterogeneous.diagnostics).toContainEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_ENUM_TYPE",
      pointer: "/enum/1",
    }));

    const duplicate = decode({ type: "string", enum: ["same", "same"] });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_ENUM_DUPLICATE",
      pointer: "/enum/1",
    }));

    const oversized = decode({
      type: "integer",
      enum: Array.from({ length: BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1 + 1 }, (_, index) => index),
    });
    expect(oversized.ok).toBe(false);
    expect(codes(oversized.diagnostics)).toContain("BSV1_SCHEMA_ENUM_LIMIT");
  });

  test("rejects unsafe integer values and invalid keyword ranges", () => {
    const unsafe = decodeBoundarySchemaV1({
      type: "integer",
      enum: [Number.MAX_SAFE_INTEGER + 1],
    } as unknown as BoundaryJsonValue);
    expect(unsafe.ok).toBe(false);
    expect(codes(unsafe.diagnostics)).toContain("WF_JSON_NUMBER_OUT_OF_RANGE");

    const ranges = decode({
      type: "object",
      properties: {
        text: { type: "string", minLength: 5, maxLength: 4 },
        amount: { type: "number", minimum: 10, exclusiveMaximum: 10 },
        list: { type: "array", items: { type: "null" }, minItems: 2, maxItems: 1 },
      },
    });
    expect(ranges.ok).toBe(false);
    expect(ranges.diagnostics.filter((item) => item.code === "BSV1_SCHEMA_RANGE").map((item) => item.pointer)).toEqual([
      "/properties/amount",
      "/properties/list",
      "/properties/text",
    ]);

    const invalidUnique = decode({ type: "array", items: { type: "string" }, uniqueItems: false });
    expect(invalidUnique.ok).toBe(false);
    expect(codes(invalidUnique.diagnostics)).toContain("BSV1_SCHEMA_UNIQUE_ITEMS");
  });

  test("requires unique declared object property names in required", () => {
    const result = decode({
      type: "object",
      properties: { known: { type: "string" } },
      required: ["known", "known", "missing"],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_REQUIRED_DUPLICATE",
      pointer: "/required/1",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_REQUIRED_UNKNOWN",
      pointer: "/required/2",
    }));
  });

  test("allows false or one schema for additionalProperties, never true", () => {
    expect(decode({ type: "object", additionalProperties: false }).ok).toBe(true);
    expect(decode({ type: "object", additionalProperties: { type: "boolean" } }).ok).toBe(true);

    const open = decode({ type: "object", additionalProperties: true });
    expect(open.ok).toBe(false);
    expect(open.diagnostics[0]).toEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_ADDITIONAL_PROPERTIES",
      pointer: "/additionalProperties",
    }));
  });

  test("validates defaults with the same schema and exact nested pointers", () => {
    const invalid = decode({
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
      },
      required: ["count"],
      default: { count: 0, extra: true },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((item) => [item.code, item.pointer])).toEqual([
      ["BSV1_VALUE_MINIMUM", "/default/count"],
      ["BSV1_VALUE_ADDITIONAL_PROPERTY", "/default/extra"],
    ]);

    const nullable = decode({ type: "string", nullable: true, default: null });
    expect(nullable.ok).toBe(true);
  });

  test("validates nested values, required fields, uniqueness and explicit dictionaries", () => {
    const decoded = decode({
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        labels: { type: "array", items: { type: "string", minLength: 2 }, uniqueItems: true },
      },
      required: ["id"],
      additionalProperties: { type: "boolean" },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const valid = validateBoundaryValueV1(decoded.schema, normalized({
      id: 1,
      labels: ["aa", "bb"],
      enabled: true,
    }));
    expect(valid.ok).toBe(true);

    const invalid = validateBoundaryValueV1(decoded.schema, normalized({
      labels: ["x", "same", "same"],
      enabled: "yes",
    }));
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((item) => [item.code, item.pointer])).toEqual([
      ["BSV1_VALUE_REQUIRED", "/id"],
      ["BSV1_VALUE_MIN_LENGTH", "/labels/0"],
      ["BSV1_VALUE_UNIQUE_ITEMS", "/labels/2"],
      ["BSV1_VALUE_TYPE", "/enabled"],
    ].sort(compareDiagnosticTuple));
  });

  test("validates all frozen string formats deterministically", () => {
    const examples: readonly [string, string, string][] = [
      ["date", "2024-02-29", "2023-02-29"],
      ["time", "23:59:59.123Z", "24:00:00Z"],
      ["date-time", "2024-02-29T23:59:59+03:00", "2024-02-30T12:00:00Z"],
      ["uuid", "00112233-4455-6677-8899-aabbccddeeff", "00112233-4455"],
      ["email", "alexander@example.com", "bad@@example.com"],
      ["decimal", "-1234567890.001", "01.2"],
      ["int64-string", "9223372036854775807", "9223372036854775808"],
    ];

    for (const [format, valid, invalid] of examples) {
      const decoded = decode({ type: "string", format });
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(validateBoundaryValueV1(decoded.schema, valid).ok).toBe(true);
      const validation = validateBoundaryValueV1(decoded.schema, invalid);
      expect(validation.ok).toBe(false);
      expect(codes(validation.diagnostics)).toEqual(["BSV1_VALUE_FORMAT"]);
    }
  });

  test("enforces the shared JSON/schema depth ceiling before schema work", () => {
    let schema: BoundaryJsonValue = { type: "null" };
    for (let depth = 1; depth <= 32; depth += 1) {
      schema = { type: "array", items: schema };
    }
    const result = decodeBoundarySchemaV1(schema);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "WF_JSON_DEPTH_LIMIT",
    }));
    expect((result.diagnostics[0]?.pointer.split("/items").length ?? 1) - 1).toBe(32);
  });

  test("enforces the 2048 schema-node ceiling", () => {
    const properties = Object.create(null) as Record<string, BoundaryJsonValue>;
    for (let index = 0; index < 2_048; index += 1) {
      properties[`p${String(index).padStart(4, "0")}`] = { type: "null" };
    }
    const result = decodeBoundarySchemaV1({ type: "object", properties });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      code: "BSV1_SCHEMA_NODE_LIMIT",
      pointer: "/properties/p2047",
    }));
  });

  test("prefixes, sorts and freezes structured diagnostics", () => {
    const result = decodeBoundarySchemaV1(normalized({
      type: "object",
      properties: {
        z: { type: "array" },
        a: { type: "string", minimum: 1 },
      },
    }), { pointer: "/definition/inputSchema" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.pointer)).toEqual([
      "/definition/inputSchema/properties/a/minimum",
      "/definition/inputSchema/properties/z/items",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(result.diagnostics.every(Object.isFrozen)).toBe(true);
  });

  test("uses a stable domain-separated canonical schema hash", () => {
    expect(BOUNDARY_SCHEMA_V1_DOMAIN).toBe("osnv.boundary-schema/v1");
    const first = decode({
      type: "object",
      required: ["name"],
      properties: { name: { maxLength: 50, type: "string" } },
    });
    const reordered = decode({
      properties: { name: { type: "string", maxLength: 50 } },
      type: "object",
      required: ["name"],
    });
    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    const hash = boundarySchemaHashV1(first.schema);
    expect(hash).toBe(boundarySchemaHashV1(reordered.schema));
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("keeps public schema and value APIs safe for runtime unknown inputs", () => {
    let trapInvoked = false;
    const proxy = new Proxy({}, {
      get() {
        trapInvoked = true;
        return "object";
      },
      getPrototypeOf() {
        trapInvoked = true;
        return Object.prototype;
      },
      ownKeys() {
        trapInvoked = true;
        return [];
      },
    });
    expect(decodeBoundarySchemaV1(proxy).ok).toBe(false);
    expect(trapInvoked).toBe(false);

    const schema = decodeBoundarySchemaV1({
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
    });
    expect(schema.ok).toBe(true);
    if (!schema.ok) return;

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        trapInvoked = true;
        return 1;
      },
    });
    expect(validateBoundaryValueV1(schema.schema, accessor).ok).toBe(false);
    expect(trapInvoked).toBe(false);

    const oversized = validateBoundaryValueV1(
      { type: "array", items: { type: "null" } },
      Array.from({ length: 10_001 }, () => null),
    );
    expect(oversized.ok).toBe(false);
    expect(codes(oversized.diagnostics)).toEqual(["WF_JSON_ARRAY_LIMIT"]);
  });

  test("caps value diagnostics before sorting and reports truncation", () => {
    const schema = decodeBoundarySchemaV1({
      type: "object",
      additionalProperties: false,
    });
    expect(schema.ok).toBe(true);
    if (!schema.ok) return;

    const value = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`p${index}`, true]),
    );
    const result = validateBoundaryValueV1(schema.schema, value);
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toHaveLength(100);
    expect(result.diagnostics.at(-1)?.code).toBe("WF_DIAGNOSTICS_TRUNCATED");
  });
});

function decode(input: unknown) {
  return decodeBoundarySchemaV1(input);
}

function normalized(input: unknown): BoundaryJsonValue {
  const result = normalizeBoundedJsonV1(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "Test JSON normalization failed.");
  return result.value;
}

function codes(diagnostics: readonly OsnvDiagnosticV1[]): string[] {
  return diagnostics.map((item) => item.code);
}

function compareDiagnosticTuple(left: readonly string[], right: readonly string[]): number {
  return left[1]! < right[1]! ? -1 : left[1]! > right[1]! ? 1 : 0;
}
