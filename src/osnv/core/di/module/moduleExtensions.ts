import type { OsnvModuleMetadata, OsnvModuleRef } from "./types";

/**
 * Turns extra `@Module` metadata keys into imported modules.
 *
 * The DI core is the foundation layer and must not know about higher modules
 * (ORM, HTTP, …). To keep ergonomic, declarative keys like `ormOsnv` without
 * inverting that dependency, higher layers register an expander here (via a
 * side-effect import, like the repository encapsulation hook). At build time
 * `createContainer` runs every expander over each module's metadata and loads
 * the returned modules as if they were listed in `imports`.
 */
export type ModuleMetadataExpander = (metadata: OsnvModuleMetadata) => readonly OsnvModuleRef[];

const expanders: ModuleMetadataExpander[] = [];

/** Registers a metadata expander (idempotent per function reference). */
export function registerModuleMetadataExpander(expander: ModuleMetadataExpander): void {
  if (!expanders.includes(expander)) {
    expanders.push(expander);
  }
}

/** Collects extra module refs contributed by registered expanders for a module. */
export function expandModuleMetadata(metadata: OsnvModuleMetadata): readonly OsnvModuleRef[] {
  if (expanders.length === 0) {
    return [];
  }
  const extra: OsnvModuleRef[] = [];
  for (let index = 0; index < expanders.length; index += 1) {
    const expander = expanders[index] as ModuleMetadataExpander;
    extra.push(...expander(metadata));
  }
  return extra;
}
