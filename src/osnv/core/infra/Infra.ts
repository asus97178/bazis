import {
  DI,
  HOSTED_SERVICE,
  Module,
  createToken,
  createModuleOwnedMetadataChannel,
  registerModuleOwnedProviderContributor,
  registerModuleOwnedContributionValidator,
  type ModuleConfig,
  type ModuleExport,
  type OsnvModuleRef,
  type ProviderDefinition,
} from "../di";
import { ConfigRegistry, HEALTH_CHECK } from "../kernel";
import { InfraError, type InfraConnector } from "./InfraConnector";
import { InfraLifecycle } from "./InfraLifecycle";

/**
 * Infrastructure manifest: a readable "logical name → connector" map.
 * The key (`db`, `cache`, `search`) is the instance name: it appears in the
 * health check (`infra:db`) and in diagnostics, so the manifest file reads as
 * the application's connection spec.
 */
export type InfraManifest = Readonly<Record<string, InfraConnector>>;

const instances = new WeakMap<ProviderDefinition, { name: string; token: InfraConnector["token"] }>();
const instanceChannel = createModuleOwnedMetadataChannel<{ name: string; token: InfraConnector["token"] }>("infra.instances");
registerModuleOwnedProviderContributor((metadata, context) => {
  for (const provider of metadata.providers ?? []) {
    const instance = instances.get(provider);
    if (instance) context.addMetadata(instanceChannel, instance);
  }
});
registerModuleOwnedContributionValidator((snapshot) => {
  const owners = new Map<InfraConnector["token"], string>();
  for (const { ownerName, payload } of snapshot.getMetadataContributions(instanceChannel)) {
    const name = `${ownerName}:${payload.name}`;
    const previous = owners.get(payload.token);
    if (previous !== undefined) {
      throw new InfraError(`Infra instances "${previous}" and "${name}" share the same connector token; each instance needs a distinct token.`);
    }
    owners.set(payload.token, name);
  }
});

function buildInfraDefinitions(manifest: InfraManifest): {
  providers: ProviderDefinition[];
  exports: ModuleExport[];
  config: ModuleConfig[];
} {
  const providers: ProviderDefinition[] = [];
  const exports: ModuleExport[] = [];
  const config: ModuleConfig[] = [];
  const seenConfig = new Set<ModuleConfig>();
  // One token = one singleton client. Two instances under one token would give
  // a shared client with two lifecycles (double connect/dispose), so fail loudly.
  const seenTokens = new Map<InfraConnector["token"], string>();

  for (const [name, connector] of Object.entries(manifest)) {
    if (!name.trim() || name !== name.trim()) throw new InfraError("Infra instance names must be non-empty and trimmed.");
    if (connector.phase !== undefined && !Number.isSafeInteger(connector.phase)) {
      throw new InfraError(`Infra instance "${name}": phase must be a finite safe integer.`);
    }
    const previous = seenTokens.get(connector.token);
    if (previous !== undefined) {
      throw new InfraError(
        `Infra manifest: instances "${previous}" and "${name}" share the same connector token; each instance needs a distinct token.`,
      );
    }
    seenTokens.set(connector.token, name);

    const connectorConfigs =
      connector.config === undefined ? [] : Array.isArray(connector.config) ? connector.config : [connector.config];
    for (let index = 0; index < connectorConfigs.length; index += 1) {
      const item = connectorConfigs[index] as ModuleConfig;
      if (!seenConfig.has(item)) {
        seenConfig.add(item);
        config.push(item);
      }
    }

    // DI registers the owner before the client: even an early resolution or
    // a failing factory elsewhere cannot leave a created resource without cleanup.
    const ownerToken = createToken<InfraLifecycle<unknown>>(`infra:${name}:lifetime`);
    const owner = DI.singleton(DI.factoryProviderWithResolver(ownerToken, [], (resolver) =>
      new InfraLifecycle(name, connector, undefined, resolver.has(ConfigRegistry) ? resolver.resolve(ConfigRegistry) : undefined)));
    instances.set(owner, { name, token: connector.token });
    providers.push(owner);
    providers.push(
      DI.singleton(DI.externallyOwned(DI.factoryProvider(connector.token, [ownerToken], (lifetime) => lifetime.getClient()))),
    );

    // 2. Lifecycle: opens/closes the connection in the kernel phases.
    providers.push(
      DI.singleton(
        DI.factoryProvider(HOSTED_SERVICE, [ownerToken], (lifetime) => lifetime),
      ),
    );

    // 3. Health check: only if the connector supports it.
    if (connector.healthCheck) {
      const healthCheck = connector.healthCheck.bind(connector);
      providers.push(
        DI.singleton(
          DI.factoryProvider(HEALTH_CHECK, [connector.token], (client) => ({
            name: `infra:${name}`,
            check: async (signal?: AbortSignal) => ({ healthy: await healthCheck(client, signal) }),
          })),
        ),
      );
    }

    exports.push(connector.token);

    // 4. Extra connector providers (for example a distributed cache on top of Redis).
    if (connector.providers !== undefined) {
      providers.push(...connector.providers);
    }
    if (connector.exports !== undefined) {
      exports.push(...connector.exports);
    }
  }

  return { providers, exports, config };
}

/**
 * Dynamic infrastructure module (a plain metadata object): the same as
 * `@Infra`, but without a class. Handy for `imports` or `runApp({ infra })`.
 */
export function infraModule(manifest: InfraManifest): OsnvModuleRef {
  const { providers, exports, config } = buildInfraDefinitions(manifest);
  return { global: true, providers, exports, config };
}

/**
 * Infrastructure decorator. Puts the metadata of a regular **global module**
 * on the class, so the class becomes a valid `OsnvModuleRef`: it can be passed
 * to `runApp({ infra: AppInfra })` or to `imports`.
 *
 * The class stays pure metadata (like `@Module`) and is **never instantiated**:
 * only the clients it lists live and hold state.
 *
 * ```ts
 * @Infra({
 *   db: postgres(dbConfig),
 *   cache: redisConnect(redisConfig),
 *   search: openSearchConnect(searchConfig),
 * })
 * export class AppInfra {}
 * ```
 */
export function Infra(manifest: InfraManifest) {
  const { providers, exports, config } = buildInfraDefinitions(manifest);
  return (target: abstract new (...args: never) => unknown, _context: ClassDecoratorContext): void => {
    Module({ global: true, providers, exports, config })(target, _context);
  };
}
