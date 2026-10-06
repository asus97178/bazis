/**
 * Granular lifecycle hooks (NestJS-style), discovered without reflection:
 * register implementations under the LIFECYCLE_HOOK token (enumerable).
 *
 * Order: hooks run in module registration order (imports are loaded before
 * the importing module, so the order is topological by the import graph).
 * Shutdown hooks run in reverse.
 */
export interface LifecycleHook {
  /** Before hosted services start (resources, caches, migrations). */
  onInit?(): void | Promise<void>;
  /** After every hosted service has started. */
  onBootstrap?(): void | Promise<void>;
  /** Graceful shutdown began; hosted services are already stopped. */
  onShutdown?(signal?: string): void | Promise<void>;
  /** Final cleanup right before the container is disposed. */
  onDestroy?(): void | Promise<void>;
}
