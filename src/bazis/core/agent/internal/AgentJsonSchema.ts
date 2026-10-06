import { validateBoundaryValueV1 } from "../../../library/boundary";

type Schema = boolean | Readonly<Record<string, unknown>>;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const FORMATS = new Set(["email", "uri", "uuid", "date", "time", "date-time", "decimal", "int64-string"]);
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "example", "readOnly", "writeOnly", "deprecated", "$comment"]);
const COUNTS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const BOUNDS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const KEYWORDS = new Set(["type", "nullable", "properties", "required", "additionalProperties", "items", "anyOf", "oneOf", "allOf", "enum", "const", "uniqueItems", "pattern", "format", "contentMediaType", ...ANNOTATIONS, ...COUNTS, ...BOUNDS]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => equal(item, right[i]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

/** The runtime's supported JSON Schema subset. Unsupported rules fail closed. */
export function validateAgentJsonSchema(value: unknown, schema: unknown): readonly string[] {
  const patterns = new Map<Schema, RegExp>();
  let schemaNodes = 0;
  let valueNodes = 0;
  function inspect(node: unknown, path: string, depth: number): asserts node is Schema {
    if (++schemaNodes > 2_048 || depth > 32) throw new Error("JSON Schema exceeds traversal limits.");
    if (typeof node === "boolean") return;
    if (!record(node)) throw new Error(`${path} must be a schema object or boolean.`);
    for (const [key, item] of Object.entries(node)) {
      if (!KEYWORDS.has(key)) throw new Error(`${path}: unsupported JSON Schema keyword "${key}".`);
      if (COUNTS.has(key) && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) throw new Error(`${path}.${key} must be a non-negative integer.`);
      if (BOUNDS.has(key) && (typeof item !== "number" || !Number.isFinite(item))) throw new Error(`${path}.${key} must be finite.`);
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some((type) => typeof type !== "string" || !TYPES.has(type))) throw new Error(`${path}.type is unsupported.`);
    }
    for (const key of ["nullable", "uniqueItems"]) {
      if (node[key] !== undefined && typeof node[key] !== "boolean") throw new Error(`${path}.${key} must be boolean.`);
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string"))) throw new Error(`${path}.required must be an array of names.`);
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new Error(`${path}.enum must be a non-empty array.`);
    if (node.properties !== undefined) {
      if (!record(node.properties)) throw new Error(`${path}.properties must be an object.`);
      for (const [name, child] of Object.entries(node.properties)) inspect(child, `${path}.properties.${name}`, depth + 1);
    }
    for (const key of ["items", "additionalProperties"]) {
      if (node[key] !== undefined) inspect(node[key], `${path}.${key}`, depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key]) || !node[key].length) throw new Error(`${path}.${key} must be a non-empty schema array.`);
      node[key].forEach((child, i) => inspect(child, `${path}.${key}[${i}]`, depth + 1));
    }
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string") throw new Error(`${path}.pattern must be a string.`);
      patterns.set(node, new RegExp(node.pattern));
    }
    if (node.format !== undefined && (typeof node.format !== "string" || !FORMATS.has(node.format))) throw new Error(`${path}.format is unsupported.`);
    if (node.contentMediaType !== undefined && node.contentMediaType !== "application/json") throw new Error(`${path}.contentMediaType is unsupported.`);
  }

  function matchesType(item: unknown, type: unknown): boolean {
    if (type === "null") return item === null;
    if (type === "object") return record(item);
    if (type === "array") return Array.isArray(item);
    if (type === "integer") return typeof item === "number" && Number.isInteger(item);
    if (type === "number") return typeof item === "number" && Number.isFinite(item);
    return typeof item === type;
  }

  function check(item: unknown, node: Schema, path: string, issues: string[], depth: number): void {
    if (++valueNodes > 100_000 || depth > 64) throw new Error("JSON Schema validation exceeds traversal limits.");
    if (issues.length >= 64) return;
    if (node === true) return;
    if (node === false) { issues.push(`${path} is not allowed.`); return; }
    if (item === null && node.nullable === true) return;
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const alternatives = node[key] as Schema[] | undefined;
      if (alternatives === undefined) continue;
      let matches = 0;
      for (const child of alternatives) {
        const childIssues: string[] = [];
        check(item, child, path, childIssues, depth + 1);
        if (!childIssues.length) matches++;
      }
      if ((key === "anyOf" && matches === 0) || (key === "oneOf" && matches !== 1) || (key === "allOf" && matches !== alternatives.length)) issues.push(`${path} does not satisfy ${key}.`);
    }
    if (Object.hasOwn(node, "const") && !equal(item, node.const)) issues.push(`${path} must equal the declared constant.`);
    if (Array.isArray(node.enum) && !node.enum.some((allowed) => equal(item, allowed))) issues.push(`${path} is not an allowed enum value.`);
    const types = node.type === undefined ? undefined : Array.isArray(node.type) ? node.type : [node.type];
    if (types !== undefined && !types.some((type) => matchesType(item, type))) { issues.push(`${path} has an invalid type.`); return; }
    if (record(item)) {
      const properties = record(node.properties) ? node.properties : {};
      const keys = Object.keys(item);
      if (typeof node.minProperties === "number" && keys.length < node.minProperties) issues.push(`${path} has too few properties.`);
      if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) issues.push(`${path} has too many properties.`);
      for (const key of (node.required ?? []) as string[]) if (!Object.hasOwn(item, key)) issues.push(`${path}.${key} is required.`);
      for (const [key, child] of Object.entries(item)) {
        const childSchema = Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties;
        if (childSchema !== undefined) check(child, childSchema as Schema, `${path}.${key}`, issues, depth + 1);
      }
    }
    if (Array.isArray(item)) {
      if (typeof node.minItems === "number" && item.length < node.minItems) issues.push(`${path} has too few items.`);
      if (typeof node.maxItems === "number" && item.length > node.maxItems) issues.push(`${path} has too many items.`);
      if (node.uniqueItems === true) {
        const seen = new Set<string>();
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
        for (const child of item) {
          const key = JSON.stringify(canonical(child));
          if (seen.has(key)) { issues.push(`${path} must contain unique items.`); break; }
          seen.add(key);
        }
      }
      if (node.items !== undefined) item.forEach((child, i) => check(child, node.items as Schema, `${path}[${i}]`, issues, depth + 1));
    }
    if (typeof item === "string") {
      const length = [...item].length;
      if (typeof node.minLength === "number" && length < node.minLength) issues.push(`${path} is too short.`);
      if (typeof node.maxLength === "number" && length > node.maxLength) issues.push(`${path} is too long.`);
      if (patterns.has(node) && !patterns.get(node)!.test(item)) issues.push(`${path} does not match pattern.`);
      if (node.format !== undefined) {
        // Reuse Bazis's boundary formats; URI follows the model validator.
        const valid = node.format === "uri" ? URL.canParse(item) : validateBoundaryValueV1({ type: "string", format: node.format }, item).ok;
        if (!valid) issues.push(`${path} does not match format ${node.format}.`);
      }
      if (node.contentMediaType === "application/json") {
        try { JSON.parse(item); } catch { issues.push(`${path} must contain JSON.`); }
      }
    }
    if (typeof item === "number") {
      if (typeof node.minimum === "number" && item < node.minimum) issues.push(`${path} is below minimum.`);
      if (typeof node.maximum === "number" && item > node.maximum) issues.push(`${path} is above maximum.`);
      if (typeof node.exclusiveMinimum === "number" && item <= node.exclusiveMinimum) issues.push(`${path} is below exclusive minimum.`);
      if (typeof node.exclusiveMaximum === "number" && item >= node.exclusiveMaximum) issues.push(`${path} is above exclusive maximum.`);
    }
  }
  try {
    inspect(schema, "$schema", 0);
    const issues: string[] = [];
    check(value, schema, "$", issues, 0);
    return issues.slice(0, 64);
  } catch (error) {
    return [error instanceof Error ? error.message : "JSON Schema validation failed."];
  }
}
