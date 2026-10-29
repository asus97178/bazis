import { RuleCompiler, type CompiledRule } from "./RuleCompiler";
import { RuleEngine } from "./RuleEngine";
import type { ValidationResult } from "./ValidationResult";
import type { FieldRule } from "./metadata";
import type { ValidatorOptions } from "./types/ValidatorOptions";

/** Field rules of a {@link RuleSet}: one options object or several, as several decorators on one field. */
export type FieldRules = Readonly<Record<string, ValidatorOptions | readonly ValidatorOptions[]>>;

/**
 * Validation rules that are data, not a decorated class: for objects whose
 * shape is known only at run time (rows of tables created by users, rules
 * stored in a database). The same engine, options, codes and messages as
 * `@Validator`; the rules are compiled once in the constructor.
 *
 * ```ts
 * const rules = Validator.ruleSet({
 *   title: { required: true, maxLength: 200 },
 *   amount: [{ type: "number", min: 0 }, { integer: true }],
 * });
 * rules.validate({ title: "", amount: -1.5 }).errors;
 * ```
 *
 * Only the named fields are read. A field name that exists on
 * `Object.prototype` (`__proto__`, `constructor`, `toString`…) is rejected,
 * so a plain object never yields an inherited value.
 */
export class RuleSet {
  private readonly plan: readonly CompiledRule[];

  constructor(rules: FieldRules) {
    const list: FieldRule[] = [];
    for (const property of Object.keys(rules)) {
      if (property in Object.prototype) {
        throw new TypeError(`RuleSet: field "${property}" is not allowed: it is a property of Object.prototype.`);
      }
      const options = rules[property]!;
      for (const item of Array.isArray(options) ? options as readonly ValidatorOptions[] : [options as ValidatorOptions]) {
        list.push({ property, options: item });
      }
    }
    this.plan = RuleCompiler.compileRules(list);
  }

  /** Field names that have rules. */
  get fields(): readonly string[] {
    return [...new Set(this.plan.map((rule) => rule.property))];
  }

  /** Synchronous validation; an async `custom` adds an `asyncCustomInSyncCall` error. */
  validate(value: object): ValidationResult {
    return RuleEngine.validatePlan(this.plan, value);
  }

  /** Asynchronous validation: awaits async `custom` functions. */
  validateAsync(value: object): Promise<ValidationResult> {
    return RuleEngine.validatePlanAsync(this.plan, value);
  }
}
