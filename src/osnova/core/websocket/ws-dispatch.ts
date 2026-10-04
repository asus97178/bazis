import type { AckCallback, ClientPacket, OsnovaSocket } from "./types";
import type { CompiledWsHandler } from "./explorer";
import type { PacketCodec } from "./codec/packet-codec.interface";
import { jsonPacketCodec } from "./codec/json.codec";

export type WsDispatchErrorKind = "validation" | "handler";

/** Internal boundary error; raw causes are never placed on the wire by default. */
export class WsDispatchError extends Error {
  public constructor(
    public readonly kind: WsDispatchErrorKind,
    public override readonly cause: unknown,
  ) {
    super(kind === "validation" ? "Invalid message payload" : "Handler failed");
    this.name = "WsDispatchError";
  }
}

/**
 * Invokes a message handler by positional convention `(socket, body, ack)`,
 * binding only as many arguments as the handler declares. If the client packet
 * carried an `id`, return and callback share one acknowledgement. A handler
 * declaring the third argument and returning undefined waits for that callback
 * or cancellation. All replies use the configured wire codec.
 */
export async function dispatchWsHandler(
  compiled: CompiledWsHandler,
  socket: OsnovaSocket,
  packet: ClientPacket,
  send: (payload: string | Uint8Array) => void,
  signal?: AbortSignal,
  codec: PacketCodec = jsonPacketCodec,
): Promise<void> {
  let ackSent = false;
  let ackFailed = false;
  let ackFailure: unknown;
  let completeAck!: () => void;
  const ackCompleted = new Promise<void>((resolve) => { completeAck = resolve; });
  const ack: AckCallback = (response, error) => {
    if (!packet.id || ackSent || signal?.aborted) {
      return;
    }
    ackSent = true;
    try {
      send(codec.encodeServer(error
        ? { type: "error", data: { message: error.message }, id: packet.id }
        : { type: "ack", id: packet.id, data: response }));
    } catch (error) {
      // Deferred callbacks can run outside the handler's stack. Report a send
      // failure through the observed dispatch promise, never as an uncaught timer.
      ackFailed = true;
      ackFailure = error;
    } finally {
      completeAck();
    }
  };

  let body = packet.data;
  if (compiled.validate) {
    try {
      body = await compiled.validate(packet.data, signal);
    } catch (error) {
      throw new WsDispatchError("validation", error);
    }
  }

  throwIfAborted(signal);

  const args: unknown[] = [];
  if (compiled.arity >= 1) {
    args.push(socket);
  }
  if (compiled.arity >= 2) {
    args.push(body);
  }
  if (compiled.arity >= 3) {
    args.push(ack);
  }

  let result: unknown;
  try {
    result = await compiled.handler(...args);
  } catch (error) {
    throw new WsDispatchError("handler", error);
  }
  throwIfAborted(signal);

  if (packet.id && !ackSent) {
    if (compiled.arity >= 3 && result === undefined) {
      await waitForAck(ackCompleted, signal);
    } else {
      ack(result);
    }
  }
  if (ackFailed) {
    throw new WsDispatchError("handler", ackFailure);
  }
}

function waitForAck(completed: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    return completed;
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("WebSocket acknowledgement aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void completed.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("WebSocket message processing aborted.");
}
