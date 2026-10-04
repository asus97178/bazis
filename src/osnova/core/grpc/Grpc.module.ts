import { DI, DiContainer, HOSTED_SERVICE, Module, SERVICE_PROVIDER, type OsnovaModule } from "../di";
import type { GrpcModuleOptions } from "./contracts";
import { GrpcServer } from "./GrpcServer";
import { collectGrpcControllers, GRPC_CONTROLLERS } from "./moduleControllers";

/** gRPC counterpart of httpModule: controllers belong to their feature modules. */
export function grpcModule(options: GrpcModuleOptions = {}): OsnovaModule {
  const selected = collectGrpcControllers(options.imports ?? [], options.controllers);
  @Module({
    imports: options.imports,
    grpcControllers: options.controllers,
    providers: [DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => {
      const container = resolver.resolve(SERVICE_PROVIDER);
      if (!(container instanceof DiContainer)) throw new TypeError("gRPC requires a module DI container.");
      const controllers = container.getModuleOwnedProviderContributions(GRPC_CONTROLLERS)
        .filter((entry) => selected.has(entry.payload.controller));
      return new GrpcServer(options, container, controllers);
    }))],
    exports: [],
  })
  class GrpcModule {}
  return GrpcModule;
}
