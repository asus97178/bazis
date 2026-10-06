import { OpenGenericRegistration, type OpenGenericProviderFactory } from "./internal/OpenGenericRegistration";
import { ServiceProvider } from "./ServiceProvider";
import type { OpenGenericTokenFamily, Token } from "./token";
import type { BuildServiceProviderOptions, ServiceKey } from "./types";
import type { Provider, ProviderDefinition, ProviderLifetime } from "./provider";
import { ProviderDefinition as ProviderDefinitionClass } from "./provider";
import { applyClassProviderHooksToDefinition, collectClassProviderHooks } from "./module/classProviderHooks";

export class ServiceCollection {
  private readonly definitions: ProviderDefinition[] = [];
  private readonly openGenericRegistrations: OpenGenericRegistration[] = [];

  public add(definition: ProviderDefinition): this {
    this.definitions.push(definition);
    return this;
  }

  public addMany(definitions: readonly ProviderDefinition[]): this {
    for (let index = 0; index < definitions.length; index += 1) {
      this.add(definitions[index] as ProviderDefinition);
    }
    return this;
  }

  public addSingleton<T>(provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "singleton"));
  }

  public addKeyedSingleton<T>(key: ServiceKey, provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "singleton", key));
  }

  public addScoped<T>(provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "scoped"));
  }

  public addKeyedScoped<T>(key: ServiceKey, provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "scoped", key));
  }

  public addTransient<T>(provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "transient"));
  }

  public addKeyedTransient<T>(key: ServiceKey, provider: Provider<T>): this {
    return this.add(new ProviderDefinitionClass(provider, "transient", key));
  }

  public tryAddSingleton<T>(provider: Provider<T>): boolean {
    return this.tryAdd(provider, "singleton", undefined);
  }

  public tryAddScoped<T>(provider: Provider<T>): boolean {
    return this.tryAdd(provider, "scoped", undefined);
  }

  public tryAddTransient<T>(provider: Provider<T>): boolean {
    return this.tryAdd(provider, "transient", undefined);
  }

  public tryAddKeyedSingleton<T>(key: ServiceKey, provider: Provider<T>): boolean {
    return this.tryAdd(provider, "singleton", key);
  }

  public tryAddKeyedScoped<T>(key: ServiceKey, provider: Provider<T>): boolean {
    return this.tryAdd(provider, "scoped", key);
  }

  public tryAddKeyedTransient<T>(key: ServiceKey, provider: Provider<T>): boolean {
    return this.tryAdd(provider, "transient", key);
  }

  public tryAddEnumerable(definition: ProviderDefinition): boolean {
    for (let index = 0; index < this.definitions.length; index += 1) {
      const current = this.definitions[index] as ProviderDefinition;
      if (
        current.provider.provide === definition.provider.provide &&
        current.key === definition.key &&
        sameProviderIdentity(current.provider, definition.provider)
      ) {
        return false;
      }
    }
    this.definitions.push(definition);
    return true;
  }

  public replace<T>(token: Token<T>, provider: Provider<T>, lifetime: ProviderLifetime, key?: ServiceKey): this {
    this.remove(token, key);
    return this.add(new ProviderDefinitionClass(provider, lifetime, key));
  }

  public remove(token: Token<unknown>, key?: ServiceKey): number {
    let removed = 0;
    for (let index = this.definitions.length - 1; index >= 0; index -= 1) {
      const definition = this.definitions[index] as ProviderDefinition;
      if (definition.provider.provide === token && definition.key === key) {
        this.definitions.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  public addOpenGeneric(
    family: OpenGenericTokenFamily<unknown, unknown>,
    lifetime: ProviderLifetime,
    providerFactory: OpenGenericProviderFactory,
    key?: ServiceKey,
  ): this {
    this.openGenericRegistrations.push(new OpenGenericRegistration(family, providerFactory, lifetime, key));
    return this;
  }

  public buildServiceProvider(options?: BuildServiceProviderOptions): ServiceProvider {
    const hooks = collectClassProviderHooks(this.definitions);
    const definitions = this.definitions.map((definition) => applyClassProviderHooksToDefinition(definition, hooks));
    const generics = hooks.length === 0 ? this.openGenericRegistrations.slice()
      : this.openGenericRegistrations.map((registration) => new OpenGenericRegistration(
        registration.family,
        (argument) => applyClassProviderHooksToDefinition(new ProviderDefinitionClass(
          registration.providerFactory(argument), registration.lifetime, registration.key,
        ), hooks).provider,
        registration.lifetime, registration.key,
      ));
    return new ServiceProvider(definitions, generics, options);
  }

  public toArray(): readonly ProviderDefinition[] {
    return this.definitions.slice();
  }

  /** Number of registered definitions (used for build-time module attribution). */
  public get size(): number {
    return this.definitions.length;
  }

  /** Definitions added at or after `start` (used for build-time module attribution). */
  public definitionsFrom(start: number): readonly ProviderDefinition[] {
    return this.definitions.slice(start);
  }

  /** Number of open generic registrations (used for build-time module attribution). */
  public get openGenericSize(): number {
    return this.openGenericRegistrations.length;
  }

  /** Open generic registrations added at or after `start`. */
  public openGenericsFrom(start: number): readonly OpenGenericRegistration[] {
    return this.openGenericRegistrations.slice(start);
  }

  public openGenericToArray(): readonly OpenGenericRegistration[] {
    return this.openGenericRegistrations.slice();
  }

  private tryAdd<T>(provider: Provider<T>, lifetime: ProviderLifetime, key: ServiceKey | undefined): boolean {
    const token = provider.provide;
    for (let index = 0; index < this.definitions.length; index += 1) {
      const definition = this.definitions[index] as ProviderDefinition;
      if (definition.provider.provide === token && definition.key === key) {
        return false;
      }
    }

    this.add(new ProviderDefinitionClass(provider, lifetime, key));
    return true;
  }
}

function sameProviderIdentity(a: Provider, b: Provider): boolean {
  if ("useClass" in a && "useClass" in b) {
    return a.useClass === b.useClass;
  }
  if ("useFactory" in a && "useFactory" in b) {
    return a.useFactory === b.useFactory;
  }
  if ("useAsyncFactory" in a && "useAsyncFactory" in b) {
    return a.useAsyncFactory === b.useAsyncFactory;
  }
  if ("useValue" in a && "useValue" in b) {
    return a.useValue === b.useValue;
  }
  return false;
}
