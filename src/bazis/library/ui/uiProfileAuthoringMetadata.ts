import type { AnyUiProfileAuthoringOptions } from "./uiProfileAuthoring";

// Bun executes TC39 decorators natively, but Symbol.metadata may be absent.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const UI_PROFILE_AUTHORING_META = Symbol.for("bazis:ui-profile:authoring");

export interface UiProfileAuthoringMetadata {
  readonly target: object;
  readonly targetName: string;
  /** The original process-local authoring object, preserved by identity. */
  readonly profile: AnyUiProfileAuthoringOptions;
}

interface UiProfileAuthoringCarrier {
  [UI_PROFILE_AUTHORING_META]?: UiProfileAuthoringMetadata;
}

interface NamedConstructor {
  readonly name?: string;
}

function classNameOf(target: object): string {
  return (target as NamedConstructor).name?.trim() || "<anonymous UI profile>";
}

function readCarrier(ctor: object): UiProfileAuthoringCarrier | undefined {
  return (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | UiProfileAuthoringCarrier
    | undefined;
}

export function defineUiProfileAuthoringMetadata(
  target: object,
  metadata: object,
  profile: AnyUiProfileAuthoringOptions,
): void {
  freezeAuthoringValue(profile, new WeakSet<object>());
  (metadata as UiProfileAuthoringCarrier)[UI_PROFILE_AUTHORING_META] = Object.freeze({
    target,
    targetName: classNameOf(target),
    profile,
  });
}

function freezeAuthoringValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeAuthoringValue(item, seen);
    }
    Object.freeze(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  for (const item of Object.values(value as Readonly<Record<string, unknown>>)) {
    freezeAuthoringValue(item, seen);
  }
  Object.freeze(value);
}

export function uiProfileAuthoringMetadataOf(ctor: object): UiProfileAuthoringMetadata | undefined {
  const metadata = readCarrier(ctor);
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, UI_PROFILE_AUTHORING_META)) {
    return undefined;
  }
  return metadata[UI_PROFILE_AUTHORING_META];
}

export function isUiProfileAuthoringClass(value: unknown): value is object {
  return typeof value === "function" && uiProfileAuthoringMetadataOf(value) !== undefined;
}
