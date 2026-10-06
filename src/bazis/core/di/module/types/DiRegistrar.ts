import type { OpenGenericTokenFamily, Token } from "../../token";
import type { Provider, ProviderDefinition, ProviderLifetime } from "../../provider";
import type { ServiceKey } from "../../types";

export interface DiRegistrar {
  singleton<T>(provider: Provider<T>): void;
  scoped<T>(provider: Provider<T>): void;
  transient<T>(provider: Provider<T>): void;
  keyedSingleton<T>(key: ServiceKey, provider: Provider<T>): void;
  keyedScoped<T>(key: ServiceKey, provider: Provider<T>): void;
  keyedTransient<T>(key: ServiceKey, provider: Provider<T>): void;
  trySingleton<T>(provider: Provider<T>): boolean;
  tryScoped<T>(provider: Provider<T>): boolean;
  tryTransient<T>(provider: Provider<T>): boolean;
  tryAddEnumerable(definition: ProviderDefinition): boolean;
  replace<T>(token: Token<T>, provider: Provider<T>, lifetime: ProviderLifetime, key?: ServiceKey): void;
  remove(token: Token<unknown>, key?: ServiceKey): number;
  addOpenGeneric(
    family: OpenGenericTokenFamily<unknown, unknown>,
    lifetime: ProviderLifetime,
    providerFactory: (argument: Token<unknown>) => Provider<unknown>,
    key?: ServiceKey,
  ): void;
}
