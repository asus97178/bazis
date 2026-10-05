import { createHash } from "node:crypto";
import {
  cacheableMetaOf,
  resolveCacheableRequirement,
  type CacheableClassMeta,
} from "../decorators/cacheableMetadata";
import {
  cacheableRedisMetaOf,
  resolveCacheableRedisRequirement,
  type CacheableRedisClassMeta,
} from "../decorators/cacheableRedisMetadata";
import type { IDistributedCache } from "../distributed/IDistributedCache";
import type { NamedCacheRegistry } from "../distributed/NamedCacheRegistry";
import { CacheError } from "../errors/CacheError";
import type { ICache } from "../ICache";
import { normalizeCacheKey } from "../internal/normalizeCacheKey";
import { AutomaticCacheKey } from "../internal/AutomaticCacheKey";
import { resolveCacheableRedisOptions } from "../internal/resolveCacheableRedisPolicy";
import {
  requireCacheSeconds,
  resolveCacheOptions,
  type ResolvedCacheableOptions,
} from "../internal/resolveCachePolicy";
import type { CacheSetOptions } from "../types/CacheOptions";
import type { ResolvedCacheableRedisOptions } from "../types/CacheableRedisOptions";
import type { CachePolicyRegistry } from "../types/CachePolicy";

type AnyMethod = (...args: unknown[]) => unknown;

/** Wiring for a caching service proxy. */
export interface CacheProxyOptions {
  /** In-memory store for `@Cacheable` methods. */
  readonly memoryCache: ICache;
  /** Distributed stores for `@CacheableRedis` methods; absent when no backend configured. */
  readonly serviceCache?: NamedCacheRegistry<IDistributedCache>;
  readonly policies: CachePolicyRegistry;
  readonly className?: string;
  /** Per-instance namespace; DI supplies it for both singleton and scoped providers. */
  readonly cacheNamespace?: string;
}

/** Decorator metadata for a class, read from `Symbol.metadata` once per class. */
interface ClassCachePlan {
  readonly memoryMeta: CacheableClassMeta | undefined;
  readonly distributedMeta: CacheableRedisClassMeta | undefined;
  readonly hasAny: boolean;
}

const classPlans = new WeakMap<Function, ClassCachePlan>();

function planFor(ctor: Function): ClassCachePlan {
  let plan = classPlans.get(ctor);
  if (plan === undefined) {
    const memoryMeta = cacheableMetaOf(ctor);
    const distributedMeta = cacheableRedisMetaOf(ctor);
    plan = {
      memoryMeta,
      distributedMeta,
      hasAny: memoryMeta !== undefined || distributedMeta !== undefined,
    };
    classPlans.set(ctor, plan);
  }
  return plan;
}

function buildMethodCacheKey(
  className: string,
  methodName: string | symbol,
  args: readonly unknown[],
  automaticKey: AutomaticCacheKey,
  options: ResolvedCacheableOptions | ResolvedCacheableRedisOptions,
  cacheNamespace?: string,
): string | undefined {
  let userKey: string | undefined;
  if (typeof options.key === "function") {
    userKey = options.key(...args);
  } else if (typeof options.key === "string") {
    userKey = options.key;
  } else {
    userKey = automaticKey.build(args);
    if (userKey === undefined) return undefined;
  }
  // An explicit key is an application-owned sharing contract and preserves the
  // documented cross-scope/process cache behavior. Implicit keys are isolated
  // per DI instance: constructor dependencies can carry state absent from args.
  const namespace = options.key === undefined ? (cacheNamespace ?? "shared") : "explicit-shared";
  const canonical = JSON.stringify([namespace, className, String(methodName), userKey]);
  return `svc:${createHash("sha256").update(canonical).digest("hex")}`;
}

function wrapMemoryMethod(
  target: object,
  methodName: string | symbol,
  original: AnyMethod,
  automaticKey: AutomaticCacheKey,
  cache: ICache,
  className: string,
  options: ResolvedCacheableOptions,
  cacheNamespace?: string,
): AnyMethod {
  return (...args) => {
    if (options.unless !== undefined && options.unless(...args)) {
      return original.apply(target, args);
    }
    const methodKey = buildMethodCacheKey(className, methodName, args, automaticKey, options, cacheNamespace);
    if (methodKey === undefined) return original.apply(target, args);
    const key = normalizeCacheKey(methodKey);
    const setOptions: CacheSetOptions = { ttlSeconds: options.seconds, tags: options.tags };
    return cache.getOrCreate(key, () => original.apply(target, args), setOptions);
  };
}

