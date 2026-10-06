import type { Class } from "../../di";
import { BadRequestError, ModelValidationError } from "../Errors/HttpError";
import { getModelValidator, type ModelValidator } from "./modelValidator";
import {
  findRequestModelShape,
  type RequestModelClass,
  type RequestModelFieldShape,
  type RequestModelNestedFieldShape,
  type RequestModelPrimitiveFieldShape,
} from "./requestModelRegistry";

/** Keys that must never be copied from external input (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

interface BindingTraversal {
  readonly stack: WeakSet<object>;
  readonly options: ModelBindingOptions;
  nodes: number;
}

/** Internal binding policy; HTTP keeps its historical stripping defaults. */
export interface ModelBindingOptions {
  readonly unknownFields?: "strip" | "reject";
  readonly declaredFields?: (model: RequestModelClass) => readonly string[] | undefined;
  /** Protobuf bytes only; HTTP/Agent keep their strict JSON boundary. */
  readonly allowBinary?: boolean;
  /**
   * Reject a JSON value whose type differs from a field declared exactly as
   * `string`, `number` or `boolean` (from generated shapes). HTTP enables it;
   * gRPC (int64 as string/bigint) and agents keep their own conversions.
   */
  readonly primitiveTypes?: boolean;
}

/**
 * Binds a parsed JSON body to a model class instance:
 *
 * 1. requires a plain JSON object (not array/primitive) — otherwise 400;
 * 2. copies only fields declared by the class (plus explicit setters),
 *    stripping unknown and prototype-polluting names;
 * 3. runs `@Validator` rules of the model — failures become a 400 with the
 *    full list of validation errors (`ModelValidationError`).
 *
 * The model class must have a parameterless constructor. Class-typed nested
 * DTOs (including arrays) are recursively hydrated from metadata emitted by
 * `bun run di:generate`; initialized nested DTO fields remain supported as a
 * runtime fallback.
 */
export function bindModel<T extends object>(model: Class<T>, data: unknown, validator?: ModelValidator, options: ModelBindingOptions = {}): T {
  if (!isPlainJsonObject(data)) {
    throw new BadRequestError("Request body must be a JSON object");
  }
  const traversal: BindingTraversal = { stack: new WeakSet(), nodes: 0, options };
  const instance = hydrateModel(model as RequestModelClass, data, "", traversal, 0) as T;
  const activeValidator = validator ?? getModelValidator();
  if (activeValidator !== undefined) {
    const result = activeValidator.validate(instance);
    if (!result.isValid) {
      throw new ModelValidationError(result.errors);
    }
  }
  return instance;
}

function hydrateModel(
  model: RequestModelClass,
  source: Record<string, unknown>,
  path: string,
  traversal: BindingTraversal,
  depth: number,
): object {
  enterContainer(source, path, traversal, depth);
  const instance = new model();
  // Class fields are emitted as own properties by Bun/TypeScript. Treat that
  // runtime shape, generated nested fields and explicit prototype setters as
  // the input whitelist so over-posted fields never reach application code.
  try {
    const allowed = bindableKeys(instance, model.prototype, model, traversal.options);
    for (const key of Object.keys(source)) {
      if (!acceptKey(source, key, allowed, path, traversal.options)) {
        continue;
      }
      const target = instance as Record<string, unknown>;
      const fieldPath = path === "" ? key : `${path}.${key}`;
      target[key] = bindField(model, key, target[key], source[key], fieldPath, traversal, depth + 1);
    }
    return instance;
  } finally {
    traversal.stack.delete(source);
  }
}

function bindField(
  model: RequestModelClass,
  key: string,
  template: unknown,
  incoming: unknown,
  path: string,
  traversal: BindingTraversal,
  depth: number,
): unknown {
  const shape = findFieldShape(model, key);
  if (shape !== undefined && "model" in shape) {
    return hydrateField(shape, incoming, path, traversal, depth);
  }
  if (shape !== undefined && traversal.options.primitiveTypes === true) {
    checkPrimitive(shape, incoming, path);
  }
  return sanitizeBoundValue(template, incoming, path, traversal, depth);
}

/** `undefined` means "absent"; required-ness stays with `@Validator`. */
function checkPrimitive(shape: RequestModelPrimitiveFieldShape, incoming: unknown, path: string): void {
  if (incoming === undefined || (incoming === null && shape.nullable === true)) {
    return;
  }
  if (shape.array !== true) {
    if (typeof incoming !== shape.primitive) throw bindingTypeError(path, shape.primitive);
    return;
  }
  if (!Array.isArray(incoming)) throw bindingTypeError(path, "array");
  incoming.forEach((item, index) => {
    if (!(item === null && shape.elementNullable === true) && typeof item !== shape.primitive) {
      throw bindingTypeError(`${path}[${index}]`, shape.primitive);
    }
  });
}

function hydrateField(
  shape: RequestModelNestedFieldShape,
  incoming: unknown,
  path: string,
  traversal: BindingTraversal,
  depth: number,
): unknown {
  if (incoming === undefined) {
    return undefined;
  }
  if (incoming === null) {
    if (shape.nullable === true) {
      return null;
    }
    throw bindingTypeError(path, shape.array === true ? "array" : "object");
  }
  if (shape.array === true) {
    if (!Array.isArray(incoming)) {
      throw bindingTypeError(path, "array");
    }
    enterContainer(incoming, path, traversal, depth);
    try {
      return incoming.map((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (item === null && shape.elementNullable === true) {
          return null;
        }
        if (!isPlainJsonObject(item)) {
          throw bindingTypeError(itemPath, "object");
        }
        return hydrateModel(shape.model, item, itemPath, traversal, depth + 1);
      });
    } finally {
      traversal.stack.delete(incoming);
    }
  }
  if (!isPlainJsonObject(incoming)) {
    throw bindingTypeError(path, "object");
  }
  return hydrateModel(shape.model, incoming, path, traversal, depth);
}

