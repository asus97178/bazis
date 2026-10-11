import type { Class } from "../token";
import type { BazisModuleRef } from "./types";

type ClassListKey = "controllers" | "gateways";

/**
 * Collects the classes of one declarative list (`controllers`, `gateways`) from
 * the module tree (the module itself plus `imports`, recursively). Duplicates by
 * class reference are dropped.
 */
function collectModuleClasses(roots: readonly BazisModuleRef[], key: ClassListKey): Class<object>[] {
  const seen = new Set<Class<object>>();
  const result: Class<object>[] = [];
  const add = (list: readonly Class<object>[] | undefined): void => {
    if (!list) return;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index] as Class<object>;
      if (!seen.has(entry)) {
        seen.add(entry);
        result.push(entry);
      }
    }
  };

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
    add(moduleRef[key]);
  };

  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index] as BazisModuleRef, new Set());
  }
  return result;
}

/** Controller classes (`controllers` of `@Module`) of the module tree. */
export function collectModuleControllers(roots: readonly BazisModuleRef[]): Class<object>[] {
  return collectModuleClasses(roots, "controllers");
}

/** WebSocket gateway classes (`gateways` of `@Module`) of the module tree. */
export function collectModuleGateways(roots: readonly BazisModuleRef[]): Class<object>[] {
  return collectModuleClasses(roots, "gateways");
}
