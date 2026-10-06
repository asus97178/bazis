import type { Class } from "../token";
import type { BazisModuleRef } from "./types";

/**
 * Collects controller classes from the module tree (the module itself plus `imports`,
 * recursively). Duplicates by class reference are dropped.
 */
export function collectModuleControllers(
  roots: readonly BazisModuleRef[],
  extraControllers?: readonly Class<object>[],
): Class<object>[] {
  const seen = new Set<Class<object>>();
  const result: Class<object>[] = [];

  const visit = (moduleRef: BazisModuleRef, loaded: Set<BazisModuleRef>): void => {
    if (loaded.has(moduleRef)) {
      return;
    }
    loaded.add(moduleRef);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        visit(imports[index] as BazisModuleRef, loaded);
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
    visit(roots[index] as BazisModuleRef, new Set());
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
