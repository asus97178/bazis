import type { WebSocketServer } from "./ws-server";
import type { SocketBroadcast } from "./types";
import type { ReliableBroadcastOptions, ReliableBroadcastReceipt } from "./reliable-delivery";

/** `to(room)` of one namespace, usable from any service. */
export interface WebSocketNamespace {
  readonly name: string;
  to(room: string): SocketBroadcast;
}

/**
 * Sends events to rooms from outside a gateway handler: a service, an HTTP
 * controller or a background job. Registered by `websocketModule` and exported
 * globally, so any service can take it in its constructor.
 *
 * ```ts
 * this.ws.to("user:ann").emit("order-paid", { id });            // one namespace
 * this.ws.namespace("chat").to("general").emit("message", m);   // a chosen one
 * ```
 */
export class WebSocketService {
  public constructor(private readonly server: WebSocketServer) {}

  /** The broadcaster of a namespace (`"chat"` and `"/chat"` are the same). */
  public namespace(name: string): WebSocketNamespace {
    const server = this.server;
    return {
      name,
      to(room: string): SocketBroadcast {
        return {
          emit: (event, data) => server.broadcast(name, room, event, data),
          emitReliable: (event, data, options: ReliableBroadcastOptions): Promise<ReliableBroadcastReceipt> =>
            server.broadcastReliable(name, room, event, data, options),
        };
      },
    };
  }

  /** `to(room)` of the only namespace; with several, name one with `namespace()`. */
  public to(room: string): SocketBroadcast {
    const names = this.server.namespaceNames;
    if (names.length !== 1) {
      throw new Error(`WebSocketService.to(room) needs exactly one namespace, found ${names.length} (${names.join(", ")}); use namespace(name).to(room).`);
    }
    return this.namespace(names[0] as string).to(room);
  }
}
