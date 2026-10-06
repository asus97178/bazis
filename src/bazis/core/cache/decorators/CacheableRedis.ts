import type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
import { ownCacheableRedisMeta, ownCacheableRedisMethodMeta } from "./cacheableRedisMetadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Shared service method cache backed by the distributed tier (multi-instance safe).
 *
 * Requires a distributed backend: add `redisConnect(redisConfig, { cache: "distributed" })`
 * to your `@Infra` manifest. Register the class with the usual `cachedScoped` /
 * `cachedSingleton` (or just `scoped` / `singleton` — the auto-hook wraps it). The distributed
 * tier activates automatically when a backend is configured.
 *
 * ```ts
 * class UserService implements IUserStore {
 *   @CacheableRedis({ seconds: 300, key: (id) => `user:${id}`, tags: ["users"] })
 *   async byId(id: number) { ... }
 * }
 *
 * cachedScoped(IUserStore, UserService, [repositoryFor(User)]);
 * ```
 */
export function CacheableRedis(options: CacheableRedisOptions): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownCacheableRedisMeta(context.metadata).cacheableRedis = options;
    } else {
      const methodMeta = ownCacheableRedisMethodMeta(context.metadata, context.name);
      Object.assign(methodMeta, options);
    }
  };
}

export type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