function bindingTypeError(property: string, expected: string): ModelValidationError {
  return new ModelValidationError([{
    property: property || "$",
    message: `Field "${property || "$"}" must be a ${expected}`,
    code: "type",
  }]);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function findFieldShape(model: RequestModelClass, property: string): RequestModelFieldShape | undefined {
  let current: unknown = model;
  while (typeof current === "function" && current !== Function.prototype) {
    const shape = findRequestModelShape(current as RequestModelClass);
    if (shape !== undefined && Object.prototype.hasOwnProperty.call(shape, property)) {
      return shape[property];
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function sanitizeBoundValue(
  template: unknown,
  incoming: unknown,
  path: string,
  traversal: BindingTraversal,
  depth: number,
): unknown {
  if (incoming === null || typeof incoming !== "object") {
    return incoming;
  }

  if (traversal.options.allowBinary === true && incoming instanceof Uint8Array) {
    return Buffer.isBuffer(incoming) ? Buffer.from(incoming) : new Uint8Array(incoming);
  }

  if (Array.isArray(incoming)) {
    if (isNestedModel(template) || isPlainJsonObject(template)) {
      throw bindingTypeError(path, "object");
    }
    enterContainer(incoming, path, traversal, depth);
    try {
      return incoming.map((item, index) =>
        sanitizeBoundValue(undefined, item, `${path}[${index}]`, traversal, depth + 1)
      );
    } finally {
      traversal.stack.delete(incoming);
    }
  }

  if (!isPlainJsonObject(incoming)) {
    throw bindingTypeError(path, "JSON object or array");
  }
  if (Array.isArray(template)) {
    throw bindingTypeError(path, "array");
  }

  enterContainer(incoming, path, traversal, depth);
  try {
    if (isNestedModel(template)) {
      const target = template as Record<string, unknown>;
      const targetModel = target.constructor as RequestModelClass;
      const allowed = bindableKeys(target, Object.getPrototypeOf(target) as object, targetModel, traversal.options);
      for (const key of Object.keys(incoming)) {
        if (!acceptKey(incoming, key, allowed, path, traversal.options)) {
          continue;
        }
        const childPath = `${path}.${key}`;
        target[key] = bindField(targetModel, key, target[key], incoming[key], childPath, traversal, depth + 1);
      }
      return target;
    }

    // Open JSON bags (`Record<string, unknown>`, `{}`, `unknown[]`) retain
    // ordinary data keys, but are cloned recursively so forbidden keys and
    // hostile prototypes cannot cross the HTTP boundary at any depth.
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(incoming)) {
      if (!acceptKey(incoming, key, undefined, path, traversal.options)) {
        continue;
      }
      output[key] = sanitizeBoundValue(undefined, incoming[key], `${path}.${key}`, traversal, depth + 1);
    }
    return output;
  } finally {
    traversal.stack.delete(incoming);
  }
}

function enterContainer(
  value: object,
  path: string,
  traversal: BindingTraversal,
  depth: number,
): void {
  const property = path || "$";
  if (depth > MAX_JSON_DEPTH) {
    throw new BadRequestError("Request body is too deeply nested", {
      property,
      maxDepth: MAX_JSON_DEPTH,
    });
  }
  const childCount = Array.isArray(value) ? value.length : Object.keys(value).length;
  traversal.nodes += 1 + childCount;
  if (traversal.nodes > MAX_JSON_NODES) {
    throw new BadRequestError("Request body is too complex", {
      property,
      maxNodes: MAX_JSON_NODES,
    });
  }
  if (traversal.stack.has(value)) {
    throw new BadRequestError("Request body must be acyclic JSON", { property });
  }
  traversal.stack.add(value);
}

function isNestedModel(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype !== null && prototype !== Object.prototype &&
    !(value instanceof Date) && !(value instanceof Map) && !(value instanceof Set) && !(value instanceof URL);
}

function acceptKey(source: object, key: string, allowed: ReadonlySet<string> | undefined, path: string, options: ModelBindingOptions): boolean {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
  if (!FORBIDDEN_KEYS.has(key) && (allowed === undefined || allowed.has(key))) return true;
  if (options.unknownFields === "reject") {
    const property = path === "" ? key : `${path}.${key}`;
    throw new ModelValidationError([{ property, message: `Field "${property}" is forbidden or not declared by the model.`, code: "unknownField" }]);
  }
  return false;
}

function bindableKeys(instance: object, prototype: object, model: RequestModelClass, options: ModelBindingOptions): Set<string> {
  const declared = options.declaredFields?.(model);
  if (declared !== undefined) return new Set(declared);
  const keys = new Set(Object.keys(instance));
  let shapeModel: unknown = model;
  while (typeof shapeModel === "function" && shapeModel !== Function.prototype) {
    const shape = findRequestModelShape(shapeModel as RequestModelClass);
    if (shape !== undefined) {
      for (const key of Object.keys(shape)) {
        if (!FORBIDDEN_KEYS.has(key)) {
          keys.add(key);
        }
      }
    }
    shapeModel = Object.getPrototypeOf(shapeModel);
  }
  let current: object | null = prototype;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "constructor" || FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor?.set) {
        keys.add(key);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return keys;
}
