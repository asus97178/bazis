import type { OutputCacheOptions } from "../types/CachePolicy";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const OUTPUT_CACHE_META = Symbol.for("osnv:cache:output");

export interface OutputCacheRequirement extends OutputCacheOptions {}

export interface OutputCacheControllerMeta {
  outputCache?: OutputCacheRequirement;
  actions: Map<string | symbol, OutputCacheActionMeta>;
}

export interface OutputCacheActionMeta {
  outputCache?: OutputCacheRequirement;
}

interface OutputCacheMetadataCarrier {
  [OUTPUT_CACHE_META]?: OutputCacheControllerMeta;
}

function emptyMeta(): OutputCacheControllerMeta {
  return { actions: new Map() };
}

function cloneMeta(source: OutputCacheControllerMeta): OutputCacheControllerMeta {
  const actions = new Map<string | symbol, OutputCacheActionMeta>();
  for (const [name, action] of source.actions) {
    actions.set(name, { ...action, outputCache: action.outputCache ? { ...action.outputCache } : undefined });
  }
  return {
    outputCache: source.outputCache ? { ...source.outputCache } : undefined,
    actions,
  };
}

export function ownOutputCacheMeta(metadata: object): OutputCacheControllerMeta {
  const carrier = metadata as OutputCacheMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, OUTPUT_CACHE_META)) {
    const inherited = carrier[OUTPUT_CACHE_META];
    carrier[OUTPUT_CACHE_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[OUTPUT_CACHE_META]!;
}

export function ownOutputCacheActionMeta(metadata: object, methodName: string | symbol): OutputCacheActionMeta {
  const meta = ownOutputCacheMeta(metadata);
  let action = meta.actions.get(methodName);
  if (action === undefined) {
    action = {};
    meta.actions.set(methodName, action);
  }
  return action;
}

export function outputCacheMetaOf(ctor: object): OutputCacheControllerMeta | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | OutputCacheMetadataCarrier
    | undefined;
  return metadata?.[OUTPUT_CACHE_META];
}

export function resolveOutputCacheRequirement(
  controllerMeta: OutputCacheControllerMeta | undefined,
  methodName: string | symbol,
): OutputCacheRequirement | undefined {
  if (controllerMeta === undefined) {
    return undefined;
  }
  return controllerMeta.actions.get(methodName)?.outputCache ?? controllerMeta.outputCache;
}
