import { Validator } from "./Validator";
import { rulesOf } from "./metadata";
import { MessageRegistry } from "./MessageRegistry";
import type { ValidationResult } from "./ValidationResult";

interface AdapterValidationIssue {
  readonly property: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * Pure adapter of the validation library to the structural request-model
 * validator contract. It deliberately **does not import the kernel**: it returns
 * an object of the shape `{ validate(instance) => { isValid, errors } }`, which is
 * structurally compatible with the `ModelValidator` port from `bazis/core/http`.
 *
 * `runApp` plugs it in by default (unless `options.validator` is given). Outside
 * `runApp`, for example in a test, wire it yourself:
 *
 * ```ts
 * import { useModelValidator } from "bazis/core/http";
 * import { modelValidatorAdapter } from "bazis/library/validation";
 *
 * useModelValidator(modelValidatorAdapter);
 * ```
 *
 * This keeps the library independent of the kernel and the runtime, and the
 * kernel unaware of the concrete validation engine (dependency inversion).
 */
export const modelValidatorAdapter = {
  validate(instance: object): AdapterValidationResult {
    return toAdapterResult(instance, Validator.validate(instance));
  },

  /** Runs async `custom` rules too; HTTP request binding uses this. */
  async validateAsync(instance: object): Promise<AdapterValidationResult> {
    return toAdapterResult(instance, await Validator.validateAsync(instance));
  },

  /** A JSON value of the wrong type, in the current `MessageRegistry` language. */
  typeMismatchMessage(property: string, expected: string, actual: string): string {
    return MessageRegistry.format("type", undefined, { property, expected, actual });
  },

  failureTitle(): string {
    return MessageRegistry.format("validationFailed", undefined, {});
  },
};

interface AdapterValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly AdapterValidationIssue[];
}

function toAdapterResult(instance: object, result: ValidationResult): AdapterValidationResult {
    const nestedInstanceErrors = validateExplicitNestedInstances(instance);
    const errors: AdapterValidationIssue[] = result.errors.map((error) => ({
      property: error.property,
      message: error.message,
      code: error.code,
    }));
    errors.push(...nestedInstanceErrors);
    return {
      isValid: errors.length === 0,
      errors,
    };
}

/**
 * `nested: true` must never silently validate a plain object with no class
 * metadata. Generated HTTP hydration normally makes every value a DTO
 * instance; this adapter check is the fail-closed guard for stale/missing
 * generated metadata and DTO integrations.
 */
function validateExplicitNestedInstances(root: object): AdapterValidationIssue[] {
  const errors: AdapterValidationIssue[] = [];
  inspectExplicitNested(root, "", errors, new Set<object>());
  return errors;
}

function inspectExplicitNested(
  instance: object,
  prefix: string,
  errors: AdapterValidationIssue[],
  seen: Set<object>,
): void {
  if (seen.has(instance)) {
    return;
  }
  seen.add(instance);
  const rules = rulesOf(instance.constructor);
  if (rules === undefined) {
    return;
  }
  const explicitProperties = new Set<string>();
  for (const rule of rules) {
    if (rule.options.nested === true) {
      explicitProperties.add(rule.property);
    }
  }
  for (const property of explicitProperties) {
    const value = (instance as Record<string, unknown>)[property];
    if (value === undefined || value === null) {
      continue;
    }
    const path = prefix === "" ? property : `${prefix}.${property}`;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        inspectNestedValue(value[index], `${path}[${index}]`, errors, seen);
      }
    } else {
      inspectNestedValue(value, path, errors, seen);
    }
  }
}

function inspectNestedValue(
  value: unknown,
  path: string,
  errors: AdapterValidationIssue[],
  seen: Set<object>,
): void {
  // Validation's established optional/null semantics also apply to nullable
  // array elements; `required` on the owning field handles the field itself.
  if (value === null) {
    return;
  }
  const prototype = typeof value === "object" ? Object.getPrototypeOf(value) as { constructor?: unknown } | null : null;
  const constructor = prototype?.constructor;
  if (typeof value !== "object" || typeof constructor !== "function" || rulesOf(constructor) === undefined) {
    errors.push({
      property: path,
      message: `Field "${path}" must be a hydrated DTO instance`,
      code: "nestedModel",
    });
    return;
  }
  inspectExplicitNested(value, path, errors, seen);
}
