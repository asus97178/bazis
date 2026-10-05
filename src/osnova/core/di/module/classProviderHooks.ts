import { createToken, type Class, type Token } from "../token";
import { ProviderDefinition, isClassProvider, isValueProvider, type ProviderDependencyList } from "../provider";

export type ClassProviderLifetime = "singleton" | "scoped" | "transient";

export interface ClassProviderRegistration {
  readonly lifetime: ClassProviderLifetime;
  readonly provide: Token<unknown>;
  readonly useClass: Class<unknown>;
  readonly deps: ProviderDependencyList | undefined;
}

export type ClassProviderHook = (request: ClassProviderRegistration) => ProviderDefinition | undefined;

/** Container-local build extension. Register an unkeyed singleton value, not a runtime factory. */
export const CLASS_PROVIDER_HOOK = createToken<ClassProviderHook>("ClassProviderHook");

export function collectClassProviderHooks(definitions: readonly ProviderDefinition[]): readonly ClassProviderHook[] {
  const hooks = new Set<ClassProviderHook>();
  for (const definition of definitions) {
    if (definition.provider.provide !== CLASS_PROVIDER_HOOK) continue;
    if (definition.lifetime !== "singleton" || definition.key !== undefined
      || !isValueProvider(definition.provider) || typeof definition.provider.useValue !== "function") {
      throw new TypeError("ClassProviderHook requires an unkeyed singleton value provider.");
    }
    hooks.add(definition.provider.useValue as ClassProviderHook);
  }
  return [...hooks];
}

const classProviderHooks: ClassProviderHook[] = [];

/** Legacy explicitly process-wide extension. Prefer CLASS_PROVIDER_HOOK for independent containers. */
export function registerClassProviderHook(hook: ClassProviderHook): void {
  classProviderHooks.push(hook);
}

export function applyClassProviderHooks(
  request: ClassProviderRegistration,
  hooks: readonly ClassProviderHook[] = classProviderHooks,
): ProviderDefinition | undefined {
  for (let index = 0; index < hooks.length; index += 1) {
    const result = hooks[index]!(request);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/** Applies hooks when a definition enters a collection, not only when shortcut syntax created it. */
export function applyClassProviderHooksToDefinition(
  definition: ProviderDefinition,
  hooks: readonly ClassProviderHook[] = classProviderHooks,
): ProviderDefinition {
  if (!isClassProvider(definition.provider) || definition.provider.activation !== undefined) {
    return definition;
  }
  const hooked = applyClassProviderHooks({
    lifetime: definition.lifetime,
    provide: definition.provider.provide,
    useClass: definition.provider.useClass,
    deps: definition.provider.deps,
  }, hooks);
  if (hooked === undefined) {
    return definition;
  }
  // A hook changes the implementation, not the keyed-registration identity.
  return new ProviderDefinition(
    { ...hooked.provider, ...(definition.provider.ownership ? { ownership: definition.provider.ownership } : {}) },
    hooked.lifetime, definition.key ?? hooked.key,
  );
}
