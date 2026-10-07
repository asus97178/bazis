import {
  AsyncResolutionRequiredError,
  ClassDependenciesMismatchError,
  InvalidProviderError,
  NamedDependencyNotFoundError,
  ProviderNotFoundError,
  ScopeDisposedError,
} from "./errors";
import { GraphValidator, type GraphValidationContext } from "./internal/GraphValidator";
import type { OpenGenericRegistration } from "./internal/OpenGenericRegistration";
import type { PlannedDependency, ResolutionPlan } from "./internal/ResolutionPlan";
import type { ResolutionScopeState } from "./internal/ResolutionScopeState";
import type { ServiceRegistration } from "./internal/ServiceRegistration";
import { ServiceRegistry } from "./internal/ServiceRegistry";
import { ResolutionTracker, type ResolutionActivation } from "./internal/ResolutionTracker";
import { ScopeLifecycle } from "./internal/ScopeLifecycle";
import { ServiceScope } from "./ServiceScope";
import { getConstructorDeps, getProviderDeps } from "./internal/providerDeps";
import type { BuildServiceProviderOptions, ServiceKey, ServiceResolver } from "./types";
import type {
  ClassProvider,
  FactoryProvider,
  KeyedDependency,
  Lazy,
  NamedDependency,
  Provider,
  ProviderDefinition,
  ProviderDependencyList,
  ProviderLifetime,
  ResolvedDeps,
  ValueProvider,
} from "./provider";
import {
  isAsyncFactoryProvider,
  isClassProvider,
  isFactoryProvider,
  isKeyedDependency,
  isLazyDependency,
  isNamedDependency,
  isValueProvider,
} from "./provider";
import type { Token } from "./token";
import { tokenToDebugName } from "./token";

export class ServiceProvider implements ServiceResolver {
  private readonly registry: ServiceRegistry;
  private readonly activations = new ResolutionTracker();
  private readonly lifetime: ScopeLifecycle;
  private readonly planCache = new WeakMap<Provider<unknown>, ResolutionPlan>();
  private readonly options: Required<BuildServiceProviderOptions>;

  public constructor(
    definitions: readonly ProviderDefinition[],
    openGenericRegistrations: readonly OpenGenericRegistration[],
    options?: BuildServiceProviderOptions,
  ) {
    this.options = {
      validateOnBuild: options?.validateOnBuild ?? false,
      validateScopes: options?.validateScopes ?? true,
    };

    this.registry = new ServiceRegistry(definitions, openGenericRegistrations);
    this.lifetime = new ScopeLifecycle(this, this.options.validateScopes);

    if (this.options.validateOnBuild) {
      new GraphValidator(this.createValidationContext()).validate();
    }
  }

  private createValidationContext(): GraphValidationContext {
    return {
      validateScopes: this.options.validateScopes,
      registrationGroups: () => this.registry.groups(),
      eagerlyMaterializeOpenGenerics: (issues) => this.registry.validateOpenGenerics(issues),
      dependencies: (provider) => this.getDependencies(provider),
      classShape: (provider) =>
        isClassProvider(provider)
          ? { required: provider.useClass.length, declared: this.getClassProviderDeps(provider).length }
          : undefined,
      describeDependency: (dependency) => this.getDependencyDescriptor(dependency),
      findRegistration: (token, key) => this.registry.find(token, key),
    };
  }

  public resolve<T>(token: Token<T>): T {
    this.lifetime.assertLive(this.lifetime.root);
    const stack: ResolutionActivation[] = [];
    return this.resolveSingle(token, undefined, this.lifetime.root, stack, undefined);
  }

  public resolveAll<T>(token: Token<T>): readonly T[] {
    return this.resolveAllKeyedInternal(token, undefined, this.lifetime.root);
  }

  public resolveKeyed<T>(token: Token<T>, key: ServiceKey): T {
    this.lifetime.assertLive(this.lifetime.root);
    const stack: ResolutionActivation[] = [];
    return this.resolveSingle(token, key, this.lifetime.root, stack, undefined);
  }

