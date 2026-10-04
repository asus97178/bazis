import type { Class } from "../../di";
import { bindModel } from "../../http/Binding/modelBinder";
import { getGeneratedOpenApiMetadata, getGeneratedOpenApiSchemaName } from "../../http/OpenApi/generatedOpenApiRegistry";
import { ModelValidationError } from "../../http/Errors/HttpError";
import { normalizeJsonValue, type JsonObject } from "../semantic";

// Validation belongs to the Agent execution phase (and may be asynchronous).
// Never pick up an unrelated process-wide HTTP validator while hydrating a DTO.
const bindingOnly = Object.freeze({ validate: () => ({ isValid: true, errors: [] }) });

export function bindAgentModel(contract: Class<object>, value: unknown): object {
  try {
    return bindModel(contract, value, bindingOnly, {
      unknownFields: "reject",
      declaredFields(model) {
        const name = getGeneratedOpenApiSchemaName(model) ?? model.name;
        const properties = getGeneratedOpenApiMetadata().schemas[name]?.properties;
        return properties !== null && typeof properties === "object" && !Array.isArray(properties)
          ? Object.keys(properties) : undefined;
      },
    });
  } catch (error) {
    if (error instanceof ModelValidationError) {
      throw new Error(error.errors.map((issue) => issue.message).join("; "), { cause: error });
    }
    throw error;
  }
}

/** Project hydrated DTOs to JSON without calling arbitrary toJSON methods. */
export function agentModelJson(instance: object, path: string): JsonObject {
  const stack = new WeakSet<object>();
  let nodes = 0;
  function plain(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 64) throw new Error(`${path} exceeds model JSON traversal limits.`);
    if (value === null || typeof value !== "object") return value;
    if (stack.has(value)) throw new Error(`${path} must be acyclic JSON.`);
    stack.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
      if (Object.prototype.toString.call(value) !== "[object Object]") {
        throw new Error(`${path} contains a non-JSON object.`);
      }
      const output = Object.create(null) as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(value);
      const dto = prototype !== null && prototype !== Object.prototype;
      for (const [key, item] of Object.entries(value)) {
        // Unset optional class fields are absent in JSON. Array slots remain strict.
        if (item !== undefined || !dto) output[key] = plain(item, depth + 1);
      }
      return output;
    } finally {
      stack.delete(value);
    }
  }
  return normalizeJsonValue(plain(instance, 0), path) as JsonObject;
}
