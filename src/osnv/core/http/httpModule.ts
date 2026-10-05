import { DI, HOSTED_SERVICE, Module, SERVICE_PROVIDER, collectModuleControllers, type OsnvModule, type ProviderDefinition } from "../di";
import { HttpServer } from "./HttpServer";
import type { HttpModuleOptions } from "./options";

/**
 * Builds the HTTP module: discovers controllers from `imports` (and optional
 * `controllers` on feature modules) and registers the HttpServer hosted service.
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
 * await Osnv.run(AppModule);
 * ```
 */
export function httpModule(options: HttpModuleOptions): OsnvModule {
  const allControllers = collectModuleControllers(options.imports ?? [], options.controllers);

  const serverOptions: HttpModuleOptions = {
    ...options,
    controllers: allControllers,
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
    controllers: options.controllers,
  })
  class HttpModule {}

  return HttpModule;
}
