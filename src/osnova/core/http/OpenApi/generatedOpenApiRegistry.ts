import type { GeneratedOpenApiMetadata, GeneratedOpenApiOperationMetadata, OpenApiSchema } from "../../../library/openapi";

export type GeneratedOpenApiSchemaModel = abstract new (...args: never[]) => object;

const EMPTY_GENERATED_OPENAPI_METADATA: GeneratedOpenApiMetadata = Object.freeze({
  schemas: Object.freeze({}),
  operations: Object.freeze({}),
});

interface GeneratedOpenApiTargetSlice {
  readonly metadata: GeneratedOpenApiMetadata;
  readonly controllers?: ReadonlySet<abstract new (...args: never[]) => object>;
}

let registered: GeneratedOpenApiTargetSlice[] = [];
let schemaNamesByModel = new Map<GeneratedOpenApiSchemaModel, string>();

export function registerGeneratedOpenApiMetadata(
  metadata: GeneratedOpenApiMetadata,
  controllers?: readonly (abstract new (...args: never[]) => object)[],
): void {
  if (metadata === EMPTY_GENERATED_OPENAPI_METADATA || registered.some((entry) => entry.metadata === metadata)) {
    return;
  }
  registered.push({ metadata, ...(controllers === undefined ? {} : { controllers: new Set(controllers) }) });
}

/**
 * Binds a real runtime model constructor to the exact generated component
 * schema. This is the nominal bridge used by code-first consumers such as
 * @UiProfile; they must not rediscover schemas through `ctor.name`.
 */
export function registerGeneratedOpenApiSchemaModel(
  model: GeneratedOpenApiSchemaModel,
  schemaName: string,
): void {
  const normalized = schemaName.trim();
  if (normalized.length === 0) {
    throw new TypeError("Generated OpenAPI schema model name must not be empty.");
  }
  const existing = schemaNamesByModel.get(model);
  if (existing !== undefined && existing !== normalized) {
    throw new TypeError(
      `OpenAPI model ${model.name || "<anonymous>"} is already bound to schema ${existing}; ` +
        `cannot also bind it to ${normalized}.`,
    );
  }
  schemaNamesByModel.set(model, normalized);
}

/** Exact generated component schema name for a runtime model constructor. */
export function getGeneratedOpenApiSchemaName(
  model: GeneratedOpenApiSchemaModel,
): string | undefined {
  return schemaNamesByModel.get(model);
}

export function getGeneratedOpenApiMetadata(controllers?: readonly (abstract new (...args: never[]) => object)[]): GeneratedOpenApiMetadata {
  const requested = controllers === undefined ? undefined : new Set(controllers);
  const selected = requested === undefined
    ? registered
    : registered.filter((entry) => entry.controllers === undefined || [...requested].some((controller) => entry.controllers?.has(controller) === true));
  if (selected.length === 0) {
    return EMPTY_GENERATED_OPENAPI_METADATA;
  }

  const schemas: Record<string, OpenApiSchema> = {};
  const operations: Record<string, Record<string, GeneratedOpenApiOperationMetadata>> = {};
  for (let index = 0; index < selected.length; index += 1) {
    const metadata = selected[index]!.metadata;
    Object.assign(schemas, metadata.schemas);
    for (const [controllerName, methods] of Object.entries(metadata.operations)) {
      operations[controllerName] ??= {};
      Object.assign(operations[controllerName], methods);
    }
  }

  return Object.freeze({
    schemas: Object.freeze(schemas),
    operations: Object.freeze(operations),
  });
}

/** Internal generated-runtime transaction support. */
export function snapshotGeneratedOpenApiRegistry(): { readonly registered: readonly GeneratedOpenApiTargetSlice[]; readonly schemaNamesByModel: typeof schemaNamesByModel } {
  return {
    registered: registered.map((entry) => ({
      metadata: entry.metadata,
      ...(entry.controllers === undefined ? {} : { controllers: new Set(entry.controllers) }),
    })),
    schemaNamesByModel: new Map(schemaNamesByModel),
  };
}

/** Internal generated-runtime transaction support. */
export function restoreGeneratedOpenApiRegistry(snapshot: ReturnType<typeof snapshotGeneratedOpenApiRegistry>): void {
  registered = snapshot.registered.map((entry) => ({
    metadata: entry.metadata,
    ...(entry.controllers === undefined ? {} : { controllers: new Set(entry.controllers) }),
  }));
  schemaNamesByModel = snapshot.schemaNamesByModel;
}
