import type { InjectionToken, ModuleConfig, ModuleExport, ProviderDefinition } from "../di";
import { redactSensitiveText } from "../../library/redaction";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

/**
 * Контракт инфраструктурного коннектора — единая форма «подключения к чему-то
 * внешнему» (БД, кэш, поисковый движок, шина). Коннектор инкапсулирует четыре
 * вещи, которые иначе пишутся руками в каждом интеграционном модуле:
 *
 * 1. **создание клиента** из конфига подсистемы ({@link create}) — коннектору
 *    передаётся типизированный `defineConfig`-объект, и он сам читает объявленные
 *    ключи (секреты раскрываются на границе, не из `process.env` напрямую);
 * 2. **открытие соединения** на старте приложения ({@link connect});
 * 3. **закрытие соединения** на остановке ({@link dispose}) — graceful shutdown;
 * 4. **health-check** ({@link healthCheck}) — для встроенного `/health`.
 *
 * Декоратор {@link Infra} разворачивает набор коннекторов в обычный global-модуль:
 * клиент регистрируется singleton под своим {@link token}, lifecycle — как
 * `HOSTED_SERVICE` (фаза по умолчанию отрицательная, чтобы инфраструктура
 * поднялась раньше серверов), health-check — как `HEALTH_CHECK`.
 * Тип подключения задаёт реализация коннектора; общего списка типов нет.
 * Имя записи манифеста используется для диагностики, клиент определяется токеном DI.
 *
 * @typeParam TClient Тип клиента, который инжектится в приложении по {@link token}.
 */
export interface InfraConnector<TClient = unknown> {
  /** Токен, под которым клиент доступен для инъекции в сервисы приложения. */
  readonly token: InjectionToken<TClient>;

  /**
   * Конфиги, которыми владеет коннектор. `@Infra` поднимает их в metadata
   * модуля, а `runApp` валидирует до старта приложения.
   */
  readonly config?: ModuleConfig | readonly ModuleConfig[];

  /**
   * Фаза старта hosted-lifecycle. Меньше — раньше стартует, позже гасится.
   * По умолчанию `-100` (как `OrmLifecycle`): инфраструктура готова до серверов.
   */
  readonly phase?: number;

  /**
   * Создаёт клиент (ещё **не** подключённый — соединение открывается в
   * {@link connect}). Конфиг подсистемы коннектор держит в себе (передан в его
   * фабрику, напр. `postgres(dbConfig)`); здесь читаются креды и валидируются
   * обязательные ключи.
   */
  create(configs?: ConfigRegistry): TClient;

  /** Открыть соединение / прогреть пул. Вызывается на старте приложения. */
  connect(client: TClient, signal?: AbortSignal): Promise<void> | void;

  /** Закрыть соединение / освободить ресурсы. Вызывается на остановке. */
  dispose(client: TClient): Promise<void> | void;

  /**
   * Проверка живости соединения для `/health`. Если не задан — health-check для
   * этого коннектора не регистрируется.
   */
  healthCheck?(client: TClient, signal?: AbortSignal): Promise<boolean> | boolean;

  /**
   * Дополнительные провайдеры, которые коннектор добавляет в инфраструктурный
   * модуль помимо самого клиента (например, `redisConnect(cfg, { cache: "distributed" })` публикует
   * распределённый кэш-бэкенд поверх клиента). Обычно `factoryProvider`,
   * ссылающийся на {@link token}. Видимость наружу — через {@link exports}.
   */
  readonly providers?: readonly ProviderDefinition[];

  /** Токены из {@link providers}, которые нужно сделать видимыми приложению. */
  readonly exports?: readonly ModuleExport[];
}

/** Ошибка конфигурации/подключения инфраструктуры. */
export class InfraError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

/** Безопасно извлекает текст ошибки (на случай, если брошено не-`Error`). */
export function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
