import { DI, registerModuleMetadataExpander, type BazisModuleMetadata, type BazisModuleRef, type ServiceResolver } from "../di";
import type { ConfigDefinition } from "../kernel";
import type { GrpcClientOptions } from "./clientContracts";
import { GrpcClientBase } from "./GrpcClientBase";
import { GrpcSetupError } from "./GrpcSetupError";
import type { ServiceDefinition } from "./serviceDefinition";

/** The settings of a client in the configuration: the address and, if declared, the timeout. */
export interface GrpcClientConfig {
  address: string;
  timeoutMs?: number;
}

/** Fixed options of a client, and the configuration its address and timeout come from. */
export interface GrpcClientDeclaration extends Partial<GrpcClientOptions> {
  readonly config?: ConfigDefinition<GrpcClientConfig>;
}

type GrpcClientClass = new (service: ServiceDefinition, options: GrpcClientOptions) => GrpcClientBase;

const declarations = new WeakMap<object, { readonly service: ServiceDefinition; readonly declaration: GrpcClientDeclaration }>();

/**
 * A client of another gRPC service, declared like a controller: the class
 * extends `GrpcClientBase`, the module lists it in `grpcClients`, and services
 * take it by type. The framework creates it with the address and timeout of
 * `config` and closes it when the application stops.
 *
 * ```ts
 * @GrpcClient(UsersRpc, { config: usersRpcConfig })
 * export class UsersClient extends GrpcClientBase {}
 *
 * @Module({ grpcClients: [UsersClient], providers: [scoped(UsersApi)] })
 * export class ReportsModule {}
 * ```
 */
export function GrpcClient(service: ServiceDefinition, declaration: GrpcClientDeclaration = {}) {
  return (target: GrpcClientClass, _context: ClassDecoratorContext): void => {
    declarations.set(target, { service, declaration });
  };
}

registerModuleMetadataExpander((metadata: BazisModuleMetadata): readonly BazisModuleRef[] => {
  const clients = (metadata as BazisModuleMetadata & { readonly grpcClients?: unknown }).grpcClients;
  if (clients === undefined) return [];
  const owner = typeof metadata === "function" ? (metadata as { name: string }).name : "<module>";
  if (!Array.isArray(clients)) throw new GrpcSetupError(`${owner}: grpcClients must list classes declared with @GrpcClient.`);
  const configs = new Set<ConfigDefinition<GrpcClientConfig>>();
  const providers = clients.map((client: unknown) => {
    const found = typeof client === "function" ? declarations.get(client) : undefined;
    if (found === undefined || !((client as GrpcClientClass).prototype instanceof GrpcClientBase)) {
      throw new GrpcSetupError(`${owner}: ${typeof client === "function" ? client.name : String(client)} in grpcClients must extend GrpcClientBase and be declared with @GrpcClient(service, …).`);
    }
    if (found.declaration.config !== undefined) configs.add(found.declaration.config);
    const Client = client as GrpcClientClass;
    return DI.singleton(DI.factoryProviderWithResolver(Client, [], (resolver) => new Client(found.service, optionsOf(Client.name, found.declaration, resolver))));
  });
  return [{ config: [...configs], providers, exports: clients }];
});

function optionsOf(name: string, declaration: GrpcClientDeclaration, resolver: ServiceResolver): GrpcClientOptions {
  const { config, ...fixed } = declaration;
  const settings = config === undefined ? {} : {
    address: resolver.resolve(config.token).get("address"),
    ...(config.has("timeoutMs") ? { timeoutMs: resolver.resolve(config.token).get("timeoutMs") } : {}),
  };
  const options = { ...fixed, ...settings };
  if (typeof options.address !== "string" || options.address === "") throw new GrpcSetupError(`${name}: the gRPC client needs an address: in @GrpcClient(…, { address }) or in its config.`);
  return options as GrpcClientOptions;
}

// Augment the declaring file, not the "../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../di/module/types/BazisModule" {
  interface BazisModuleMetadata {
    /** Clients of other gRPC services, declared with `@GrpcClient`: injected by their class. */
    readonly grpcClients?: readonly (abstract new (...args: never[]) => GrpcClientBase)[];
  }
}
