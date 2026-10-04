import { singletonFactory, type ProviderDefinition, type Token } from "../di";
import { GrpcClient } from "./GrpcClient";
import type { GrpcClientOptions } from "./clientContracts";
import type { ServiceDefinition } from "./serviceDefinition";

/** Container-owned singleton: lazy network connection and automatic dispose(). */
export function grpcClientProvider(service: ServiceDefinition, options: GrpcClientOptions, token: Token<GrpcClient> = GrpcClient): ProviderDefinition<GrpcClient> {
  return singletonFactory(token, [], () => new GrpcClient(service, options));
}
