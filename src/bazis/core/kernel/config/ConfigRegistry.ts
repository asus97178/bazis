import { DI, type ProviderDefinition } from "../../di";
import { KernelError } from "../errors";
import type { EnvironmentName } from "../types";
import type { Configuration } from "./Configuration";
import { isConfigDefinition, type AppConfig, type ConfigDefinition, type ConfigInspection, type ConfigView, type ValidatableConfig } from "./defineConfig";

/** One immutable set of resolved module configurations per kernel. */
export class ConfigRegistry {
  private readonly views = new Map<ValidatableConfig, AppConfig<object>>();
  public readonly providers: readonly ProviderDefinition[];

  public constructor(configs: readonly ValidatableConfig[], environment: EnvironmentName, source: Configuration) {
    const providers: ProviderDefinition[] = [];
    const issues: string[] = [];
    const errors: unknown[] = [];
    for (const config of new Set(configs)) {
      try {
        if (isConfigDefinition(config)) {
          const view = config.resolve(environment, source);
          this.views.set(config, view);
          providers.push(DI.singleton(DI.valueProvider(config.token, view)));
        } else {
          const view = config.resolve?.(environment, source) ?? config;
          view.ensureValid(environment);
          this.views.set(config, view as AppConfig<object>);
        }
      } catch (error) {
        errors.push(error);
        issues.push(error instanceof Error ? error.message : "Configuration validation failed.");
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Configuration validation failed:\n${issues.join("\n")}`);
    this.providers = Object.freeze(providers);
  }

  public get<T extends object>(config: ConfigDefinition<T>): ConfigView<T>;
  public get<T extends object>(config: AppConfig<T>): AppConfig<T>;
  public get<T extends object>(config: AppConfig<T>): AppConfig<T> {
    const view = this.views.get(config);
    if (view === undefined) throw new KernelError("Configuration was not declared in this kernel's module graph.");
    return view as AppConfig<T>;
  }

  public inspect(): readonly ConfigInspection[] {
    return Object.freeze([...this.views.values()].flatMap(view => "inspect" in view ? (view as ConfigView<object>).inspect() : []));
  }
}
