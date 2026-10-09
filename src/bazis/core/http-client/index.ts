/**
 * Core DI/correlation integration for the pure `@/library/http-client`.
 *
 * The HTTP engine lives in the library (framework-agnostic). This module only
 * wires it into the runtime: DI tokens, a module factory, and kernel-based
 * correlation propagation. All library symbols are re-exported for convenience.
 *
 * ```ts
 * import { httpClientModule, HTTP_CLIENT } from "@/core/http-client";
 *
 * @Module({ imports: [httpClientModule({ default: { baseUrl: "https://api" } })] })
 * class AppModule {}
 * ```
 */
import { DI, Module, createToken, type BazisModule, type ProviderDefinition } from "../di";
import { getOutboundCorrelationHeaders } from "../kernel";
import {
  HttpClient,
  HttpClientFactory,
  HttpClientFactoryBuilder,
  type HeaderBag,
  type RequestConfig,
} from "../../library/http-client";

export * from "../../library/http-client";

/** Named-clients factory token. */
export const HTTP_CLIENT_FACTORY = createToken<HttpClientFactory>("IHttpClientFactory");
/** Default injectable {@link HttpClient} token. */
export const HTTP_CLIENT = createToken<HttpClient>("HttpClient");

export interface HttpClientModuleConfig {
  /** Named clients resolvable via `HTTP_CLIENT_FACTORY.createClient(name)`. */
  readonly clients?: Readonly<Record<string, RequestConfig>>;
  /** Defaults for the injectable {@link HTTP_CLIENT} and `createClient()`. */
  readonly default?: RequestConfig;
  /** Correlation header source. Default: the kernel async request context. */
  readonly correlationHeaders?: () => HeaderBag;
  /** Default per-request timeout in ms (server-side safety). Default: 30000. */
  readonly timeoutMs?: number;
  /** Default maximum response body size. Default: 16 MiB. `0` disables it. */
  readonly maxResponseBytes?: number;
}

/**
 * Registers the outbound HTTP client in DI with correlation propagation wired
 * to the kernel request context. A service takes it by type:
 * - `HttpClient` (or the {@link HTTP_CLIENT} token) — the default client;
 * - `HttpClientFactory` (or {@link HTTP_CLIENT_FACTORY}) — named clients
 *   (fail-fast on unknown names).
 */
export function httpClientModule(config: HttpClientModuleConfig = {}): BazisModule {
  const correlationHeaders = config.correlationHeaders ?? getOutboundCorrelationHeaders;
  const moduleTimeoutMs = resolveLimit(config.timeoutMs, 30_000, "httpClientModule timeoutMs");
  const moduleMaxResponseBytes = resolveLimit(
    config.maxResponseBytes,
    16 * 1024 * 1024,
    "httpClientModule maxResponseBytes",
  );
  const defaultConfig = config.default ?? {};
  const defaults: RequestConfig = {
    ...defaultConfig,
    timeoutMs: resolveLimit(defaultConfig.timeoutMs, moduleTimeoutMs, "httpClientModule default.timeoutMs"),
    maxResponseBytes: resolveLimit(
      defaultConfig.maxResponseBytes,
      moduleMaxResponseBytes,
      "httpClientModule default.maxResponseBytes",
    ),
    correlationHeaders: defaultConfig.correlationHeaders ?? correlationHeaders,
  };

  const builder = new HttpClientFactoryBuilder();
  builder.useDefault(defaults);
  for (const [name, clientConfig] of Object.entries(config.clients ?? {})) {
    builder.addClient(name, {
      ...clientConfig,
      timeoutMs: resolveLimit(clientConfig.timeoutMs, defaults.timeoutMs!, `httpClientModule clients.${name}.timeoutMs`),
      maxResponseBytes: resolveLimit(
        clientConfig.maxResponseBytes,
        defaults.maxResponseBytes!,
        `httpClientModule clients.${name}.maxResponseBytes`,
      ),
    });
  }
  const factory = builder.build();

  const client = factory.createClient();
  // One factory and one default client, under the class (injection by type)
  // and under the original tokens.
  const providers: ProviderDefinition[] = [
    DI.singleton(DI.valueProvider(HttpClientFactory, factory)),
    DI.singleton(DI.valueProvider(HTTP_CLIENT_FACTORY, factory)),
    DI.singleton(DI.valueProvider(HttpClient, client)),
    DI.singleton(DI.valueProvider(HTTP_CLIENT, client)),
  ];

  @Module({ providers })
  class HttpClientModule {}

  return HttpClientModule;
}

function resolveLimit(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return resolved;
}
