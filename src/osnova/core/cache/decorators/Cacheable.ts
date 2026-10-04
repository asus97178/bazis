import type { CacheableOptions } from "../types/CachePolicy";
import { ownCacheableMeta, ownCacheableMethodMeta } from "./cacheableMetadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Caches the return value of a service/provider method in {@link ICache}.
 *
 * Mirrors Spring / FusionCache `@Cacheable`. Put the decorator on the
 * **implementation class**, then register via {@link cachedSingleton} or
 * {@link cachedScoped} so DI returns a caching proxy for the interface token.
 *
 * ```ts
 * class UserService implements IUserStore {
 *   @Cacheable({ seconds: 300, key: (id) => `user:${id}` })
 *   async byId(id: number) { ... }
 * }
 *
 * cachedScoped(IUserStore, UserService, [repositoryFor(User)])
 * ```
 */
export function Cacheable(options: CacheableOptions): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownCacheableMeta(context.metadata).cacheable = options;
    } else {
      const methodMeta = ownCacheableMethodMeta(context.metadata, context.name);
      Object.assign(methodMeta, options);
    }
  };
}

export type { CacheableOptions } from "../types/CachePolicy";
