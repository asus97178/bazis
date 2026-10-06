import { CircularDependencyError } from "../errors";
import type { ResolutionScopeState } from "./ResolutionScopeState";
import { ServiceRegistration } from "./ServiceRegistration";

export interface ResolutionActivation {
  readonly id: number;
  readonly registration: ServiceRegistration;
  readonly scope: ResolutionScopeState;
}

/** Tracks active construction chains and scope-local async wait edges. */
export class ResolutionTracker {
  private nextActivationId = 0;
  private readonly activeActivations = new Map<number, ResolutionActivation>();

  public assertNoCycle(
    registration: ServiceRegistration,
    scope: ResolutionScopeState,
    stack: readonly ResolutionActivation[],
  ): void {
    if (stack.some((entry) => entry.registration.id === registration.id && entry.scope === scope)) {
      throw this.createCircularDependencyError([...stack, this.create(registration, scope)]);
    }
  }

  public create(registration: ServiceRegistration, scope: ResolutionScopeState): ResolutionActivation {
    return { id: this.nextActivationId++, registration, scope };
  }

  public enter(scopeState: ResolutionScopeState, activation: ResolutionActivation): void {
    scopeState.activeActivationIds.add(activation.id);
    this.activeActivations.set(activation.id, activation);
  }

  public leave(scopeState: ResolutionScopeState, activation: ResolutionActivation): void {
    scopeState.activeActivationIds.delete(activation.id);
    this.activeActivations.delete(activation.id);
  }

  public capture(resolutionStack: readonly ResolutionActivation[]): () => ResolutionActivation[] {
    const captured = [...resolutionStack];
    const owner = captured[captured.length - 1];
    return () => {
      // Retained resolvers and Lazy wrappers belong to their own activation.
      // After it settles they must not inherit a still-running ancestor.
      if (!owner || !owner.scope.activeActivationIds.has(owner.id)) {
        return [];
      }
      return captured.filter((entry) => entry.scope.activeActivationIds.has(entry.id));
    };
  }

  public join<T>(
    registration: ServiceRegistration<T>,
    scopeState: ResolutionScopeState,
    stack: readonly ResolutionActivation[],
    pending: Promise<unknown>,
  ): Promise<T> {
    const owner = stack[stack.length - 1];
    if (!owner) {
      return pending as Promise<T>;
    }

    const activationId = scopeState.pendingAsyncActivationIds.get(registration.id);
    if (activationId === undefined) {
      return pending as Promise<T>;
    }
    const dependency = this.getActivationById(activationId);
    this.addWait(scopeState, owner, dependency);
    return (async () => {
      try {
        return await pending as T;
      } finally {
        this.removeWait(scopeState, owner, dependency);
      }
    })();
  }

  public addWait(
    scopeState: ResolutionScopeState,
    owner: ResolutionActivation,
    dependency: ResolutionActivation,
  ): void {
    let dependencies = scopeState.pendingWaits.get(owner.id);
    if (dependencies?.has(dependency.id)) {
      return;
    }

    const path = this.findPendingWaitPath(scopeState, dependency.id, owner.id, new Set<number>());
    if (path) {
      const registrations = [owner, ...path.map((id) => this.getActivationById(id)), dependency];
      throw this.createCircularDependencyError(registrations);
    }
    if (!dependencies) {
      dependencies = new Set<number>();
      scopeState.pendingWaits.set(owner.id, dependencies);
    }
    dependencies.add(dependency.id);
  }

  public removeWait(
    scopeState: ResolutionScopeState,
    owner: ResolutionActivation,
    dependency: ResolutionActivation,
  ): void {
    const dependencies = scopeState.pendingWaits.get(owner.id);
    if (!dependencies) {
      return;
    }
    dependencies.delete(dependency.id);
    if (dependencies.size === 0) {
      scopeState.pendingWaits.delete(owner.id);
    }
  }

  private findPendingWaitPath(
    scopeState: ResolutionScopeState,
    from: number,
    target: number,
    visited: Set<number>,
  ): number[] | undefined {
    if (from === target) {
      return [from];
    }
    if (visited.has(from)) {
      return undefined;
    }
    visited.add(from);
    const dependencies = scopeState.pendingWaits.get(from);
    if (!dependencies) {
      return undefined;
    }
    for (const dependency of dependencies) {
      const path = this.findPendingWaitPath(scopeState, dependency, target, visited);
      if (path) {
        return [from, ...path];
      }
    }
    return undefined;
  }

  private getActivationById(id: number): ResolutionActivation {
    const activation = this.activeActivations.get(id);
    if (!activation) throw new Error(`Missing DI activation ${id} while reporting an async dependency cycle.`);
    return activation;
  }

  private createCircularDependencyError(activations: readonly (ResolutionActivation | ServiceRegistration)[]): CircularDependencyError {
    return new CircularDependencyError(activations.map((activation) =>
      activation instanceof ServiceRegistration ? activation.token : activation.registration.token,
    ));
  }
}
