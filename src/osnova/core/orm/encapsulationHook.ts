import { registerNamedDependencyEncapsulationHook } from "../di/module/encapsulationHooks";
import { IRepository } from "./repository";

let registered = false;

/** Allows closed `IRepository<Entity>` named deps when the module exports open generic `IRepository`. */
export function registerRepositoryEncapsulationHook(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerNamedDependencyEncapsulationHook(({ depName, familiesVisible }) => {
    if (depName.startsWith("IRepository<") && familiesVisible.has(IRepository.id)) {
      return true;
    }
    return undefined;
  });
}

/** @internal Test helper. */
export function resetRepositoryEncapsulationHookForTests(): void {
  registered = false;
}
