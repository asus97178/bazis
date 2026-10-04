import type { OutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const OUTPUT_REDIS_CACHE_META = Symbol.for("osnova:cache:output-redis");

export interface OutputRedisCacheRequirement extends OutputRedisCacheOptions {}

export interface OutputRedisCacheControllerMeta {
  outputRedisCache?: OutputRedisCacheRequirement;
  actions: Map<string | symbol, OutputRedisCacheActionMeta>;
}

export interface OutputRedisCacheActionMeta {
  outputRedisCache?: OutputRedisCacheRequirement;
}

interface OutputRedisCacheMetadataCarrier {
  [OUTPUT_REDIS_CACHE_META]?: OutputRedisCacheControllerMeta;
}

function emptyMeta(): OutputRedisCacheControllerMeta {
  return { actions: new Map() };
}

function cloneMeta(source: OutputRedisCacheControllerMeta): OutputRedisCacheControllerMeta {
  const actions = new Map<string | symbol, OutputRedisCacheActionMeta>();
  for (const [name, action] of source.actions) {
    actions.set(name, {
      ...action,
      outputRedisCache: action.outputRedisCache ? { ...action.outputRedisCache } : undefined,
    });
  }
  return {
    outputRedisCache: source.outputRedisCache ? { ...source.outputRedisCache } : undefined,
    actions,
  };
}

export function ownOutputRedisCacheMeta(metadata: object): OutputRedisCacheControllerMeta {
  const carrier = metadata as OutputRedisCacheMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, OUTPUT_REDIS_CACHE_META)) {
    const inherited = carrier[OUTPUT_REDIS_CACHE_META];
    carrier[OUTPUT_REDIS_CACHE_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[OUTPUT_REDIS_CACHE_META]!;
}

export function ownOutputRedisCacheActionMeta(
  metadata: object,
  methodName: string | symbol,
): OutputRedisCacheActionMeta {
  const meta = ownOutputRedisCacheMeta(metadata);
  let action = meta.actions.get(methodName);
  if (action === undefined) {
    action = {};
    meta.actions.set(methodName, action);
  }
  return action;
}

export function outputRedisCacheMetaOf(ctor: object): OutputRedisCacheControllerMeta | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | OutputRedisCacheMetadataCarrier
    | undefined;
  return metadata?.[OUTPUT_REDIS_CACHE_META];
}

export function resolveOutputRedisCacheRequirement(
  controllerMeta: OutputRedisCacheControllerMeta | undefined,
  methodName: string | symbol,
): OutputRedisCacheRequirement | undefined {
  if (controllerMeta === undefined) {
    return undefined;
  }
  return controllerMeta.actions.get(methodName)?.outputRedisCache ?? controllerMeta.outputRedisCache;
}
