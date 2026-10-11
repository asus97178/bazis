import type { Class, ClassProviderHook, Token } from "../../di";
import { CacheDeclarationError } from "../errors/CacheError";
import { cacheableMetaOf, hasCacheableMethods } from "../decorators/cacheableMetadata";
import { cacheableRedisMetaOf, hasCacheableRedisMethods } from "../decorators/cacheableRedisMetadata";
import { cachedScoped, cachedSingleton } from "../providers/cachedProviders";

/**
 * Pure build extension contributed by the cache module to its own container.
 * DI retains construction, lifetime, dependency validation and resource ownership.
 */
export const cacheableClassProviderHook: ClassProviderHook = ({ lifetime, provide, useClass, deps }) => {
  const hasCache =
    hasCacheableMethods(cacheableMetaOf(useClass))
    || hasCacheableRedisMethods(cacheableRedisMetaOf(useClass));
  if (!hasCache) {
    return undefined;
  }
  const token = provide as Token<object>;
  const impl = useClass as Class<object>;
  assertCacheableLifetime(impl, lifetime);
  if (lifetime === "scoped") {
    return cachedScoped(token, impl, deps);
  }
  if (lifetime === "singleton") {
    return cachedSingleton(token, impl, deps);
  }
  return undefined;
};

interface Declared { readonly key?: unknown; readonly policy?: unknown }

/**
 * A cache that can never hit is refused at startup, as an invalid registration
 * (a DI error: the start prints it as a configuration error). The automatic key belongs
 * to the service instance (a scoped result may depend on the request's user),
 * so without an explicit `key` a scoped service caches only within one request,
 * and a transient one — never.
 */
function assertCacheableLifetime(impl: Class<object>, lifetime: string): void {
  const declarations: { decorator: string; classLevel?: Declared; methods: ReadonlyMap<string | symbol, Declared> }[] = [];
  const memory = cacheableMetaOf(impl);
  if (hasCacheableMethods(memory)) declarations.push({ decorator: "@Cacheable", classLevel: memory!.cacheable, methods: memory!.methods });
  const shared = cacheableRedisMetaOf(impl);
  if (hasCacheableRedisMethods(shared)) declarations.push({ decorator: "@CacheableRedis", classLevel: shared!.cacheableRedis, methods: shared!.methods });
  for (const { decorator, classLevel, methods } of declarations) {
    if (lifetime === "transient") {
      throw new CacheDeclarationError(`${impl.name} uses ${decorator} but is registered transient: a new instance for every injection never reuses its cache. Register it as singleton or scoped.`);
    }
    if (lifetime !== "scoped") continue;
    const names = methods.size > 0 ? [...methods.keys()] : ["(every method)"];
    for (const name of names) {
      const declared = { ...classLevel, ...(typeof name === "string" && name === "(every method)" ? {} : methods.get(name)) };
      if (declared.key !== undefined || declared.policy !== undefined) continue;
      throw new CacheDeclarationError(`${impl.name}.${String(name)}: ${decorator} without key on a scoped service caches only within one request (the automatic key belongs to the instance). Set key — include the user or tenant when the result depends on them — or register ${impl.name} as a singleton.`);
    }
  }
}
