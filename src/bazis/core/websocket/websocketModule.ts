import {
  DI,
  collectModuleGateways,
  markGlobal,
  Module,
  type BazisModule,
  type BazisModuleRef,
  type ProviderDefinition,
  type ServiceResolver,
} from "../di";
import { WEBSOCKET_UPGRADE } from "../http";
import { LOGGER } from "../kernel";
import { WebSocketService } from "./WebSocketService";
import { WebSocketExplorer } from "./explorer";
import { WebSocketServer, type WebSocketMemoryLimits } from "./ws-server";
import type { WsAccessTokenAuthenticator, WsMiddleware } from "./middleware";
import type { WebSocketAdapter } from "./adapter/adapter.interface";
import type { PacketCodec } from "./codec/packet-codec.interface";
import type { ReplayDelivery } from "./types";
import type { WebSocketDiagnostic } from "./reliable-delivery";

export interface WebSocketModuleConfig {
  /**
   * Modules whose `gateways` (classes with `@WebSocketGateway`) are served.
   * The whole tree is searched, like `httpModule` searches for controllers.
   */
  readonly imports?: readonly BazisModuleRef[];
  /** Kernel-owned upgrade policy using DI; runs before gateway middleware. */
  readonly middlewareFactory?: (services: ServiceResolver) => WsMiddleware;
  /** Upgrade-time authentication; `null`/omitted means anonymous connections. */
  readonly authenticator?: WsAccessTokenAuthenticator | null;
  /** Reject anonymous upgrades. Requires `authenticator` and fails fast without it. */
  readonly requireAuth?: boolean;
  /** Accept `?token=` during upgrade. Disabled by default because URLs leak. */
  readonly allowQueryToken?: boolean;
  /** Default allowed origins when a gateway does not specify its own. */
  readonly cors?: { origins?: string[] };
  /** Pluggable broadcast/session adapter (defaults to in-memory, single-node). */
  readonly adapter?: WebSocketAdapter;
  /** Wire codec (defaults to JSON). */
  readonly codec?: PacketCodec;
  /** Default replay confirmation mode. A client can opt in with ?replay=client-ack. */
  readonly replayDelivery?: ReplayDelivery;
  readonly onDiagnostic?: (event: WebSocketDiagnostic) => void;
  /** In-process memory bounds for sessions, rooms, topics and rate-limit buckets. */
  readonly limits?: WebSocketMemoryLimits;
  /** Expose validator/handler exception text to clients. Default false. */
  readonly exposeHandlerErrors?: boolean;
}

/** Server-wide WebSocket settings of `runApp({ websocket })`; gateways come from the modules. */
export type WebSocketOptions = Omit<WebSocketModuleConfig, "imports">;

/**
 * Serves the gateways declared by the modules of `imports` on the shared HTTP
 * listener. `runApp` installs it next to the HTTP module whenever a module
 * declares `gateways`; `runApp({ websocket })` passes the settings.
 *
 * ```ts
 * @Module({ gateways: [ChatGateway], providers: [singleton(ChatHistory)] })
 * class ChatModule {}
 * ```
 *
 * The built `WebSocketServer` is exposed under {@link WEBSOCKET_UPGRADE}; the
 * HTTP server resolves it and wires `Bun.serve({ websocket })` automatically.
 * `WebSocketService` is exported globally for sending from services.
 */
export function websocketModule(config: WebSocketModuleConfig): BazisModule {
  const gateways = collectModuleGateways(config.imports ?? []);
  if (gateways.length === 0) {
    throw new Error("websocketModule: no module of imports declares gateways. Add gateways: [ChatGateway] to the module that owns the gateway.");
  }
  const providers: ProviderDefinition[] = [
    DI.singleton(
      DI.factoryProviderWithResolver(WEBSOCKET_UPGRADE, [], (resolver) => {
        const instances = gateways.map((Gateway) => resolver.resolve(Gateway));
        const namespaces = new WebSocketExplorer().explore(instances);
        if (config.middlewareFactory) {
          const middleware = config.middlewareFactory(resolver);
          if (typeof middleware !== "function") throw new Error("WebSocket middlewareFactory must return middleware.");
          for (const namespace of namespaces) namespace.middleware.unshift(middleware);
        }
        const logger = resolver.tryResolve(LOGGER);
        return new WebSocketServer({
          namespaces,
          authenticator: config.authenticator ?? null,
          requireAuth: config.requireAuth ?? false,
          allowQueryToken: config.allowQueryToken ?? false,
          ...(config.cors?.origins ? { defaultCorsOrigins: config.cors.origins } : {}),
          ...(config.adapter ? { adapter: config.adapter } : {}),
          ...(config.codec ? { codec: config.codec } : {}),
          ...(config.replayDelivery ? { replayDelivery: config.replayDelivery } : {}),
          ...(config.onDiagnostic ? { onDiagnostic: config.onDiagnostic } : {}),
          ...(config.limits ? { limits: config.limits } : {}),
          ...(config.exposeHandlerErrors !== undefined ? { exposeHandlerErrors: config.exposeHandlerErrors } : {}),
          ...(logger ? { logger } : {}),
        });
      }),
    ),
    DI.singleton(
      DI.factoryProviderWithResolver(WebSocketService, [], (resolver) => {
        const upgrade = resolver.resolve(WEBSOCKET_UPGRADE);
        if (!(upgrade instanceof WebSocketServer)) throw new Error("WebSocketService needs the WebSocketServer registered by websocketModule.");
        return new WebSocketService(upgrade);
      }),
    ),
  ];

  // Global + exported so the HTTP module can resolve the upgrade port without
  // importing the websocket module (one-way: websocket builds on http), and
  // any service can take WebSocketService.
  @Module({ imports: config.imports, providers, exports: [WEBSOCKET_UPGRADE, WebSocketService] })
  class WebSocketModule {}

  return markGlobal(WebSocketModule);
}
