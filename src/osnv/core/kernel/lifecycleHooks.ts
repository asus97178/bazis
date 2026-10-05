import type { ServiceCollection } from "../di";
import { createToken } from "../di";
import type { LifecycleHook } from "./types";

/**
 * Enumerable token for lifecycle hooks. Register any number of them:
 * `singleton(LIFECYCLE_HOOK, MyHook)` in a module or `addLifecycleHook(...)`
 * on a collection.
 */
export const LIFECYCLE_HOOK = createToken<LifecycleHook>("OsnvLifecycleHook");

export function addLifecycleHook(services: ServiceCollection, factory: () => LifecycleHook): void {
  services.addSingleton({
    provide: LIFECYCLE_HOOK,
    useFactory: factory,
    deps: [],
  });
}
