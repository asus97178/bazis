import { expandModuleMetadata } from "./moduleExtensions";
import type { OsnovaModuleRef } from "./types";

function appendProfiles(value: readonly unknown[] | undefined, out: unknown[], seen: Set<unknown>): void {
  if (value === undefined) {
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const profile = value[index];
    if (!seen.has(profile)) {
      seen.add(profile);
      out.push(profile);
    }
  }
}

/**
 * Collects opaque `uiProfiles` declarations from a module tree. The DI core
 * intentionally does not interpret `@UiProfile`; the application composition
 * layer resolves the references against HTTP/OpenAPI metadata.
 */
export function collectModuleUiProfiles(roots: readonly OsnovaModuleRef[]): readonly unknown[] {
  const loaded = new Set<OsnovaModuleRef>();
  const seen = new Set<unknown>();
  const profiles: unknown[] = [];

  const visit = (moduleRef: OsnovaModuleRef): void => {
    if (loaded.has(moduleRef)) {
      return;
    }
    loaded.add(moduleRef);

    appendProfiles(moduleRef.uiProfiles, profiles, seen);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        visit(imports[index] as OsnovaModuleRef);
      }
    }

    const expanded = expandModuleMetadata(moduleRef);
    for (let index = 0; index < expanded.length; index += 1) {
      visit(expanded[index] as OsnovaModuleRef);
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index] as OsnovaModuleRef);
  }

  return Object.freeze(profiles);
}
