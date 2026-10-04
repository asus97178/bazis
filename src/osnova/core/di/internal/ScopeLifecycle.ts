import { ScopeDisposedError, ScopedServiceFromRootError } from "../errors";
import { isValueProvider, type Provider, type ProviderLifetime } from "../provider";
import { disposeTracked } from "./disposal";
import { ResolutionScopeState } from "./ResolutionScopeState";
import type { ServiceRegistration } from "./ServiceRegistration";

/** Owns scopes, resource identities and the shared asynchronous disposal work. */
export class ScopeLifecycle {
  public readonly root = new ResolutionScopeState(true);
  private readonly children = new Set<ResolutionScopeState>();
  private readonly trackedDisposableIdentities = new WeakSet<object>();

  public constructor(private readonly owner: object, private readonly validateScopes: boolean) {}

  public createScope(): ResolutionScopeState {
    this.assertLive(this.root);
    const scope = new ResolutionScopeState(false);
    this.children.add(scope);
    return scope;
  }

  // Scope/lifetime rules shared by the sync and async resolve paths. Returns the
  // scope that owns the resulting instance (root for singletons), guaranteeing a
  // single source of truth for captive-dependency and disposed-scope checks.
  public targetFor(
    registration: ServiceRegistration,
    scopeState: ResolutionScopeState,
    ownerLifetime: ProviderLifetime | undefined,
  ): ResolutionScopeState {
    if (this.validateScopes && registration.lifetime === "scoped") {
      // A singleton consumer or a direct root resolution cannot own a scoped
      // service — that would be a captive dependency.
      if (ownerLifetime === "singleton" || scopeState.isRoot) {
        throw new ScopedServiceFromRootError(registration.token);
      }
    }

    const targetScope = registration.lifetime === "singleton" ? this.root : scopeState;
    // A live child scope must not resurrect singletons in a disposed root: the
    // root cache/disposables are already cleared, so the new instance would leak
    // and never be disposed. Mirror .NET's ObjectDisposedException.
    this.assertLive(targetScope);
    return targetScope;
  }

  public assertLive(scopeState: ResolutionScopeState): void {
    if (scopeState.disposed) {
      throw new ScopeDisposedError();
    }
  }

  public track(
    provider: Provider<unknown>,
    instance: unknown,
    targetScope: ResolutionScopeState,
  ): void {
    if (
      isValueProvider(provider)
      || provider.ownership === "external"
      || instance === this.owner
      || !isDisposableInstance(instance)
    ) {
      return;
    }
    const identity = instance as object;
    if (this.trackedDisposableIdentities.has(identity)) {
      return;
    }
    this.trackedDisposableIdentities.add(identity);
    targetScope.disposables.push(instance);
  }

  public dispose(): Promise<void> {
    if (this.root.disposalPromise !== undefined) {
      return this.root.disposalPromise;
    }
    this.root.disposed = true;
    const children = [...this.children];
    for (let index = 0; index < children.length; index += 1) {
      children[index]!.disposed = true;
    }
    // Defer cleanup until after the shared promise is published. A disposer is
    // allowed to call container.dispose() re-entrantly and must join this work.
    const disposal = Promise.resolve().then(() => this.disposeRootAndChildren(children));
    this.root.disposalPromise = disposal;
    return disposal;
  }

  public disposeScope(scopeState: ResolutionScopeState): Promise<void> {
    if (scopeState.disposalPromise !== undefined) {
      return scopeState.disposalPromise;
    }
    scopeState.disposed = true;
    const disposal = Promise.resolve().then(() => this.disposeScopeState(scopeState)).finally(() => {
      this.children.delete(scopeState);
    });
    scopeState.disposalPromise = disposal;
    return disposal;
  }

  private async disposeRootAndChildren(children: readonly ResolutionScopeState[]): Promise<void> {
    const errors: unknown[] = [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      try {
        const disposal = child.disposalPromise ?? Promise.resolve().then(() => this.disposeScopeState(child));
        child.disposalPromise = disposal;
        await disposal;
      } catch (error) {
        errors.push(error);
      } finally {
        this.children.delete(child);
      }
    }
    try {
      await this.disposeScopeState(this.root);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Container disposal finished with errors.");
    }
  }

  private async disposeScopeState(scopeState: ResolutionScopeState): Promise<void> {
    // Resolutions observe `disposed` and only register a late-created resource
    // for cleanup; waiting here guarantees it cannot escape after disposal.
    while (scopeState.pendingCreations.size > 0) {
      await Promise.allSettled([...scopeState.pendingCreations]);
    }
    try {
      await disposeTracked(scopeState.disposables);
    } finally {
      scopeState.disposables.length = 0;
      scopeState.cache.clear();
      scopeState.pendingAsync.clear();
      scopeState.pendingCreations.clear();
      scopeState.pendingWaits.clear();
      scopeState.pendingAsyncActivationIds.clear();
      scopeState.activeActivationIds.clear();
    }
  }
}

function isDisposableInstance(instance: unknown): boolean {
  if (!instance || (typeof instance !== "object" && typeof instance !== "function")) {
    return false;
  }
  const value = instance as Record<PropertyKey, unknown>;
  return (
    typeof value.dispose === "function" ||
    typeof value.disposeAsync === "function" ||
    typeof value[Symbol.dispose] === "function" ||
    typeof value[Symbol.asyncDispose] === "function"
  );
}
