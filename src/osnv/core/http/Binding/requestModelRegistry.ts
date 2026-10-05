/**
 * "Class name -> class" registry for request models (`@RequestModel()`).
 *
 * Generated binding conventions refer to the request body class by name (the
 * generated file is plain data without imports of user modules). The generated
 * target resolves its own DTOs; this registry is the fallback for classes it
 * does not know, such as external DTOs marked with `@RequestModel()`.
 */

/** Marker: several different classes are registered under one name. */
export const AMBIGUOUS_REQUEST_MODEL: unique symbol = Symbol("ambiguous-request-model");

export type RequestModelClass = new () => object;

/**
 * Runtime hydration metadata emitted by `bun run di:generate` for a class-
 * typed request-model field. Standard TC39 decorators deliberately do not
 * expose design types, so this tiny registry is the dependency-free bridge
 * from TypeScript source types to the HTTP binder.
 */
interface RequestModelFieldShapeBase {
  readonly array?: boolean;
  /** `null` is part of the declared property type. */
  readonly nullable?: boolean;
  /** `null` is part of an array element type. */
  readonly elementNullable?: boolean;
}

/** A field typed as a request-model class (or an array of them). */
export interface RequestModelNestedFieldShape extends RequestModelFieldShapeBase {
  readonly model: RequestModelClass;
}

/** A field declared exactly as `string`, `number` or `boolean` (or an array of one). */
export interface RequestModelPrimitiveFieldShape extends RequestModelFieldShapeBase {
  readonly primitive: RequestModelPrimitive;
}

export type RequestModelPrimitive = "string" | "number" | "boolean";
export type RequestModelFieldShape = RequestModelNestedFieldShape | RequestModelPrimitiveFieldShape;
const PRIMITIVES: ReadonlySet<unknown> = new Set<RequestModelPrimitive>(["string", "number", "boolean"]);

export type RequestModelShape = Readonly<Record<string, RequestModelFieldShape>>;

let registry = new Map<string, RequestModelClass | typeof AMBIGUOUS_REQUEST_MODEL>();
// Runtime model constructors are process-owned; Map permits exact generated
// target rollback without changing the public lookup contract.
let shapes = new Map<RequestModelClass, RequestModelShape>();
const FORBIDDEN_SHAPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Registers a request-model class (called by the `@RequestModel()` decorator). */
export function registerRequestModelClass(ctor: RequestModelClass): void {
  const name = ctor.name;
  if (!name) {
    return; // an anonymous class cannot be addressed by name
  }
  const existing = registry.get(name);
  if (existing === undefined) {
    registry.set(name, ctor);
  } else if (existing !== ctor) {
    registry.set(name, AMBIGUOUS_REQUEST_MODEL);
  }
}

/**
 * Class by name: `undefined` if not registered (no `@RequestModel()`),
 * `AMBIGUOUS_REQUEST_MODEL` if the name is ambiguous (two different classes).
 */
export function findRequestModelByName(
  name: string,
): RequestModelClass | typeof AMBIGUOUS_REQUEST_MODEL | undefined {
  return registry.get(name);
}

/** Registers generated hydration metadata (nested models, primitive types) for one DTO class. */
export function registerRequestModelShape(ctor: RequestModelClass, shape: RequestModelShape): void {
  const snapshot: Record<string, RequestModelFieldShape> = Object.create(null) as Record<string, RequestModelFieldShape>;
  for (const key of Object.keys(shape)) {
    if (
      FORBIDDEN_SHAPE_KEYS.has(key) ||
      !Object.prototype.hasOwnProperty.call(shape, key)
    ) {
      continue;
    }
    const field = shape[key] as Partial<RequestModelNestedFieldShape & RequestModelPrimitiveFieldShape> | undefined;
    const nested = typeof field?.model === "function";
    const primitive = PRIMITIVES.has(field?.primitive);
    if (field === undefined || nested === primitive) {
      throw new TypeError(`Invalid request-model shape for ${ctor.name}.${key}`);
    }
    const flags = {
      array: field.array === true || undefined,
      nullable: field.nullable === true || undefined,
      elementNullable: field.elementNullable === true || undefined,
    };
    snapshot[key] = Object.freeze(nested
      ? { model: field.model as RequestModelClass, ...flags }
      : { primitive: field.primitive as RequestModelPrimitive, ...flags });
  }
  shapes.set(ctor, Object.freeze(snapshot));
}

/** Generated hydration shape for a DTO constructor, if one was registered. */
export function findRequestModelShape(ctor: RequestModelClass): RequestModelShape | undefined {
  return shapes.get(ctor);
}

/** Internal generated-runtime transaction support. */
export function snapshotRequestModelRegistry(): { readonly registry: typeof registry; readonly shapes: typeof shapes } {
  return { registry: new Map(registry), shapes: new Map(shapes) };
}

/** Internal generated-runtime transaction support. */
export function restoreRequestModelRegistry(snapshot: ReturnType<typeof snapshotRequestModelRegistry>): void {
  registry = snapshot.registry;
  shapes = snapshot.shapes;
}
