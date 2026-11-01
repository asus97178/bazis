import { DI, registerModuleMetadataExpander, type BazisModuleMetadata, type BazisModuleRef, type ServiceResolver } from "../di";
import { getOutboundCorrelationHeaders, type ConfigDefinition } from "../kernel";
import { HttpClientBase, HttpClientError, type RequestConfig } from "../../library/http-client";

/** The settings of a client in the configuration: the base URL and, if declared, the limits. */
export interface HttpClientConfig {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Fixed request defaults of a client, and the configuration its base URL and limits come from. */
export interface HttpClientDeclaration extends RequestConfig {
  readonly config?: ConfigDefinition<HttpClientConfig>;
}

type HttpClientClass = new (defaults: RequestConfig) => HttpClientBase;

/** Server-side safety defaults of a declared client. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const declarations = new WeakMap<object, HttpClientDeclaration>();

/**
 * A client of another HTTP service, declared like a controller: the class
 * extends `HttpClientBase`, the module lists it in `httpClients`, and services
 * take it by type. The framework creates it with the base URL and limits of
 * `config`, a 30 s timeout and a 16 MiB response limit by default, and the
 * kernel's correlation headers.
 *
 * ```ts
 * @HttpClient({ config: weatherConfig })
 * export class WeatherClient extends HttpClientBase {}
 * ```
 */
export function HttpClient(declaration: HttpClientDeclaration = {}) {
  return (target: HttpClientClass, _context: ClassDecoratorContext): void => {
    declarations.set(target, declaration);
  };
}

registerModuleMetadataExpander((metadata: BazisModuleMetadata): readonly BazisModuleRef[] => {
  const clients = (metadata as BazisModuleMetadata & { readonly httpClients?: unknown }).httpClients;
  if (clients === undefined) return [];
  const owner = typeof metadata === "function" ? (metadata as { name: string }).name : "<module>";
  if (!Array.isArray(clients)) throw new HttpClientError(`${owner}: httpClients must list classes declared with @HttpClient.`);
  const configs = new Set<ConfigDefinition<HttpClientConfig>>();
  const providers = clients.map((client: unknown) => {
    const declaration = typeof client === "function" ? declarations.get(client) : undefined;
    if (declaration === undefined || !((client as HttpClientClass).prototype instanceof HttpClientBase)) {
      throw new HttpClientError(`${owner}: ${typeof client === "function" ? client.name : String(client)} in httpClients must extend HttpClientBase and be declared with @HttpClient(…).`);
    }
    if (declaration.config !== undefined) configs.add(declaration.config);
    const Client = client as HttpClientClass;
    return DI.singleton(DI.factoryProviderWithResolver(Client, [], (resolver) => new Client(defaultsOf(declaration, resolver))));
  });
  return [{ config: [...configs], providers, exports: clients }];
});

function defaultsOf(declaration: HttpClientDeclaration, resolver: ServiceResolver): RequestConfig {
  const { config, ...fixed } = declaration;
  const view = config === undefined ? undefined : resolver.resolve(config.token);
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    correlationHeaders: getOutboundCorrelationHeaders,
    ...fixed,
    ...(view === undefined ? {} : { baseUrl: view.get("baseUrl") }),
    ...(view !== undefined && config!.has("timeoutMs") ? { timeoutMs: view.get("timeoutMs") } : {}),
    ...(view !== undefined && config!.has("maxResponseBytes") ? { maxResponseBytes: view.get("maxResponseBytes") } : {}),
  };
}

// Augment the declaring file, not the "../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../di/module/types/BazisModule" {
  interface BazisModuleMetadata {
    /** Clients of other HTTP services, declared with `@HttpClient`: injected by their class. */
    readonly httpClients?: readonly (abstract new (...args: never[]) => HttpClientBase)[];
  }
}
