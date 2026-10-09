import { ServiceValidationError } from "../errors";
import { isLazyDependency, isNamedDependency, isOptionalDependency } from "../provider";
import type {
  KeyedDependency,
  NamedDependency,
  Provider,
  ProviderDependencyList,
  ProviderLifetime,
} from "../provider";
import { tokenToDebugName, type Token } from "../token";
import type { ServiceKey } from "../types";
import type { ServiceRegistration } from "./ServiceRegistration";

/**
 * Everything the build-time graph validator needs from the container, exposed as
 * a narrow context so {@link GraphValidator} stays independent of the container's
 * private resolution internals (and unit-testable on its own).
 */
export interface GraphValidationContext {
  readonly validateScopes: boolean;
  registrationGroups(): Iterable<readonly ServiceRegistration[]>;
  /** Materializes every open generic against the registered tokens, collecting factory failures. */
  eagerlyMaterializeOpenGenerics(issues: Set<string>): void;
  dependencies(provider: Provider<unknown>): ProviderDependencyList;
  /** Constructor arity vs declared deps for class providers; `undefined` for non-class providers. */
  classShape(provider: Provider<unknown>): { readonly required: number; readonly declared: number } | undefined;
  /** True when some registration carries this name (for optional named dependencies). */
  hasName(name: string): boolean;
  describeDependency(
    dependency: Token<unknown> | KeyedDependency<unknown> | NamedDependency<unknown>,
  ): { readonly token: Token<unknown>; readonly key: ServiceKey | undefined };
  findRegistration(token: Token<unknown>, key: ServiceKey | undefined): ServiceRegistration | undefined;
}

/**
 * Static (build-time) graph validation: detects cycles, missing dependencies,
 * captive dependencies (singleton -> scoped) and class arity mismatches, then
 * reports every problem at once via {@link ServiceValidationError}. Runs once on
 * `validateOnBuild`; the resolution hot path never touches this code.
 */
export class GraphValidator {
  public constructor(private readonly context: GraphValidationContext) {}

  public validate(): void {
    const issues = new Set<string>();
    this.context.eagerlyMaterializeOpenGenerics(issues);
    for (const registrations of this.context.registrationGroups()) {
      for (let index = 0; index < registrations.length; index += 1) {
        const registration = registrations[index] as ServiceRegistration;
        this.validateRegistration(registration, registration.lifetime, [], new Set<number>(), issues);
      }
    }

    if (issues.size > 0) {
      throw new ServiceValidationError([...issues]);
    }
  }

  private validateRegistration(
    registration: ServiceRegistration,
    rootLifetime: ProviderLifetime,
    tokenPath: Token<unknown>[],
    registrationPath: Set<number>,
    issues: Set<string>,
  ): void {
    if (registrationPath.has(registration.id)) {
      const cyclePath = [...tokenPath, registration.token].map((token) => tokenToDebugName(token)).join(" -> ");
      issues.add(`Cycle detected: ${cyclePath}`);
      return;
    }

    const shape = this.context.classShape(registration.provider);
    if (shape && shape.required > shape.declared) {
      issues.add(
        `Class provider "${tokenToDebugName(registration.token)}" requires at least ${shape.required} constructor deps, but only ${shape.declared} declared. Constructor dependencies are wired by codegen: if the constructor was added or changed after the last run, run \`bazis codegen\` (bazis dev, bazis test and bazis build run it automatically); otherwise pass the deps explicitly.`,
      );
    }

    const deps = this.context.dependencies(registration.provider);
    if (deps.length === 0) {
      return;
    }

    registrationPath.add(registration.id);
    tokenPath.push(registration.token);
    try {
      for (let index = 0; index < deps.length; index += 1) {
        const dependency = deps[index];
        if (dependency === undefined) {
          continue;
        }
        const isLazy = isLazyDependency(dependency);
        const isOptional = isOptionalDependency(dependency);
        const inner = isLazy || isOptional ? dependency.inner : dependency;
        // An optional dependency on a name nothing registered is simply absent.
        if (isOptional && isNamedDependency(inner) && !this.context.hasName(inner.name)) {
          continue;
        }
        const descriptor = this.context.describeDependency(inner);
        const depRegistration = this.context.findRegistration(descriptor.token, descriptor.key);
        if (!depRegistration && isOptional) {
          continue;
        }
        if (!depRegistration) {
          issues.add(
            `Missing dependency "${tokenToDebugName(descriptor.token)}" for "${tokenToDebugName(registration.token)}"`,
          );
          continue;
        }

        if (this.context.validateScopes && rootLifetime === "singleton" && depRegistration.lifetime === "scoped") {
          issues.add(
            `Singleton "${tokenToDebugName(registration.token)}" depends on scoped "${tokenToDebugName(descriptor.token)}". `
              + `A scoped service lives for one request or scope: make "${tokenToDebugName(registration.token)}" scoped too, `
              + `or inject ServiceProvider and resolve "${tokenToDebugName(descriptor.token)}" in a scope you create (provider.createScope()).`,
          );
        }

        // Lazy edges defer creation to first access, so they cannot deadlock
        // construction: validate existence above, but do not traverse them.
        if (isLazy) {
          continue;
        }

        this.validateRegistration(depRegistration, rootLifetime, tokenPath, registrationPath, issues);
      }
    } finally {
      tokenPath.pop();
      registrationPath.delete(registration.id);
    }
  }
}
