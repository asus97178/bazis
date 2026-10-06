import type { Token } from "../token";

export interface NamedDependencyEncapsulationContext {
  readonly depName: string;
  readonly consumer: string;
  readonly moduleName: string;
  readonly visible: ReadonlySet<Token<unknown>>;
  readonly familiesVisible: ReadonlySet<symbol>;
}

/**
 * Return `true` when the named dependency is allowed despite encapsulation rules.
 * Return `undefined` to fall through to default DI validation.
 */
export type NamedDependencyEncapsulationHook = (
  context: NamedDependencyEncapsulationContext,
) => boolean | undefined;

const namedDependencyHooks: NamedDependencyEncapsulationHook[] = [];

/** Infrastructure extensions (ORM open generics, …) plug in named-dep rules here. */
export function registerNamedDependencyEncapsulationHook(hook: NamedDependencyEncapsulationHook): void {
  namedDependencyHooks.push(hook);
}

export function applyNamedDependencyEncapsulationHooks(
  context: NamedDependencyEncapsulationContext,
): boolean {
  for (let index = 0; index < namedDependencyHooks.length; index += 1) {
    const result = namedDependencyHooks[index]!(context);
    if (result === true) {
      return true;
    }
  }
  return false;
}
