import {
  DI,
  markGlobal,
  Module,
  singleton,
  type Class,
  type BazisModule,
  type ProviderDefinition,
  type ServiceResolver,
} from "../di";
import { WEBSOCKET_UPGRADE } from "../http";
import { WebSocketExplorer } from "./explorer";
import { WebSocketServer, type WebSocketMemoryLimits } from "./ws-server";
import type { WsAccessTokenAuthenticator, WsMiddleware } from "./middleware";
import type { WebSocketAdapter } from "./adapter/adapter.interface";
import type { PacketCodec } from "./codec/packet-codec.interface";
import type { ReplayDelivery } from "./types";
import type { WebSocketDiagnostic } from "./reliable-delivery";

export interface WebSocketModuleConfig {
  /**
   * Gateway classes decorated with `@WebSocketGateway`. Each is registered as a
   * singleton (with auto-resolved constructor dependencies) and explored for
   * `@SubscribeMessage` handlers.
   */
  readonly gateways: readonly Class<object>[];
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

/**
 * Registers WebSocket gateways and shares the HTTP listener for upgrades.
 *
 * ```ts
 * @Module({ imports: [httpModule({ ... }), websocketModule({ gateways: [ChatGateway] })] })
 * class AppModule {}
 * ```
 *
 * The built `WebSocketServer` is exposed under {@link WEBSOCKET_UPGRADE}; the
 * HTTP server resolves it and wires `Bun.serve({ websocket })` automatically.
 */
export function websocketModule(config: WebSocketModuleConfig): BazisModule {
  const providers: ProviderDefinition[] = [
    ...config.gateways.map((Gateway) => singleton(Gateway)),
    DI.singleton(
      DI.factoryProviderWithResolver(WEBSOCKET_UPGRADE, [], (resolver) => {
        const instances = config.gateways.map((Gateway) => resolver.resolve(Gateway));
        const namespaces = new WebSocketExplorer().explore(instances);
        if (config.middlewareFactory) {
          const middleware = config.middlewareFactory(resolver);
          if (typeof middleware !== "function") throw new Error("WebSocket middlewareFactory must return middleware.");
          for (const namespace of namespaces) namespace.middleware.unshift(middleware);
        }
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
        });
      }),
    ),
  ];

  // Global + exported so the HTTP module can resolve the upgrade port without
  // importing the websocket module (one-way: websocket builds on http).
  @Module({ providers, exports: [WEBSOCKET_UPGRADE] })
  class WebSocketModule {}

  return markGlobal(WebSocketModule);
}
