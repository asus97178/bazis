import type { HostedService, HostedServiceDiagnostics } from "../di";
import { InfraError, type InfraConnector } from "./InfraConnector";
import { bindConnectorLifecycle } from "./connectorIdentity";
import { awaitAbortable } from "../kernel/internal/awaitAbortable";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

const DEFAULT_INFRA_PHASE = -100;

/**
 * Hosted service that wraps an {@link InfraConnector} into the kernel
 * lifecycle: opens the connection at start and closes it at shutdown. One
 * lifecycle per connector. DI owns the lifecycle even when the client is
 * resolved before start.
 *
 * The phase comes from the connector (negative by default), so connections
 * come up before the HTTP server and background tasks and go down after them.
 */
export class InfraLifecycle<TClient> implements HostedService {
  public readonly phase: number;
  /** The manifest key, as in `/health`: `infra:db`. */
  public readonly diagnosticName: string;
  private client?: TClient;
  private created = false;
  private disposed = false;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private diagnostics?: HostedServiceDiagnostics;

  public constructor(
    private readonly name: string,
    private readonly connector: InfraConnector<TClient>,
    client?: TClient,
    private readonly configs?: ConfigRegistry,
  ) {
    this.client = client;
    this.created = client !== undefined;
    this.phase = connector.phase ?? DEFAULT_INFRA_PHASE;
    this.diagnosticName = `infra:${name}`;
    bindConnectorLifecycle(connector, this);
  }

  public getClient(): TClient {
    if (this.disposed) throw new InfraError(`Infra connector "${this.name}" is already disposed.`);
    if (!this.created) {
      this.client = this.connector.create(this.configs);
      this.created = true;
      this.forwardDiagnostics();
    }
    return this.client as TClient;
  }

  /** The application logger reaches a client that reports on its own, such as `llmRouter` falling back. */
  public useDiagnostics(diagnostics: HostedServiceDiagnostics): void {
    this.diagnostics = diagnostics;
    if (this.created) this.forwardDiagnostics();
  }

  private forwardDiagnostics(): void {
    const client = this.client as { useDiagnostics?: (diagnostics: HostedServiceDiagnostics) => void } | undefined;
    if (this.diagnostics !== undefined && typeof client?.useDiagnostics === "function") client.useDiagnostics(this.diagnostics);
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

  /** Infrastructure instance name (the key in the `@Infra` manifest), for diagnostics. */
  public get instanceName(): string {
    return this.name;
  }
}