  public resolveAllKeyed<T>(token: Token<T>, key: ServiceKey): readonly T[] {
    return this.resolveAllKeyedInternal(token, key, this.lifetime.root);
  }

  public resolveAsync<T>(token: Token<T>): Promise<T> {
    this.lifetime.assertLive(this.lifetime.root);
    return this.resolveSingleAsync(token, undefined, this.lifetime.root, []);
  }

  public resolveKeyedAsync<T>(token: Token<T>, key: ServiceKey): Promise<T> {
    this.lifetime.assertLive(this.lifetime.root);
    return this.resolveSingleAsync(token, key, this.lifetime.root, []);
  }

  /**
   * Creates every singleton registered with an async factory (keyed ones
   * included), in registration order. Afterwards `resolve` and constructor
   * injection return the cached instances. The kernel calls it at startup, so a
   * failing factory stops the start instead of failing every request.
   */
  public async initializeAsyncSingletons(): Promise<void> {
    this.lifetime.assertLive(this.lifetime.root);
    for (const group of this.registry.groups()) {
      for (const registration of group) {
        if (registration.lifetime === "singleton" && isAsyncFactoryProvider(registration.provider)) {
          await this.resolveRegistrationAsync(registration, registration.key, this.lifetime.root, [], undefined);
        }
      }
    }
  }

  public tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined {
    return this.tryResolveForScope(token, key, this.lifetime.root);
  }

  public has(token: Token<unknown>, key?: ServiceKey): boolean {
    return this.registry.find(token, key) !== undefined;
  }

  public createScope(): ServiceScope {
    return new ServiceScope(this, this.lifetime.createScope());
  }

  public dispose(): Promise<void> {
    return this.lifetime.dispose();
  }

  public resolveForScope<T>(token: Token<T>, scopeState: ResolutionScopeState): T {
    this.lifetime.assertLive(scopeState);
    const stack: ResolutionActivation[] = [];
    return this.resolveSingle(token, undefined, scopeState, stack, undefined);
  }

  public resolveAllForScope<T>(token: Token<T>, scopeState: ResolutionScopeState): readonly T[] {
    return this.resolveAllKeyedForScope(token, undefined, scopeState);
  }

  public resolveKeyedForScope<T>(token: Token<T>, key: ServiceKey, scopeState: ResolutionScopeState): T {
    this.lifetime.assertLive(scopeState);
    const stack: ResolutionActivation[] = [];
    return this.resolveSingle(token, key, scopeState, stack, undefined);
  }

