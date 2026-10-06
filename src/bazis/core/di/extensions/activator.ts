import { isKeyedDependency, type KeyedDependency } from "../provider";
import type { Class, Token } from "../token";
import type { ServiceResolver } from "../types";

/** A DI dependency accepted by {@link createInstance}: a plain token or a keyed one. */
export type ActivatorDependency<T = unknown> = Token<T> | KeyedDependency<T>;

/**
 * Reflection-free analog of .NET `ActivatorUtilities.CreateInstance`: resolves
 * the listed DI dependencies from `resolver` and constructs `useClass` with them,
 * followed by the explicit runtime arguments.
 *
 * Convention (DI deps first, runtime args last):
 *
 * ```ts
 * class ReportJob {
 *   constructor(private readonly db: Db, private readonly title: string) {}
 * }
 * const job = createInstance(resolver, ReportJob, [DB], "Q3 revenue");
 * ```
 *
 * The resolver's scope is honored: scoped dependencies come from the active
 * scope, so call it with the scope's resolver inside a request, not the root.
 * Unlike the codegen-based auto deps, the dependency list is explicit, which
 * keeps the design free of runtime reflection while mixing DI and manual args.
 */
export function createInstance<T>(
  resolver: ServiceResolver,
  useClass: Class<T>,
  deps: readonly ActivatorDependency[] = [],
  ...runtimeArgs: unknown[]
): T {
  const resolved = new Array<unknown>(deps.length);
  for (let index = 0; index < deps.length; index += 1) {
    const dep = deps[index] as ActivatorDependency;
    resolved[index] = isKeyedDependency(dep) ? resolver.resolveKeyed(dep.token, dep.key) : resolver.resolve(dep);
  }
  return new useClass(...resolved, ...runtimeArgs);
}
