import type { InjectionToken, Options, ProviderDefinition, ServiceCollection, ServiceResolver } from "../../di";
import { DI, OPTIONS_STARTUP_VALIDATOR, OptionsValidationError } from "../../di";
import { ConfigKeyMissingError } from "../errors";
import { Configuration } from "./Configuration";

export interface ConfigOptionsBinding<T> {
  /** Maps the merged configuration to a typed options value. */
  readonly bind: (config: Configuration) => T;
  /** Returns a list of problems; empty list or `undefined` means valid. */
  readonly validate?: (value: T) => readonly string[] | undefined;
}

/**
 * Config-bound validated options (Symfony bundle configuration style):
 * a module declares its own options next to itself, binding reads from the
 * kernel `Configuration`, and the kernel fails fast on start with every
 * config problem aggregated.
 *
 * Module usage: `providers: [...configOptions(SMTP_OPTIONS, { bind, validate })]`.
 */
export function configOptions<T>(
  token: InjectionToken<Options<T>>,
  binding: ConfigOptionsBinding<T>,
): readonly ProviderDefinition[] {
  const optionsDefinition = DI.singleton(
    DI.factoryProvider(token, [Configuration] as const, (config): Options<T> => {
      const name = token.description;
      let value: T;
      try {
        value = binding.bind(config);
      } catch (error) {
        // Missing keys become validation issues, so the startup check can
        // aggregate them with every other config problem.
        if (error instanceof ConfigKeyMissingError) {
          throw new OptionsValidationError([`${name}: ${error.message}`]);
        }
        throw error;
      }
      const issues = binding.validate?.(value) ?? [];
      if (issues.length > 0) {
        throw new OptionsValidationError(issues.map((issue) => `${name}: ${issue}`));
      }
      return { value };
    }),
  );

  const validatorDefinition = DI.transient(
    DI.factoryProviderWithResolver(OPTIONS_STARTUP_VALIDATOR, [], (resolver: ServiceResolver) => (): void => {
      resolver.resolve(token);
    }),
  );

  return [optionsDefinition, validatorDefinition];
}

/** Collection-style registration of the same config-bound options. */
export function addConfigOptions<T>(
  services: ServiceCollection,
  token: InjectionToken<Options<T>>,
  binding: ConfigOptionsBinding<T>,
): void {
  services.addMany(configOptions(token, binding));
}
