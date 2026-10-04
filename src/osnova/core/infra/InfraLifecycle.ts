import type { HostedService } from "../di";
import { InfraError, type InfraConnector } from "./InfraConnector";
import { bindConnectorLifecycle } from "./connectorIdentity";
import { awaitAbortable } from "../kernel/internal/awaitAbortable";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

const DEFAULT_INFRA_PHASE = -100;

/**
 * Hosted-сервис, который оборачивает {@link InfraConnector} в жизненный цикл
 * ядра: открывает соединение на старте и закрывает на остановке. Один lifecycle
 * на коннектор. DI владеет lifecycle даже при разрешении клиента до старта.
 *
 * Фаза берётся из коннектора (по умолчанию отрицательная), чтобы соединения
 * поднялись раньше HTTP-сервера и фоновых задач, а гасились — после них.
 */
export class InfraLifecycle<TClient> implements HostedService {
  public readonly phase: number;
  private client?: TClient;
  private created = false;
  private disposed = false;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;

  public constructor(
    private readonly name: string,
    private readonly connector: InfraConnector<TClient>,
    client?: TClient,
    private readonly configs?: ConfigRegistry,
  ) {
    this.client = client;
    this.created = client !== undefined;
    this.phase = connector.phase ?? DEFAULT_INFRA_PHASE;
    bindConnectorLifecycle(connector, this);
  }

  public getClient(): TClient {
    if (this.disposed) throw new InfraError(`Infra connector "${this.name}" is already disposed.`);
    if (!this.created) {
      this.client = this.connector.create(this.configs);
      this.created = true;
    }
    return this.client as TClient;
  }

  public start(signal?: AbortSignal): Promise<void> {
    this.startPromise ??= Promise.resolve().then(() => this.connect(signal));
    return this.startPromise;
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      const client = this.getClient();
      await awaitAbortable(Promise.resolve(this.connector.connect(client, signal)), signal);
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Infra connector "${this.name}" failed to start and rollback also failed.`,
        );
      }
      throw error;
    }
  }

  public stop(): Promise<void> {
    return this.dispose();
  }

  public dispose(): Promise<void> {
    this.disposed = true;
    this.disposePromise ??= Promise.resolve().then(async () => {
      if (this.created) await this.connector.dispose(this.client as TClient);
    });
    return this.disposePromise;
  }

  /** Имя инстанса инфраструктуры (ключ в манифесте `@Infra`) — для диагностики. */
  public get instanceName(): string {
    return this.name;
  }
}