  public resolveAllKeyedForScope<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
  ): readonly T[] {
    return this.resolveAllKeyedInternal(token, key, scopeState);
  }

  public resolveAsyncForScope<T>(token: Token<T>, key: ServiceKey | undefined, scopeState: ResolutionScopeState): Promise<T> {
    this.lifetime.assertLive(scopeState);
    return this.resolveSingleAsync(token, key, scopeState, []);
  }

  public tryResolveForScope<T>(token: Token<T>, key: ServiceKey | undefined, scopeState: ResolutionScopeState): T | undefined {
    return this.tryResolveInternal(token, key, scopeState, [], undefined);
  }

  public disposeScope(scopeState: ResolutionScopeState): Promise<void> {
    return this.lifetime.disposeScope(scopeState);
  }

  private resolveSingle<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime | undefined,
  ): T {
    const registration = this.registry.find(token, key);
    if (!registration) {
      throw new ProviderNotFoundError(token, this.describeResolutionPath(stack, token));
    }

    return this.resolveRegistration(
      registration as ServiceRegistration<T>,
      key,
      scopeState,
      stack,
      ownerLifetime,
    );
  }

  private describeResolutionPath(stack: readonly ResolutionActivation[], token: Token<unknown>): readonly string[] | undefined {
    if (stack.length === 0) {
      return undefined;
    }
    const path = new Array<string>(stack.length + 1);
    for (let index = 0; index < stack.length; index += 1) {
      path[index] = tokenToDebugName((stack[index] as ResolutionActivation).registration.token);
    }
    path[stack.length] = tokenToDebugName(token);
    return path;
  }

  private resolveRegistration<T>(
    registration: ServiceRegistration<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime | undefined,
  ): T {
    const targetScope = this.lifetime.targetFor(registration, scopeState, ownerLifetime);
    if (registration.lifetime !== "transient") {
      const cached = targetScope.cache.get(registration.id);
      if (cached !== undefined || targetScope.cache.has(registration.id)) {
        return cached as T;
      }
    }

    this.activations.assertNoCycle(registration, targetScope, stack);

    // A not-yet-materialized async provider cannot be created synchronously.
    if (isAsyncFactoryProvider(registration.provider)) {
      throw new AsyncResolutionRequiredError(registration.token, this.describeResolutionPath(stack, registration.token));
    }

    if (registration.lifetime !== "transient" && targetScope.pendingAsync.has(registration.id)) {
      throw new AsyncResolutionRequiredError(registration.token, this.describeResolutionPath(stack, registration.token));
    }

    const activation = this.activations.create(registration, targetScope);
    stack.push(activation);
    this.activations.enter(targetScope, activation);
    try {
      // Singleton dependencies are resolved against the root scope, so their
      // disposables outlive the scope that happened to trigger the resolution.
      const instance = this.instantiate(
        registration.provider,
        key,
        registration.lifetime === "singleton" ? this.lifetime.root : scopeState,
        stack,
        ownerLifetime ?? registration.lifetime,
      );
      if (registration.lifetime !== "transient") {
        targetScope.cache.set(registration.id, instance);
      }

      // Externally provided values (useValue) are not created by the container,
      // so the container must not dispose them.
      this.lifetime.track(registration.provider, instance, targetScope);
      return instance as T;
    } finally {
      stack.pop();
      this.activations.leave(targetScope, activation);
    }
  }

  private async resolveSingleAsync<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime?: ProviderLifetime,
  ): Promise<T> {
    const registration = this.registry.find(token, key);
    if (!registration) {
      throw new ProviderNotFoundError(token, this.describeResolutionPath(stack, token));
    }
    return this.resolveRegistrationAsync(registration as ServiceRegistration<T>, key, scopeState, stack, ownerLifetime);
  }

  private async resolveRegistrationAsync<T>(
    registration: ServiceRegistration<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime | undefined,
  ): Promise<T> {
    const targetScope = this.lifetime.targetFor(registration, scopeState, ownerLifetime);
    if (registration.lifetime !== "transient") {
      const cached = targetScope.cache.get(registration.id);
      if (cached !== undefined || targetScope.cache.has(registration.id)) {
        return cached as T;
      }
    }

    this.activations.assertNoCycle(registration, targetScope, stack);

    if (registration.lifetime !== "transient") {
      const pending = targetScope.pendingAsync.get(registration.id);
      if (pending) {
        return this.activations.join(registration, targetScope, stack, pending) as Promise<T>;
      }
    }

    const activation = this.activations.create(registration, targetScope);
    const parent = stack[stack.length - 1];
    if (parent) {
      this.activations.addWait(targetScope, parent, activation);
    }
    stack.push(activation);
    this.activations.enter(targetScope, activation);
    try {
      const creation = this.instantiateAsync(
        registration.provider,
        key,
        registration.lifetime === "singleton" ? this.lifetime.root : scopeState,
        stack,
        ownerLifetime ?? registration.lifetime,
      );
      const resolution = this.completeAsyncResolution(registration, targetScope, creation);
      targetScope.pendingCreations.add(resolution);
      if (registration.lifetime !== "transient") {
        targetScope.pendingAsync.set(registration.id, resolution);
        targetScope.pendingAsyncActivationIds.set(registration.id, activation.id);
      }
      try {
        return await resolution;
      } finally {
        targetScope.pendingCreations.delete(resolution);
        if (registration.lifetime !== "transient") {
          targetScope.pendingAsync.delete(registration.id);
          targetScope.pendingAsyncActivationIds.delete(registration.id);
        }
      }
    } finally {
      stack.pop();
      this.activations.leave(targetScope, activation);
      if (parent) {
        this.activations.removeWait(targetScope, parent, activation);
      }
    }
  }

  private async completeAsyncResolution<T>(
    registration: ServiceRegistration<T>,
    targetScope: ResolutionScopeState,
    creation: Promise<T>,
  ): Promise<T> {
    const instance = await creation;
    this.lifetime.track(registration.provider, instance, targetScope);
    if (targetScope.disposed) {
      throw new ScopeDisposedError();
    }
    if (registration.lifetime !== "transient") {
      targetScope.cache.set(registration.id, instance);
    }
    return instance;
  }

  private async instantiateAsync<T>(
    provider: Provider<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): Promise<T> {
    if (isValueProvider(provider)) {
      return provider.useValue;
    }
    if (isAsyncFactoryProvider(provider)) {
      const deps = await this.resolveDepsAsync(this.getPlan(provider), scopeState, stack, ownerLifetime);
      if (provider.withResolver === true) {
        const resolver = this.createResolverForState(scopeState, stack, ownerLifetime);
        return (provider.useAsyncFactory as (resolver: ServiceResolver, ...args: unknown[]) => Promise<T>)(
          resolver,
          ...deps,
        );
      }
      return (provider.useAsyncFactory as (...args: unknown[]) => Promise<T>)(...deps);
    }
    if (isFactoryProvider(provider)) {
      const deps = await this.resolveDepsAsync(this.getPlan(provider), scopeState, stack, ownerLifetime);
      if (provider.withResolver === true) {
        const resolver = this.createResolverForState(scopeState, stack, ownerLifetime);
        return (provider.useFactory as (resolver: ServiceResolver, ...args: unknown[]) => T)(resolver, ...deps);
      }
      return (provider.useFactory as (...args: unknown[]) => T)(...deps);
    }
    if (isClassProvider(provider)) {
      const classProvider = provider as ClassProvider<T, ProviderDependencyList>;
      const plan = this.getPlan(classProvider);
      this.assertClassDependencyShape(classProvider.provide, classProvider.useClass.length,
        classProvider.activation ? getConstructorDeps(classProvider).length : plan.length);
      const deps = await this.resolveDepsAsync(plan, scopeState, stack, ownerLifetime);
      return this.activateClass(classProvider, deps, scopeState, stack, ownerLifetime);
    }
    throw new InvalidProviderError(tokenToDebugName((provider as Provider<T>).provide));
  }

  private async resolveDepsAsync(
    plan: ResolutionPlan,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): Promise<unknown[]> {
    const resolved: unknown[] = new Array(plan.length);
    for (let index = 0; index < plan.length; index += 1) {
      const dependency = plan[index];
      if (dependency === undefined) {
        continue;
      }
      if (dependency.lazy) {
        resolved[index] = this.createLazy(dependency.token, dependency.key, scopeState, ownerLifetime, stack);
        continue;
      }
      resolved[index] = await this.resolveSingleAsync(dependency.token, dependency.key, scopeState, stack, ownerLifetime);
    }
    return resolved;
  }

  private instantiate<T>(
    provider: Provider<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): T {
    if (isValueProvider(provider)) {
      return this.instantiateValue(provider);
    }
    if (isFactoryProvider(provider)) {
      return this.instantiateFactory(provider, key, scopeState, stack, ownerLifetime);
    }
    if (isClassProvider(provider)) {
      return this.instantiateClass(provider as ClassProvider<T, ProviderDependencyList>, key, scopeState, stack, ownerLifetime);
    }
    throw new InvalidProviderError(tokenToDebugName((provider as Provider<T>).provide));
  }

  private instantiateValue<T>(provider: ValueProvider<T>): T {
    return provider.useValue;
  }

  private instantiateClass<T, D extends ProviderDependencyList>(
    provider: ClassProvider<T, D>,
    _key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): T {
    const plan = this.getPlan(provider);
    this.assertClassDependencyShape(provider.provide, provider.useClass.length,
      provider.activation ? getConstructorDeps(provider).length : plan.length);
    const deps = this.resolveDeps(plan, scopeState, stack, ownerLifetime);
    return this.activateClass(provider, deps, scopeState, stack, ownerLifetime);
  }

  private activateClass<T>(
    provider: ClassProvider<T, ProviderDependencyList>,
    deps: unknown[],
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): T {
    if (!provider.activation) return new provider.useClass(...deps);
    const count = getConstructorDeps(provider).length;
    const instance = new provider.useClass(...deps.slice(0, count));
    try {
      return provider.activation.wrap(
        instance, this.createResolverForState(scopeState, stack, ownerLifetime), ...deps.slice(count),
      );
    } catch (error) {
      // A wrapper failure must not orphan a successfully constructed resource.
      this.lifetime.track(provider, instance, scopeState);
      throw error;
    }
  }

  private instantiateFactory<T, D extends ProviderDependencyList>(
    provider: FactoryProvider<T, D>,
    _key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): T {
    const deps = this.resolveDeps(this.getPlan(provider), scopeState, stack, ownerLifetime);
    if (provider.withResolver === true) {
      const resolver = this.createResolverForState(scopeState, stack, ownerLifetime);
      return (provider.useFactory as (resolver: ServiceResolver, ...args: ResolvedDeps<D>) => T)(resolver, ...deps as ResolvedDeps<D>);
    }
    return (provider.useFactory as (...args: ResolvedDeps<D>) => T)(...deps as ResolvedDeps<D>);
  }

  // Resolver handed to factories must respect the originating scope, otherwise
  // a scoped factory would resolve scoped services from the root and fail.
  private createResolverForState(
    scopeState: ResolutionScopeState,
    resolutionStack: readonly ResolutionActivation[] = [],
    ownerLifetime: ProviderLifetime | undefined = undefined,
  ): ServiceResolver {
    if (scopeState === this.lifetime.root && resolutionStack.length === 0) {
      return this;
    }
    const assertOriginScopeLive = (): void => this.lifetime.assertLive(scopeState);
    const stack = this.activations.capture(resolutionStack);
    return {
      resolve: <T>(token: Token<T>): T => {
        assertOriginScopeLive();
        return this.resolveSingle(token, undefined, scopeState, stack(), ownerLifetime);
      },
      resolveAll: <T>(token: Token<T>): readonly T[] => {
        assertOriginScopeLive();
        return this.resolveAllKeyedInternal(token, undefined, scopeState, stack(), ownerLifetime);
      },
      resolveKeyed: <T>(token: Token<T>, key: ServiceKey): T => {
        assertOriginScopeLive();
        return this.resolveSingle(token, key, scopeState, stack(), ownerLifetime);
      },
      resolveAllKeyed: <T>(token: Token<T>, key: ServiceKey): readonly T[] => {
        assertOriginScopeLive();
        return this.resolveAllKeyedInternal(token, key, scopeState, stack(), ownerLifetime);
      },
      resolveAsync: <T>(token: Token<T>): Promise<T> => {
        try {
          assertOriginScopeLive();
          return this.resolveSingleAsync(token, undefined, scopeState, stack(), ownerLifetime);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      resolveKeyedAsync: <T>(token: Token<T>, key: ServiceKey): Promise<T> => {
        try {
          assertOriginScopeLive();
          return this.resolveSingleAsync(token, key, scopeState, stack(), ownerLifetime);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      tryResolve: <T>(token: Token<T>, key?: ServiceKey): T | undefined => {
        assertOriginScopeLive();
        return this.tryResolveInternal(token, key, scopeState, stack(), ownerLifetime);
      },
      has: (token: Token<unknown>, key?: ServiceKey): boolean => this.has(token, key),
    };
  }

  private resolveDeps(
    plan: ResolutionPlan,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime,
  ): unknown[] {
    const resolved: unknown[] = new Array(plan.length);
    for (let index = 0; index < plan.length; index += 1) {
      const dependency = plan[index];
      if (dependency === undefined) {
        continue;
      }
      resolved[index] = dependency.lazy
        ? this.createLazy(dependency.token, dependency.key, scopeState, ownerLifetime, stack)
        : this.resolveSingle(dependency.token, dependency.key, scopeState, stack, ownerLifetime);
    }
    return resolved;
  }

  // Normalized dependency list per provider: named tokens resolved to their
  // tokens, keyed/lazy unwrapped once. A missing named dependency still fails on
  // first resolve (when the plan is built), not at some distant later access.
  private getPlan(provider: Provider<unknown>): ResolutionPlan {
    const cached = this.planCache.get(provider);
    if (cached) {
      return cached;
    }
    const deps = this.getDependencies(provider);
    const plan: (PlannedDependency | undefined)[] = new Array(deps.length);
    for (let index = 0; index < deps.length; index += 1) {
      const dep = deps[index];
      if (dep === undefined) {
        plan[index] = undefined;
        continue;
      }
      const lazy = isLazyDependency(dep);
      const descriptor = this.getDependencyDescriptor(lazy ? dep.inner : dep);
      plan[index] = { token: descriptor.token, key: descriptor.key, lazy };
    }
    this.planCache.set(provider, plan);
    return plan;
  }

  // The wrapped service is created on first `.value` access against the scope
  // that owned the original resolution. Lifetime rules still apply at access
  // time (e.g. a singleton touching a lazy scoped service throws).
  private createLazy(
    token: Token<unknown>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    ownerLifetime: ProviderLifetime,
    resolutionStack: readonly ResolutionActivation[],
  ): Lazy<unknown> {
    let created = false;
    let instance: unknown;
    const provider = this;
    const stack = this.activations.capture(resolutionStack);
    return {
      get isCreated(): boolean {
        return created;
      },
      get value(): unknown {
        provider.lifetime.assertLive(scopeState);
        if (!created) {
          instance = provider.resolveSingle(token, key, scopeState, stack(), ownerLifetime);
          created = true;
        }
        return instance;
      },
    };
  }

  private getDependencyDescriptor(
    dependency: Token<unknown> | KeyedDependency<unknown> | NamedDependency<unknown>,
  ): {
    readonly token: Token<unknown>;
    readonly key: ServiceKey | undefined;
  } {
    if (isKeyedDependency(dependency)) {
      return {
        token: dependency.token,
        key: dependency.key,
      };
    }

    if (isNamedDependency(dependency)) {
      const token = this.registry.lookupName(dependency.name);
      if (!token) {
        throw new NamedDependencyNotFoundError(dependency.name);
      }
      return {
        token,
        key: undefined,
      };
    }

    return {
      token: dependency,
      key: undefined,
    };
  }

  private getDependencies(provider: Provider<unknown>): ProviderDependencyList {
    return getProviderDeps(provider);
  }

  private getClassProviderDeps(provider: ClassProvider<unknown, ProviderDependencyList>): ProviderDependencyList {
    return getConstructorDeps(provider);
  }

  private assertClassDependencyShape(
    token: Token<unknown>,
    requiredConstructorParams: number,
    declaredDeps: number,
  ): void {
    if (requiredConstructorParams > declaredDeps) {
      throw new ClassDependenciesMismatchError(token, requiredConstructorParams, declaredDeps);
    }
  }

  private resolveAllKeyedInternal<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[] = [],
    ownerLifetime: ProviderLifetime | undefined = undefined,
  ): readonly T[] {
    this.lifetime.assertLive(scopeState);
    const registrations = this.registry.all(token, key);
    // A factory may materialize another key and append to the registry's list.
    const count = registrations.length;
    const instances = new Array<T>(count);
    for (let index = 0; index < count; index += 1) {
      instances[index] = this.resolveRegistration(
        registrations[index] as ServiceRegistration<T>, key, scopeState, stack, ownerLifetime,
      );
    }
    return instances;
  }

  private tryResolveInternal<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
    stack: ResolutionActivation[],
    ownerLifetime: ProviderLifetime | undefined,
  ): T | undefined {
    this.lifetime.assertLive(scopeState);
    const registration = this.registry.find(token, key);
    if (!registration) {
      return undefined;
    }
    return this.resolveRegistration(registration as ServiceRegistration<T>, key, scopeState, stack, ownerLifetime);
  }

}
