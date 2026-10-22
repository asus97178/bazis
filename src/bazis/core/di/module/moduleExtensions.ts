import { markConfigurationError } from "../errors/configurationError";
import type { BazisModuleMetadata, BazisModuleRef } from "./types";

/**
 * Turns extra `@Module` metadata keys into imported modules.
 *
 * The DI core is the foundation layer and must not know about higher modules
 * (ORM, HTTP, …). To keep ergonomic, declarative keys like `ormBazis` without
 * inverting that dependency, higher layers register an expander here (via a
 * side-effect import, like the repository encapsulation hook). At build time
 * `createContainer` runs every expander over each module's metadata and loads
 * the returned modules as if they were listed in `imports`.
 */
export type ModuleMetadataExpander = (metadata: BazisModuleMetadata) => readonly BazisModuleRef[];

const expanders: ModuleMetadataExpander[] = [];

/** Registers a metadata expander (idempotent per function reference). */
export function registerModuleMetadataExpander(expander: ModuleMetadataExpander): void {
  if (!expanders.includes(expander)) {
    expanders.push(expander);
  }
}

const declarationErrors = new WeakMap<object, unknown>();

/**
 * Keeps a problem found while a module was declared (a bad `@Infra` manifest,
 * …) instead of throwing it at import time. The application reports it as a
 * configuration error when it builds this module.
 */
export function deferModuleDeclarationError(moduleRef: object, error: unknown): void {
  if (!declarationErrors.has(moduleRef)) {
    declarationErrors.set(moduleRef, markConfigurationError(error));
  }
}

/** Collects extra module refs contributed by registered expanders for a module. */
export function expandModuleMetadata(metadata: BazisModuleMetadata): readonly BazisModuleRef[] {
  if (declarationErrors.has(metadata)) {
    throw declarationErrors.get(metadata);
  }
  if (expanders.length === 0) {
    return [];
  }
  const extra: BazisModuleRef[] = [];
  for (let index = 0; index < expanders.length; index += 1) {
    const expander = expanders[index] as ModuleMetadataExpander;
    try {
      extra.push(...expander(metadata));
    } catch (error) {
      // A bad declarative key (`ormBazis` options, …) is a configuration
      // problem of the module, not an application crash.
      throw markConfigurationError(error);
    }
  }
  return extra;
}
