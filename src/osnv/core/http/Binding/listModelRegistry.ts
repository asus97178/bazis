/**
 * "Class name -> class" registry for list requests (`ListRequest` subclasses).
 *
 * Like {@link requestModelRegistry}: generated binding conventions refer to
 * the class by name (the generated file is plain data), and the class itself
 * is resolved from this registry when the server starts. Registration comes
 * from the app-owned generated runtime (`src/generated/osnv/httpListModels.ts`).
 */

/** Marker: several different classes are registered under one name. */
export const AMBIGUOUS_LIST_MODEL: unique symbol = Symbol("ambiguous-list-model");

export type ListModelClass = new () => object;

let registry = new Map<string, ListModelClass | typeof AMBIGUOUS_LIST_MODEL>();

/** Registers a list-request class (called from the generated runtime). */
export function registerListModelClass(ctor: ListModelClass): void {
  const name = ctor.name;
  if (!name) {
    return;
  }
  const existing = registry.get(name);
  if (existing === undefined) {
    registry.set(name, ctor);
  } else if (existing !== ctor) {
    registry.set(name, AMBIGUOUS_LIST_MODEL);
  }
}

/**
 * Class by name: `undefined` if not registered, `AMBIGUOUS_LIST_MODEL` if the
 * name is ambiguous (two different classes).
 */
export function findListModelByName(name: string): ListModelClass | typeof AMBIGUOUS_LIST_MODEL | undefined {
  return registry.get(name);
}

/** Internal generated-runtime transaction support. */
export function snapshotListModelRegistry(): typeof registry {
  return new Map(registry);
}

/** Internal generated-runtime transaction support. */
export function restoreListModelRegistry(snapshot: ReturnType<typeof snapshotListModelRegistry>): void {
  registry = snapshot;
}
