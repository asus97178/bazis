import { rulesOf } from "./metadata";
import type { ValidatorOptions } from "./types/ValidatorOptions";

/**
 * Nested validation mode for a specific rule:
 * - `explicit`: `nested: true`, recursion even without auto-detection;
 * - `auto`: recursion if the value is an instance of a decorated class;
 * - `none`: this rule does not run nested validation.
 *
 * On a field with several decorators exactly one rule is assigned to carry the
 * nested check; otherwise the nested object's errors would be duplicated.
 */
export type NestedMode = "explicit" | "auto" | "none";

/**
 * Compiled rule of one decorator: everything expensive (RegExp compilation,
 * collecting enum values into a Set) is done in advance, so only the checks
 * remain on the hot validation path.
 */
export interface CompiledRule {
  readonly property: string;
  readonly options: ValidatorOptions;
  /** Whether this rule runs nested validation and in which mode. */
  nested: NestedMode;
  /** Precompiled `pattern` (from a RegExp or a source string). */
  readonly pattern?: RegExp;
  /** Allowed enum values (O(1) membership check). */
  readonly enumValues?: ReadonlySet<unknown>;
  /** Human-readable list of enum values for the `{allowed}` message. */
  readonly enumLabel?: string;
  /** There are string rules: the value must be a string. */
  readonly needsString: boolean;
  /** There are number rules: the value must be a number. */
  readonly needsNumber: boolean;
  /** There are boolean rules: the value must be a boolean. */
  readonly needsBoolean: boolean;
  /** Flag checks, taking the `type` hint into account (type: "email" === email: true). */
  readonly checkEmail: boolean;
  readonly checkUrl: boolean;
  readonly checkUuid: boolean;
  readonly checkJson: boolean;
  readonly checkPhone: boolean;
  readonly checkDate: boolean;
}

/**
 * Compiles and caches the validation plan of a class.
 *
 * The cache is a WeakMap by constructor: rules are collected on the first access
 * to the class and reused by all later `validate` calls. The WeakMap does not
 * keep classes from being garbage collected.
 */
export class RuleCompiler {
  private static readonly cache = new WeakMap<object, readonly CompiledRule[]>();

  /**
   * Validation plan for a constructor, or `undefined` if the class (and its
   * parents) has no `@Validator` decorators.
   */
  static planFor(ctor: object | undefined | null): readonly CompiledRule[] | undefined {
    if (typeof ctor !== "function") {
      return undefined;
    }
    const cached = RuleCompiler.cache.get(ctor);
    if (cached) {
      return cached;
    }
    const rules = rulesOf(ctor);
    if (!rules) {
      return undefined;
    }
    const plan = rules.map((rule) => RuleCompiler.compile(rule.property, rule.options));
    RuleCompiler.assignNestedCarriers(plan);
    RuleCompiler.cache.set(ctor, plan);
    return plan;
  }

  /**
   * Picks the single nested-validation carrier rule for each field: an explicit
   * `nested: true` wins over auto-detection; if any decorator of the field set
   * `nested: false` and there is no explicit `true`, nested checking is turned
   * off for the field entirely.
   */
  private static assignNestedCarriers(plan: CompiledRule[]): void {
    const carrierByProperty = new Map<string, CompiledRule>();
    const disabledProperties = new Set<string>();
    for (const rule of plan) {
      const declared = rule.options.nested;
      if (declared === false) {
        disabledProperties.add(rule.property);
        continue;
      }
      const current = carrierByProperty.get(rule.property);
      if (!current || (declared === true && current.options.nested !== true)) {
        carrierByProperty.set(rule.property, rule);
      }
    }
    for (const [property, carrier] of carrierByProperty) {
      if (carrier.options.nested === true) {
        carrier.nested = "explicit";
      } else if (!disabledProperties.has(property)) {
        carrier.nested = "auto";
      }
    }
  }

  private static compile(property: string, o: ValidatorOptions): CompiledRule {
    const checkEmail = o.email === true || o.type === "email";
    const checkUrl = o.url === true;
    const checkUuid = o.uuid === true;
    const checkJson = o.json === true || o.type === "json";
    const checkPhone = o.phone === true || o.type === "phone";
    const checkDate = o.type === "date";

    const needsString =
      o.type === "string" ||
      o.notEmpty === true ||
      o.minLength !== undefined ||
      o.maxLength !== undefined ||
      o.length !== undefined ||
      o.contains !== undefined ||
      o.notContains !== undefined ||
      o.pattern !== undefined ||
      checkEmail ||
      checkUrl ||
      checkUuid ||
      checkJson ||
      checkPhone;

    const needsNumber =
      o.type === "number" ||
      o.min !== undefined ||
      o.max !== undefined ||
      o.range !== undefined ||
      o.positive === true ||
      o.negative === true ||
      o.integer === true;

    const needsBoolean = o.type === "boolean" || o.mustBeTrue === true || o.mustBeFalse === true;

    // A source string is compiled here once; it is the regular RegExp
    // constructor, with no eval or dynamic code compilation.
    const pattern = o.pattern === undefined ? undefined : o.pattern instanceof RegExp ? o.pattern : new RegExp(o.pattern);

    let enumValues: ReadonlySet<unknown> | undefined;
    let enumLabel: string | undefined;
    if (o.enumType !== undefined) {
      const values = new Set<unknown>();
      for (const key of Object.keys(o.enumType)) {
        // hasOwnProperty: protection against prototype pollution in the given object.
        if (!Object.prototype.hasOwnProperty.call(o.enumType, key)) {
          continue;
        }
        // TypeScript numeric enums contain reverse keys ("0" -> "Admin");
        // skip them, otherwise the value names would become allowed values.
        if (/^\d+$/.test(key)) {
          continue;
        }
        values.add(o.enumType[key]);
      }
      enumValues = values;
      enumLabel = [...values].join(", ");
    }

    return {
      property,
      options: o,
      nested: "none",
      pattern,
      enumValues,
      enumLabel,
      needsString,
      needsNumber,
      needsBoolean,
      checkEmail,
      checkUrl,
      checkUuid,
      checkJson,
      checkPhone,
      checkDate,
    };
  }
}
