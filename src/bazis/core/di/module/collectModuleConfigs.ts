import { expandModuleMetadata } from "./moduleExtensions";
import type { ModuleConfig, BazisModuleRef } from "./types";

function appendConfig(
  config: ModuleConfig | readonly ModuleConfig[] | undefined,
  out: ModuleConfig[],
  seen: Set<ModuleConfig>,
): void {
  if (config === undefined) {
    return;
  }
  const configs = Array.isArray(config) ? config : [config];
  for (let index = 0; index < configs.length; index += 1) {
    const item = configs[index] as ModuleConfig;
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
}

/**
 * Collects module-owned configs from a module tree. Used by `runApp` for
 * fail-fast validation before the DI container is created.
 */
export function collectModuleConfigs(roots: readonly BazisModuleRef[]): readonly ModuleConfig[] {
  const loaded = new Set<BazisModuleRef>();
  const seenConfigs = new Set<ModuleConfig>();
  const configs: ModuleConfig[] = [];

  const visit = (moduleRef: BazisModuleRef): void => {
    if (loaded.has(moduleRef)) {
      return;
    }
    loaded.add(moduleRef);

    appendConfig(moduleRef.config, configs, seenConfigs);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        visit(imports[index] as BazisModuleRef);
      }
    }

    const expanded = expandModuleMetadata(moduleRef);
    for (let index = 0; index < expanded.length; index += 1) {
      visit(expanded[index] as BazisModuleRef);
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index] as BazisModuleRef);
  }

  return configs;
}
