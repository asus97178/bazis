import type { InjectionToken, ModuleConfig, ModuleExport, ProviderDefinition } from "../di";
import { redactSensitiveText } from "../../library/redaction";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

/**
 * Infrastructure connector contract: one shape for "a connection to something
 * external" (a database, cache, search engine, bus). A connector encapsulates
 * four things that would otherwise be hand-written in every integration module:
 *
 * 1. **creating the client** from the subsystem config ({@link create}): the
 *    connector gets a typed `defineConfig` object and reads the declared keys
 *    itself (secrets are revealed at the boundary, not read from `process.env`);
 * 2. **opening the connection** at application start ({@link connect});
 * 3. **closing the connection** at shutdown ({@link dispose}): graceful shutdown;
 * 4. **health check** ({@link healthCheck}) for the built-in `/health`.
 *
 * The {@link Infra} decorator expands a set of connectors into a regular global
 * module: the client is registered as a singleton under its {@link token}, the
 * lifecycle as a `HOSTED_SERVICE` (the default phase is negative so that
 * infrastructure starts before the servers), the health check as `HEALTH_CHECK`.
 * The connector implementation defines the connection type; there is no common
 * list of types. The manifest entry name is used for diagnostics; the client is
 * identified by its DI token.
 *
 * @typeParam TClient Type of the client injected in the application by {@link token}.
 */
export interface InfraConnector<TClient = unknown> {
  /** Token under which the client is available for injection into application services. */
  readonly token: InjectionToken<TClient>;

  /**
   * Configs owned by the connector. `@Infra` lifts them into the module
   * metadata, and `runApp` validates them before the application starts.
   */
  readonly config?: ModuleConfig | readonly ModuleConfig[];

  /**
   * Start phase of the hosted lifecycle. Lower starts earlier and stops later.
   * Defaults to `-100`, so infrastructure is ready before the servers.
   */
  readonly phase?: number;

  /**
   * Creates the client (**not** connected yet: the connection is opened in
   * {@link connect}). The connector keeps the subsystem config itself (it was
   * passed to its factory, e.g. `postgres(dbConfig)`); this is where
   * credentials are read and required keys are validated.
   */
  create(configs?: ConfigRegistry): TClient;

  /** Opens the connection / warms up the pool. Called at application start. */
  connect(client: TClient, signal?: AbortSignal): Promise<void> | void;

  /** Closes the connection / releases resources. Called at shutdown. */
  dispose(client: TClient): Promise<void> | void;

  /**
   * Connection liveness check for `/health`. If not set, no health check is
   * registered for this connector.
   */
  healthCheck?(client: TClient, signal?: AbortSignal): Promise<boolean> | boolean;

  /**
   * Extra providers the connector adds to the infrastructure module besides
   * the client itself (for example `redisConnect(cfg, { cache: "distributed" })`
   * publishes a distributed cache backend on top of the client). Usually a
   * `factoryProvider` that refers to {@link token}. Exposed through {@link exports}.
   */
  readonly providers?: readonly ProviderDefinition[];

  /** Tokens from {@link providers} to make visible to the application. */
  readonly exports?: readonly ModuleExport[];
}

/** Infrastructure configuration/connection error. */
export class InfraError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

/** Safely extracts the error text (in case a non-`Error` was thrown). */
export function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
