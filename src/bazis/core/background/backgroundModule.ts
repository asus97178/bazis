import {
  DI,
  HOSTED_SERVICE,
  Module,
  singleton,
  type Class,
  type HostedService,
  type BazisModule,
  type ProviderDefinition,
} from "../di";

export interface BackgroundModuleConfig {
  /**
   * Background service classes (subclasses of `BackgroundService` /
   * `PeriodicBackgroundService`). Each is registered as a singleton (with
   * auto-resolved constructor dependencies) and exposed as a `HOSTED_SERVICE`,
   * so the kernel starts and gracefully stops it with the rest of the app.
   */
  readonly services: readonly Class<HostedService>[];
}

/**
 * Registers background services in DI and wires them into the kernel lifecycle.
 *
 * ```ts
 * @Module({ imports: [backgroundModule({ services: [SessionCleanup, Heartbeat] })] })
 * class AppModule {}
 * ```
 */
export function backgroundModule(config: BackgroundModuleConfig): BazisModule {
  const providers: ProviderDefinition[] = config.services.flatMap((ServiceClass) => [
    singleton(ServiceClass),
    DI.singleton(
      DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => resolver.resolve(ServiceClass)),
    ),
  ]);

  @Module({ providers })
  class BackgroundModule {}

  return BackgroundModule;
}
