import {
  DI,
  CLASS_PROVIDER_HOOK,
  OptionsValidationError,
  singleton,
  singletonValue,
  type InjectionToken,
  type Options,
  type OsnovaModuleRef,
  type ProviderDefinition,
} from "../../di";
import { ROUTE_MIDDLEWARE_COMPOSER, type RouteMiddlewareComposerRegistration } from "../../http";
import { HEALTH_CHECK } from "../../kernel";
import { cacheableClassProviderHook } from "../di/classProviderHook";
import { createRouteOutputCacheComposerWithOptions } from "../http/composeOutputCache";
import type { CachedHttpPayload } from "../http/CachedHttpPayload";
import { ICache } from "../ICache";
import { MemoryCache } from "../MemoryCache";
import { CACHE_POLICIES } from "../tokens/CACHE_POLICIES";
import { CACHE_OPTIONS, validateCacheOptions, type CacheOptions } from "../types/CacheOptions";
import type { CachePolicyRegistry } from "../types/CachePolicy";

// =============================================================================
// The cache "engine room". Nothing here is part of the simple public surface —
// `memory()` (./cacheModule) and `redisConnect()` (@/core/infra) are. Advanced
// wiring (policies, output cache, health) lives below so the
// public module stays flat and unintimidating.
// =============================================================================

/** HTTP output-cache tuning (advanced). */
export interface CacheOutputCacheOptions {
  /** Global HTTP output cache switch (default true). */
  readonly enabled?: boolean;
  /**
   * Protected route policy when output cache lacks `varyByUser`/`unlessAuthenticated`.
   * Default: "throw". Use "warn" only for compatibility during migration.
   */
  readonly insecureAuthorizedRouteBehavior?: "throw" | "warn" | "ignore";
  /** Match `jwt({ options: { requireAuthenticationByDefault } })` for security warnings. */
  readonly requireAuthenticationByDefault?: boolean;
}

/**
 * Full cache configuration (advanced). Application code uses the simple values
 * `memory(CacheOptions)`; the hosting layer uses this richer shape to add policies
 * and output-cache tuning. Infra registers distributed stores separately in DI.
 */
export interface CacheModuleConfig extends CacheOptions {
  /** Named policies shared by `@OutputCache` / `@Cacheable`. */
  readonly policies?: CachePolicyRegistry;
  readonly outputCache?: CacheOutputCacheOptions;
  /** DI token for the cache store; default {@link ICache}. */
  readonly token?: typeof ICache;
  readonly imports?: readonly OsnovaModuleRef[];
  /** Register health-check (default true). */
  readonly healthCheck?: boolean;
}

/** Output-cache route middleware runs after auth (order 0) so `@Authorize` is honored first. */
const OUTPUT_CACHE_COMPOSER_ORDER = 100;

/** Builds the global cache module from an advanced {@link CacheModuleConfig}. */
export function buildCacheModule(config: CacheModuleConfig = {}): OsnovaModuleRef {
  const token = config.token ?? ICache;

  return {
    global: true,
    imports: config.imports,
    providers: buildCacheProviders(config),
    exports: [token, CACHE_OPTIONS, CACHE_POLICIES],
  };
}

/** Turns a {@link CacheModuleConfig} into the DI providers. */
function buildCacheProviders(config: CacheModuleConfig): ProviderDefinition[] {
  const token = config.token ?? ICache;
  const policies = config.policies ?? {};

  const providers: ProviderDefinition[] = [
    singletonValue(CLASS_PROVIDER_HOOK, cacheableClassProviderHook),
    cacheOptionsProvider(config),
    DI.singleton(DI.valueProvider(CACHE_POLICIES, policies)),
    singleton(token, MemoryCache, [CACHE_OPTIONS] as const),
    outputCacheComposerProvider(config),
  ];

  if (config.healthCheck !== false) {
    providers.push(healthProvider(token));
  }
  return providers;
}

/** Validated in-memory cache options (fail-fast at startup). */
function cacheOptionsProvider(config: CacheModuleConfig): ProviderDefinition {
  const value: CacheOptions = {
    maxEntries: config.maxEntries,
    maxInFlight: config.maxInFlight,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxKeyLength: config.maxKeyLength,
    maxValueBytes: config.maxValueBytes,
  };
  return DI.singleton(
    DI.factoryProvider(CACHE_OPTIONS, [], (): Options<CacheOptions> => {
      const issues = validateCacheOptions(value);
      if (issues.length > 0) {
        throw new OptionsValidationError(issues.map((issue) => `IOptions<Cache>: ${issue}`));
      }
      return { value };
    }),
  );
}

/** Registers the `@OutputCache` / `@OutputRedisCache` middleware via the HTTP DI token. */
function outputCacheComposerProvider(config: CacheModuleConfig): ProviderDefinition {
  const token = config.token ?? ICache;
  const compose = createRouteOutputCacheComposerWithOptions({
    policies: config.policies ?? {},
    globalEnabled: config.outputCache?.enabled !== false,
    cacheToken: token as InjectionToken<ICache<CachedHttpPayload>>,
    securityWarnings: {
      behavior: outputCacheSecurityBehavior(config.outputCache),
      requireAuthenticationByDefault: config.outputCache?.requireAuthenticationByDefault,
    },
    // Реестры для `@OutputRedisCache` публикует Infra через DI.
    // При отсутствии реестра middleware сообщает об ошибке на первом запросе.
    distributedEnabled: true,
  });
  return singletonValue(ROUTE_MIDDLEWARE_COMPOSER, {
    order: OUTPUT_CACHE_COMPOSER_ORDER,
    compose,
  } satisfies RouteMiddlewareComposerRegistration);
}

function outputCacheSecurityBehavior(options: CacheOutputCacheOptions | undefined): "throw" | "warn" | "ignore" {
  return options?.insecureAuthorizedRouteBehavior ?? "throw";
}

/** Memory health belongs to Cache; connection health belongs to Infra. */
function healthProvider(token: typeof ICache): ProviderDefinition {
  return DI.singleton(
    DI.factoryProvider(HEALTH_CHECK, [token], (cache: ICache) => ({
      name: "cache:memory",
      check: () => ({ healthy: true, details: `entries=${cache.size}` }),
    })),
  );
}
