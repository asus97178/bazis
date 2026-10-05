import type { ValidatorOptions } from "./types/ValidatorOptions";

// One-line polyfill: Bun runs standard TC39 decorators natively,
// but Symbol.metadata may be missing at runtime. Symbol.for gives one shared
// symbol for all module copies.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** Key under which validation rules are stored in the class metadata. */
const FIELD_RULES = Symbol.for("osnv:validation:rules");

/** One registered rule: a field + the options of one decorator. */
export interface FieldRule {
  readonly property: string;
  readonly options: ValidatorOptions;
}

interface RulesMetadata {
  [FIELD_RULES]?: FieldRule[];
}

/**
 * Registers a field rule in the class metadata (called by the decorator).
 *
 * TC39 decorator metadata is inherited prototypically: a subclass's metadata
 * object has the parent's metadata as its prototype. So on the first write to a
 * concrete class we copy on write: the inherited rules are copied into the
 * class's own array without mutating the parent's.
 */
export function registerFieldRule(context: ClassFieldDecoratorContext, options: ValidatorOptions): void {
  if (context.static) {
    throw new Error(`@Validator: static field "${String(context.name)}" is not supported; the decorator works on instance fields only.`);
  }
  if (context.private) {
    throw new Error(`@Validator: private field "${String(context.name)}" is not supported; values are read through ordinary property access.`);
  }

  const metadata = context.metadata as RulesMetadata;
  const inherited = metadata[FIELD_RULES];
  if (!Object.prototype.hasOwnProperty.call(metadata, FIELD_RULES)) {
    metadata[FIELD_RULES] = inherited ? [...inherited] : [];
  }
  metadata[FIELD_RULES]!.push({ property: String(context.name), options });
}

/**
 * Returns the validation rules of a class (including inherited ones), or
 * `undefined` if the class has no `@Validator` decorators.
 */
export function rulesOf(ctor: object | undefined | null): readonly FieldRule[] | undefined {
  if (typeof ctor !== "function") {
    return undefined;
  }
  const metadata = (ctor as unknown as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | RulesMetadata
    | undefined;
  const rules = metadata?.[FIELD_RULES];
  return rules && rules.length > 0 ? rules : undefined;
}

/**
 * Whether the value's class has registered validation rules.
 * Used to auto-detect `nested`.
 */
export function hasRules(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return rulesOf((value as object).constructor) !== undefined;
}