function wrapDistributedMethod(
  target: object,
  methodName: string | symbol,
  original: AnyMethod,
  automaticKey: AutomaticCacheKey,
  registry: NamedCacheRegistry<IDistributedCache> | undefined,
  className: string,
  options: ResolvedCacheableRedisOptions,
  cacheNamespace?: string,
): AnyMethod {
  return (...args) => {
    if (options.unless !== undefined && options.unless(...args)) {
      return original.apply(target, args);
    }
    const methodKey = buildMethodCacheKey(className, methodName, args, automaticKey, options, cacheNamespace);
    if (methodKey === undefined) return original.apply(target, args);
    const key = normalizeCacheKey(methodKey);
    if (registry === undefined) {
      throw new CacheError(
        `${className}.${String(methodName)} uses @CacheableRedis but no distributed cache backend is configured — `
          + 'add redisConnect(redisConfig, { cache: "distributed" }) to your @Infra manifest',
      );
    }
    const cache = registry.resolve(options.connection);
    return cache.getOrCreateAsync(
      key,
      async () => {
        const result = original.apply(target, args);
        return result instanceof Promise ? await result : result;
      },
      { ttlSeconds: options.seconds, tags: options.tags, lockSeconds: options.lockSeconds },
    );
  };
}

function buildMethod(
  target: object,
  prop: string | symbol,
  original: AnyMethod,
  automaticKey: AutomaticCacheKey,
  plan: ClassCachePlan,
  options: CacheProxyOptions,
  className: string,
): AnyMethod {
  const distributedReq = resolveCacheableRedisRequirement(plan.distributedMeta, prop);
  const memoryReq = resolveCacheableRequirement(plan.memoryMeta, prop);

  if (distributedReq !== undefined && memoryReq !== undefined) {
    throw new CacheError(
      `${className}.${String(prop)} has both @Cacheable and @CacheableRedis — use one decorator per method`,
    );
  }

  if (distributedReq !== undefined) {
    const resolved = resolveCacheableRedisOptions(distributedReq, options.policies);
    if (resolved.enabled === false || resolved.noStore === true) {
      return original.bind(target);
    }
    const seconds = requireCacheSeconds(resolved, `@CacheableRedis on ${className}.${String(prop)}`);
    return wrapDistributedMethod(
      target,
      prop,
      original,
      automaticKey,
      options.serviceCache,
      className,
      { ...resolved, seconds },
      options.cacheNamespace,
    );
  }

  if (memoryReq !== undefined) {
    const resolved = resolveCacheOptions(memoryReq, options.policies);
    if (resolved.enabled === false || resolved.noStore === true) {
      return original.bind(target);
    }
    const seconds = requireCacheSeconds(resolved, `@Cacheable on ${className}.${String(prop)}`);
    return wrapMemoryMethod(
      target,
      prop,
      original,
      automaticKey,
      options.memoryCache,
      className,
      { ...resolved, seconds },
      options.cacheNamespace,
    );
  }

  return original.bind(target);
}

/**
 * Wraps a service instance so `@Cacheable` methods use {@link ICache} and
 * `@CacheableRedis` methods use the distributed {@link NamedCacheRegistry}.
 * Returns the instance unchanged when it carries no cache metadata.
 */
export function wrapCachedService<T extends object>(target: T, options: CacheProxyOptions): T {
  const ctor = target.constructor;
  const plan = planFor(ctor);
  if (!plan.hasAny) {
    return target;
  }
  const className = options.className ?? ctor.name;
  const methodCache = new Map<string | symbol, AnyMethod>();
  const automaticKey = new AutomaticCacheKey();

  const handler: ProxyHandler<T> = {
    get(obj, prop) {
      if (prop === "constructor") {
        return Reflect.get(obj, prop, obj);
      }
      const value = Reflect.get(obj, prop, obj);
      if (typeof value !== "function" || (typeof prop !== "string" && typeof prop !== "symbol")) {
        return value;
      }
      const memoized = methodCache.get(prop);
      if (memoized !== undefined) {
        return memoized;
      }
      const wrapped = buildMethod(obj, prop, value as AnyMethod, automaticKey, plan, options, className);
      methodCache.set(prop, wrapped);
      return wrapped;
    },
    set(obj, prop, value) {
      return Reflect.set(obj, prop, value, obj);
    },
  };

  return new Proxy(target, handler);
}
