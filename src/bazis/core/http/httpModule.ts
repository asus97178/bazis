import { HOSTED_SERVICE, Module, SERVICE_PROVIDER, collectModuleControllers, type BazisModule, type ProviderDefinition } from "../di";
import { DI } from "../di/lowLevel";
import { HttpServer } from "./HttpServer";
import { httpConfig } from "./Http.config";
import type { HttpModuleOptions, HttpServerOptions } from "./options";

/**
 * Builds the HTTP module: discovers the `controllers` of the modules in
 * `imports` and registers the HttpServer hosted service. The address comes from
 * {@link httpConfig} unless the options fix it.
 *
 * ```ts
 * @Module({
 *   controllers: [UsersController],
 *   providers: [scoped(IUserStore, UserService)],
 * })
 * export class UsersModule {}
 *
 * @App({ modules: [UsersModule], http: { prefix: "api" } })
 * export class Application {}
 *
 * await runApp(Application);
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
    config: httpConfig,
    providers,
  })
  class HttpModule {}

  return HttpModule;
}
