import { ServiceCollection } from "../ServiceCollection";
import type { Provider, ProviderDefinition } from "../provider";
import { DI } from "./DI";
import type { Token } from "../token";
import type { ProviderLifetime } from "../provider";
import type { ServiceKey } from "../types";
import type { OpenGenericTokenFamily } from "../token";
import type { DiRegistrar } from "./types";

export class ModuleRegistrar implements DiRegistrar {
  public constructor(private readonly collection: ServiceCollection) {}

  public singleton<T>(provider: Provider<T>): void {
    this.collection.add(DI.singleton(provider));
  }

  public scoped<T>(provider: Provider<T>): void {
    this.collection.add(DI.scoped(provider));
  }

  public transient<T>(provider: Provider<T>): void {
    this.collection.add(DI.transient(provider));
  }

  public keyedSingleton<T>(key: ServiceKey, provider: Provider<T>): void {
    this.collection.add(DI.keyedSingleton(key, provider));
  }

  public keyedScoped<T>(key: ServiceKey, provider: Provider<T>): void {
    this.collection.add(DI.keyedScoped(key, provider));
  }

  public keyedTransient<T>(key: ServiceKey, provider: Provider<T>): void {
    this.collection.add(DI.keyedTransient(key, provider));
  }

  public trySingleton<T>(provider: Provider<T>): boolean {
    return this.collection.tryAddSingleton(provider);
  }

  public tryScoped<T>(provider: Provider<T>): boolean {
    return this.collection.tryAddScoped(provider);
  }

  public tryTransient<T>(provider: Provider<T>): boolean {
    return this.collection.tryAddTransient(provider);
  }

  public tryAddEnumerable(definition: ProviderDefinition): boolean {
    return this.collection.tryAddEnumerable(definition);
  }

  public replace<T>(token: Token<T>, provider: Provider<T>, lifetime: ProviderLifetime, key?: ServiceKey): void {
    this.collection.replace(token, provider, lifetime, key);
  }

  public remove(token: Token<unknown>, key?: ServiceKey): number {
    return this.collection.remove(token, key);
  }

  public addOpenGeneric(
    family: OpenGenericTokenFamily<unknown, unknown>,
    lifetime: ProviderLifetime,
    providerFactory: (argument: Token<unknown>) => Provider<unknown>,
    key?: ServiceKey,
  ): void {
    this.collection.addOpenGeneric(family, lifetime, providerFactory, key);
  }
}
