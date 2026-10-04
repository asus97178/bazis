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
  type OsnovaModuleRef,
  type ProviderDefinition,
} from "../di";
import { ConfigRegistry, HEALTH_CHECK } from "../kernel";
import { InfraError, type InfraConnector } from "./InfraConnector";
import { InfraLifecycle } from "./InfraLifecycle";

/**
 * Манифест инфраструктуры: читаемая карта «логическое имя → коннектор».
 * Ключ (`db`, `cache`, `search`) — это имя инстанса: оно попадает в
 * health-check (`infra:db`) и диагностику, поэтому файл с манифестом
 * читается как спецификация подключений приложения.
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
  // Один токен = один клиент-singleton. Два инстанса под одним токеном дали бы
  // общий клиент с двумя lifecycle (двойной connect/dispose) — падаем явно.
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

    // DI регистрирует владельца раньше клиента: даже ранняя резолюция или
    // исключение другой фабрики не оставляют созданный ресурс без cleanup.
    const ownerToken = createToken<InfraLifecycle<unknown>>(`infra:${name}:lifetime`);
    const owner = DI.singleton(DI.factoryProviderWithResolver(ownerToken, [], (resolver) =>
      new InfraLifecycle(name, connector, undefined, resolver.has(ConfigRegistry) ? resolver.resolve(ConfigRegistry) : undefined)));
    instances.set(owner, { name, token: connector.token });
    providers.push(owner);
    providers.push(
      DI.singleton(DI.externallyOwned(DI.factoryProvider(connector.token, [ownerToken], (lifetime) => lifetime.getClient()))),
    );

    // 2. Lifecycle — открывает/закрывает соединение в фазах ядра.
    providers.push(
      DI.singleton(
        DI.factoryProvider(HOSTED_SERVICE, [ownerToken], (lifetime) => lifetime),
      ),
    );

    // 3. Health-check — только если коннектор его поддерживает.
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

    // 4. Доп. провайдеры коннектора (например, распределённый кэш поверх Redis).
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
 * Динамический инфраструктурный модуль (plain-объект метаданных) — то же, что
 * `@Infra`, но без класса. Удобно для `imports` или для `runApp({ infra })`.
 */
export function infraModule(manifest: InfraManifest): OsnovaModuleRef {
  const { providers, exports, config } = buildInfraDefinitions(manifest);
  return { global: true, providers, exports, config };
}

/**
 * Собирательный декоратор инфраструктуры. Вешает на класс метаданные обычного
 * **global-модуля**, поэтому класс становится валидным `OsnovaModuleRef` —
 * его можно передать в `runApp({ infra: AppInfra })` или в `imports`.
 *
 * Класс остаётся чистыми метаданными (как `@Module`) и **не инстанцируется**:
 * живут и держат состояние только клиенты, которые он перечисляет.
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
