import type { CacheableRedisOptions } from "../types/CacheableRedisOptions";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const CACHEABLE_REDIS_META = Symbol.for("bazis:cache:cacheable-redis");

export interface CacheableRedisRequirement extends CacheableRedisOptions {}

export interface CacheableRedisClassMeta {
  cacheableRedis?: CacheableRedisRequirement;
  methods: Map<string | symbol, CacheableRedisRequirement>;
}

interface CacheableRedisMetadataCarrier {
  [CACHEABLE_REDIS_META]?: CacheableRedisClassMeta;
}

function emptyMeta(): CacheableRedisClassMeta {
  return { methods: new Map() };
}

function cloneMeta(source: CacheableRedisClassMeta): CacheableRedisClassMeta {
  const methods = new Map<string | symbol, CacheableRedisRequirement>();
  for (const [name, requirement] of source.methods) {
    methods.set(name, { ...requirement });
  }
  return {
    cacheableRedis: source.cacheableRedis ? { ...source.cacheableRedis } : undefined,
    methods,
  };
}

export function ownCacheableRedisMeta(metadata: object): CacheableRedisClassMeta {
  const carrier = metadata as CacheableRedisMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, CACHEABLE_REDIS_META)) {
    const inherited = carrier[CACHEABLE_REDIS_META];
    carrier[CACHEABLE_REDIS_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[CACHEABLE_REDIS_META]!;
}

export function ownCacheableRedisMethodMeta(
  metadata: object,
  methodName: string | symbol,
): CacheableRedisRequirement {
  const meta = ownCacheableRedisMeta(metadata);
  let requirement = meta.methods.get(methodName);
  if (requirement === undefined) {
    requirement = {};
    meta.methods.set(methodName, requirement);
  }
  return requirement;
}

export function cacheableRedisMetaOf(ctor: object): CacheableRedisClassMeta | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | CacheableRedisMetadataCarrier
    | undefined;
  return metadata?.[CACHEABLE_REDIS_META];
}

export function resolveCacheableRedisRequirement(
  classMeta: CacheableRedisClassMeta | undefined,
  methodName: string | symbol,
): CacheableRedisRequirement | undefined {
  if (classMeta === undefined) {
    return undefined;
  }
  const method = classMeta.methods.get(methodName);
  if (method !== undefined) {
    return { ...classMeta.cacheableRedis, ...method };
  }
  return classMeta.cacheableRedis;
}

export function hasCacheableRedisMethods(classMeta: CacheableRedisClassMeta | undefined): boolean {
  if (classMeta === undefined) {
    return false;
  }
  return classMeta.cacheableRedis !== undefined || classMeta.methods.size > 0;
}
