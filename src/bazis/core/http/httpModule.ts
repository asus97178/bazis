import { DI, HOSTED_SERVICE, Module, SERVICE_PROVIDER, collectModuleControllers, type BazisModule, type ProviderDefinition } from "../di";
import { HttpServer } from "./HttpServer";
import type { HttpModuleOptions, HttpServerOptions } from "./options";

/**
 * Builds the HTTP module: discovers the `controllers` of the modules in
 * `imports` and registers the HttpServer hosted service.
 *
 * ```ts
 * @Module({
 *   controllers: [UsersController],
 *   providers: [scoped(IUserStore, UserService, [repositoryFor(User)] as const)],
 * })
 * export class UsersModule {}
 *
 * export const AppModule = createApp({
 *   imports: [UsersModule],
 *   http: { port: 3000, prefix: "api" },
 * }).module;
 *
 * await Bazis.run(AppModule);
 * ```
 */
export function httpModule(options: HttpModuleOptions): BazisModule {
  const serverOptions: HttpServerOptions = {
    ...options,
    controllers: collectModuleControllers(options.imports ?? []),
  };

  const providers: ProviderDefinition[] = [
    DI.singleton(
      DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => {
        return new HttpServer(serverOptions, resolver.resolve(SERVICE_PROVIDER), resolver);
      }),
    ),
  ];

  @Module({
    imports: options.imports,
    providers,
  })
  class HttpModule {}

  return HttpModule;
}
