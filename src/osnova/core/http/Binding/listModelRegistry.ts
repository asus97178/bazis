/**
 * Реестр «имя класса -> класс» для list-запросов (наследников `ListRequest`).
 *
 * Аналогичен {@link requestModelRegistry}: сгенерированные конвенции привязок
 * ссылаются на класс по имени (генерируемый файл — чистые данные), а сам класс
 * разрешается из этого реестра при старте сервера. Регистрация приходит из
 * app-owned generated runtime (`src/generated/osnova/httpListModels.ts`).
 */

/** Маркер: под одним именем зарегистрировано несколько разных классов. */
export const AMBIGUOUS_LIST_MODEL: unique symbol = Symbol("ambiguous-list-model");

export type ListModelClass = new () => object;

let registry = new Map<string, ListModelClass | typeof AMBIGUOUS_LIST_MODEL>();

/** Регистрирует класс list-запроса (вызывается из generated runtime). */
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
 * Класс по имени: `undefined` — не зарегистрирован, `AMBIGUOUS_LIST_MODEL` —
 * имя неоднозначно (два разных класса).
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
