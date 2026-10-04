import type { Class } from "../token";
import type { OsnovaModule, OsnovaModuleRef } from "./types";

/**
 * Собирает классы контроллеров из дерева модулей (сам модуль + `imports`,
 * рекурсивно). Дубликаты по ссылке на класс отбрасываются.
 */
export function collectModuleControllers(
  roots: readonly OsnovaModuleRef[],
  extraControllers?: readonly Class<object>[],
): Class<object>[] {
  const seen = new Set<Class<object>>();
  const result: Class<object>[] = [];

  const visit = (moduleRef: OsnovaModuleRef, loaded: Set<OsnovaModuleRef>): void => {
    if (loaded.has(moduleRef)) {
      return;
    }
    loaded.add(moduleRef);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        visit(imports[index] as OsnovaModuleRef, loaded);
      }
    }

    const controllers = moduleRef.controllers;
    if (controllers) {
      for (let index = 0; index < controllers.length; index += 1) {
        const controller = controllers[index] as Class<object>;
        if (!seen.has(controller)) {
          seen.add(controller);
          result.push(controller);
        }
      }
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index] as OsnovaModuleRef, new Set());
  }
  if (extraControllers) {
    for (let index = 0; index < extraControllers.length; index += 1) {
      const controller = extraControllers[index] as Class<object>;
      if (!seen.has(controller)) {
        seen.add(controller);
        result.push(controller);
      }
    }
  }
  return result;
}
