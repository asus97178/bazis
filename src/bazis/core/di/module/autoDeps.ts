import { lazyDependency, namedDependency, optionalDependency, type ProviderDependencyList } from "../provider";
import type { Class } from "../token";

const LAZY_PREFIX = "lazy:";
const OPTIONAL_PREFIX = "optional:";
// These registrations live for the process lifetime just like their
// constructors. A Map, rather than a WeakMap, lets the generated-runtime
// owner take an exact rollback snapshot before publishing a target slice.
export type GeneratedClassDependency = string | ProviderDependencyList[number];
let targetClassDeps = new Map<Class<unknown>, readonly GeneratedClassDependency[]>();

/** Project-owned target runtimes bind inferred dependencies by constructor identity. */
export function registerGeneratedClassDeps(target: Class<unknown>, deps: readonly GeneratedClassDependency[]): void {
  targetClassDeps.set(target, deps);
}

// The framework's own classes: their wiring ships inside the package
// (`<pack>/generated/deps.ts`), because an application's codegen skips
// node_modules. Not part of a target, so target rollbacks keep it.
const frameworkClassDeps = new Map<Class<unknown>, readonly GeneratedClassDependency[]>();

/** Called by the generated `deps.ts` of a framework pack when the pack is imported. */
export function registerFrameworkClassDeps(entries: readonly (readonly [Class<unknown>, readonly GeneratedClassDependency[]])[]): void {
  for (const [target, deps] of entries) frameworkClassDeps.set(target, deps);
}

export function getGeneratedClassDeps(useClass: Class<unknown>): ProviderDependencyList | undefined {
  // Names are not class identities: package consumers may use the same names
  // as the application that generated the framework's compatibility files.
  const dependencies = targetClassDeps.get(useClass) ?? frameworkClassDeps.get(useClass);
  if (dependencies === undefined) {
    return undefined;
  }
  return dependencies.map((dependency) =>
    typeof dependency !== "string" ? dependency
      : dependency.startsWith(LAZY_PREFIX)
        ? lazyDependency(namedDependency(dependency.slice(LAZY_PREFIX.length)))
        : dependency.startsWith(OPTIONAL_PREFIX)
          ? optionalDependency(namedDependency(dependency.slice(OPTIONAL_PREFIX.length)))
          : namedDependency(dependency),
  );
}

/** Internal generated-runtime transaction support. */
export function snapshotGeneratedClassDeps(): typeof targetClassDeps {
  return new Map(targetClassDeps);
}

/** Internal generated-runtime transaction support. */
export function restoreGeneratedClassDeps(snapshot: ReturnType<typeof snapshotGeneratedClassDeps>): void {
  targetClassDeps = snapshot;
}
