import type { Class, InjectionToken } from "../../di";
import type { RouteMiddlewareComposer } from "../../http";
import type { ActionMeta, ControllerMeta } from "../../http/Decorators/metadata";
import type { ICache } from "../ICache";
import {
  outputCacheMetaOf,
  resolveOutputCacheRequirement,
} from "../decorators/outputCacheMetadata";
import {
  outputRedisCacheMetaOf,
  resolveOutputRedisCacheRequirement,
} from "../decorators/outputRedisCacheMetadata";
import {
  requireCacheSeconds,
  resolveCacheOptions,
  type ResolvedOutputCacheOptions,
} from "../internal/resolveCachePolicy";
import { resolveOutputRedisCacheOptions } from "../internal/resolveOutputRedisCachePolicy";
import type { CachePolicyRegistry } from "../types/CachePolicy";
import type { ResolvedOutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
import type { CachedHttpPayload } from "./CachedHttpPayload";
import { outputCacheMiddleware } from "./outputCacheMiddleware";
import { outputRedisCacheMiddleware } from "./outputRedisCacheMiddleware";
import {
  guardInsecureOutputCacheRoute,
  type OutputCacheSecurityWarningOptions,
} from "./outputCacheSecurityWarning";

/** Composes per-route output cache middleware from `@OutputCache` / `@OutputRedisCache`. */
export type RouteOutputCacheComposer = RouteMiddlewareComposer;

export interface CreateRouteOutputCacheComposerOptions {
  readonly policies: CachePolicyRegistry;
  readonly globalEnabled: boolean;
  readonly cacheToken: InjectionToken<ICache<CachedHttpPayload>>;
  readonly securityWarnings?: OutputCacheSecurityWarningOptions;
  /** Whether a distributed cache backend is configured (enables `@OutputRedisCache`). */
  readonly distributedEnabled?: boolean;
}

export function createRouteOutputCacheComposer(
  policies: CachePolicyRegistry,
  globalEnabled: boolean,
  cacheToken: InjectionToken<ICache<CachedHttpPayload>>,
  securityWarnings?: OutputCacheSecurityWarningOptions,
  distributedEnabled = false,
): RouteOutputCacheComposer {
  return createRouteOutputCacheComposerWithOptions({
    policies,
    globalEnabled,
    cacheToken,
    securityWarnings,
    distributedEnabled,
  });
}

export function createRouteOutputCacheComposerWithOptions(
  options: CreateRouteOutputCacheComposerOptions,
): RouteOutputCacheComposer {
  const { policies, globalEnabled, cacheToken, securityWarnings, distributedEnabled = false } = options;

  return (controllerClass: Class<object>, methodName: string | symbol, _httpMeta: ControllerMeta, _action: ActionMeta) => {
    if (!globalEnabled) {
      return [];
    }

    const middlewares = [];

    const redisMeta = outputRedisCacheMetaOf(controllerClass);
    const redisRequirement = resolveOutputRedisCacheRequirement(redisMeta, methodName);
    const memoryMeta = outputCacheMetaOf(controllerClass);
    const memoryRequirement = resolveOutputCacheRequirement(memoryMeta, methodName);

    if (redisRequirement !== undefined && memoryRequirement !== undefined) {
      console.warn(
        `[cache] ${controllerClass.name}.${String(methodName)} has both @OutputCache and @OutputRedisCache — `
          + "using @OutputRedisCache only.",
      );
    }

    if (redisRequirement !== undefined) {
      if (!distributedEnabled) {
        throw new Error(
          `@OutputRedisCache on ${controllerClass.name}.${String(methodName)} requires a distributed backend (add redisConnect(redisConfig, { cache: "distributed" }) to your @Infra manifest)`,
        );
      }

      const resolved = resolveOutputRedisCacheOptions(redisRequirement, policies);
      if (resolved.enabled !== false && resolved.noStore !== true) {
        const seconds = requireCacheSeconds(
          resolved,
          `@OutputRedisCache on ${controllerClass.name}.${String(methodName)}`,
        );
        const config: ResolvedOutputRedisCacheOptions = { ...resolved, seconds };
        guardInsecureOutputCacheRoute(controllerClass, methodName, config, securityWarnings);
        middlewares.push(
          outputRedisCacheMiddleware({
            routeName: `${controllerClass.name}.${String(methodName)}`,
            config,
          }),
        );
      }
      return middlewares;
    }

    if (memoryRequirement === undefined) {
      return [];
    }

    const resolved = resolveCacheOptions(memoryRequirement, policies);
    if (resolved.enabled === false || resolved.noStore === true) {
      return [];
    }

    const seconds = requireCacheSeconds(resolved, `@OutputCache on ${controllerClass.name}.${String(methodName)}`);
    const config: ResolvedOutputCacheOptions = { ...resolved, seconds };

    guardInsecureOutputCacheRoute(controllerClass, methodName, config, securityWarnings);

    middlewares.push(
      outputCacheMiddleware({
        cacheToken,
        routeName: `${controllerClass.name}.${String(methodName)}`,
        config,
      }),
    );

    return middlewares;
  };
}
