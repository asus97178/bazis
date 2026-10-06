import type { CacheableOptions } from "../types/CachePolicy";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const CACHEABLE_META = Symbol.for("bazis:cache:cacheable");

export interface CacheableRequirement extends CacheableOptions {}

export interface CacheableClassMeta {
  cacheable?: CacheableRequirement;
  methods: Map<string | symbol, CacheableRequirement>;
}

interface CacheableMetadataCarrier {
  [CACHEABLE_META]?: CacheableClassMeta;
}

function emptyMeta(): CacheableClassMeta {
  return { methods: new Map() };
}

function cloneMeta(source: CacheableClassMeta): CacheableClassMeta {
  const methods = new Map<string | symbol, CacheableRequirement>();
  for (const [name, requirement] of source.methods) {
    methods.set(name, { ...requirement });
  }
  return {
    cacheable: source.cacheable ? { ...source.cacheable } : undefined,
    methods,
  };
}

export function ownCacheableMeta(metadata: object): CacheableClassMeta {
  const carrier = metadata as CacheableMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, CACHEABLE_META)) {
    const inherited = carrier[CACHEABLE_META];
    carrier[CACHEABLE_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[CACHEABLE_META]!;
}

export function ownCacheableMethodMeta(metadata: object, methodName: string | symbol): CacheableRequirement {
  const meta = ownCacheableMeta(metadata);
  let requirement = meta.methods.get(methodName);
  if (requirement === undefined) {
    requirement = {};
    meta.methods.set(methodName, requirement);
  }
  return requirement;
}

export function cacheableMetaOf(ctor: object): CacheableClassMeta | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | CacheableMetadataCarrier
    | undefined;
  return metadata?.[CACHEABLE_META];
}

export function resolveCacheableRequirement(
  classMeta: CacheableClassMeta | undefined,
  methodName: string | symbol,
): CacheableRequirement | undefined {
  if (classMeta === undefined) {
    return undefined;
  }
  const method = classMeta.methods.get(methodName);
  if (method !== undefined) {
    return { ...classMeta.cacheable, ...method };
  }
  return classMeta.cacheable;
}

export function hasCacheableMethods(classMeta: CacheableClassMeta | undefined): boolean {
  if (classMeta === undefined) {
    return false;
  }
  return classMeta.cacheable !== undefined || classMeta.methods.size > 0;
}
