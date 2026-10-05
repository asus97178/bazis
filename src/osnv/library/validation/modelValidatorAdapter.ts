import { Validator } from "./Validator";
import { rulesOf } from "./metadata";

interface AdapterValidationIssue {
  readonly property: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * Чистый адаптер библиотеки валидации под структурный контракт валидатора
 * request-моделей. Намеренно **не импортирует ядро**: возвращает объект формы
 * `{ validate(instance) => { isValid, errors } }`, который структурно совместим
 * с портом `ModelValidator` из `osnv/core/http`.
 *
 * Склейку выполняет композиционный корень (или тест):
 *
 * ```ts
 * import { useModelValidator } from "osnv/core/http";
 * import { modelValidatorAdapter } from "osnv/library/validation";
 *
 * useModelValidator(modelValidatorAdapter);
 * ```
 *
 * Так библиотека остаётся независимой от ядра и среды выполнения, а ядро —
 * не знающим о конкретном движке валидации (Dependency Inversion).
 */
export const modelValidatorAdapter = {
  validate(instance: object): {
    readonly isValid: boolean;
    readonly errors: readonly { readonly property: string; readonly message: string; readonly code?: string }[];
  } {
    const result = Validator.validate(instance);
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
  },
};

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
