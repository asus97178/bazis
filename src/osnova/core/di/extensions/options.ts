import { OptionsValidationError } from "../errors";
import type { ServiceCollection } from "../ServiceCollection";
import { createToken, type InjectionToken, type Token } from "../token";
import type { ServiceResolver } from "../types";

export interface Options<T> {
  readonly value: T;
}

export function createOptionsToken<T>(name = "default"): InjectionToken<Options<T>> {
  return createToken<Options<T>>(`IOptions<${name}>`);
}

export function addOptions<T>(services: ServiceCollection, token: InjectionToken<Options<T>>, value: T): void {
  services.addSingleton({
    provide: token,
    useValue: { value },
  });
}

export interface ValidatedOptionsConfig<T> {
  /** Loads the raw options value (env vars, config file, constants). */
  readonly load: () => T;
  /** Returns a list of problems; empty list or `undefined` means the value is valid. */
  readonly validate?: (value: T) => readonly string[] | undefined;
}

/**
 * Startup validators registered by `addValidatedOptions`. Each one forces its
 * options to load and validate; `validateOptionsOnStart` runs them all and
 * aggregates every problem into a single `OptionsValidationError`.
 */
export const OPTIONS_STARTUP_VALIDATOR = createToken<() => void>("OptionsStartupValidator");

/**
 * .NET-style validated options: `load` runs lazily on first resolve, `validate`
 * gates the value. For fail-fast behavior call `validateOptionsOnStart(container)`
 * in your bootstrap (Application.start does it automatically).
 */
export function addValidatedOptions<T>(
  services: ServiceCollection,
  token: InjectionToken<Options<T>>,
  config: ValidatedOptionsConfig<T>,
): void {
  services.addSingleton({
    provide: token,
    useFactory: (): Options<T> => {
      const value = config.load();
      const issues = config.validate?.(value) ?? [];
      if (issues.length > 0) {
        const name = token.description;
        throw new OptionsValidationError(issues.map((issue) => `${name}: ${issue}`));
      }
      return { value };
    },
    deps: [],
  });

  services.addTransient({
    provide: OPTIONS_STARTUP_VALIDATOR,
    useFactory: (resolver: ServiceResolver) => (): void => {
      resolver.resolve(token);
    },
    deps: [],
    withResolver: true,
  });
}

/**
 * Fail-fast: resolves every validated options registration and throws one
 * `OptionsValidationError` with all collected problems. Non-options errors
 * (e.g. a throwing `load()`) are rethrown as-is.
 */
export function validateOptionsOnStart(provider: { resolveAll<T>(token: Token<T>): readonly T[] }): void {
  const validators = provider.resolveAll(OPTIONS_STARTUP_VALIDATOR);
  const issues: string[] = [];
  for (let index = 0; index < validators.length; index += 1) {
    try {
      (validators[index] as () => void)();
    } catch (error) {
      if (error instanceof OptionsValidationError) {
        issues.push(...error.issues);
      } else {
        throw error;
      }
    }
  }
  if (issues.length > 0) {
    throw new OptionsValidationError(issues);
  }
}
