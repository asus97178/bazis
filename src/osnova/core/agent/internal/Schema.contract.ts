export function inlineGeneratedSchema(
  value: unknown,
  schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  stack: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > 32 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => inlineGeneratedSchema(item, schemas, stack, depth + 1));
  }
  const record = value as Readonly<Record<string, unknown>>;
  const reference = record.$ref;
  if (typeof reference === "string" && reference.startsWith("#/components/schemas/")) {
    const name = reference.slice("#/components/schemas/".length);
    const target = schemas[name];
    if (target === undefined || stack.has(name)) {
      return { type: "object" };
    }
    const next = new Set(stack);
    next.add(name);
    return inlineGeneratedSchema(target, schemas, next, depth + 1);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item !== undefined) {
      output[key] = inlineGeneratedSchema(item, schemas, stack, depth + 1);
    }
  }
  if ((output.type === "object" || output.properties !== undefined) && output.additionalProperties === undefined) {
    output.additionalProperties = false;
  }
  return output;
}

