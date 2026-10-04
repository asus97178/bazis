import type { WsMiddleware } from "./middleware";
import type { OsnovaSocket } from "./types";

// Bun runs TC39 decorators natively, but Symbol.metadata may be absent.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const GATEWAY_META = Symbol.for("osnova:ws:gateway");
const HANDLERS_META = Symbol.for("osnova:ws:handlers");

/** Per-message rate limit (fixed window). */
export interface WsRateLimit {
  readonly limit: number;
  readonly windowMs: number;
  /** Custom bucket key; defaults to `${socket.id}:${event}`. */
  readonly key?: (socket: OsnovaSocket) => string;
}

export interface WebSocketGatewayOptions {
  /** Logical namespace. Default: "/". */
  readonly namespace?: string;
  /** HTTP upgrade path. Default: "/ws" + namespace ("/ws", "/ws/chat"). */
  readonly path?: string;
  /** Allowed origins for the upgrade. Default: app/server origins. */
  readonly cors?: { origins?: string[]; credentials?: boolean };
  /** Gateway-level upgrade middleware. */
  readonly middleware?: WsMiddleware[];
  /** Max inbound payload bytes. Default: 64 KiB. */
  readonly maxPayloadBytes?: number;
  /** Max outbound frame bytes; defaults to maxPayloadBytes. */
  readonly maxOutboundPayloadBytes?: number;
  /** Session TTL for reconnect. Default: 2h. */
  readonly sessionTtlMs?: number;
}

/**
 * Validates/transforms a message body before the handler runs. Return the
 * (possibly coerced) value, or throw to reject. The client receives a generic
 * validation error by default; applications may explicitly opt into exposing
 * details for trusted development environments. Deliberately framework-
 * agnostic: wrap `@/library/validation`, a DTO class, or any schema you like.
 */
export type WsBodyValidator = (
  body: unknown,
  /** Aborted when message processing is cancelled or times out. */
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

export interface MessageHandlerDecl {
  readonly propertyKey: string | symbol;
  readonly events: string[];
  readonly rateLimit?: WsRateLimit;
  readonly validate?: WsBodyValidator;
}

interface GatewayCarrier {
  [GATEWAY_META]?: WebSocketGatewayOptions;
  [HANDLERS_META]?: MessageHandlerDecl[];
}

export interface SubscribeMessageOptions {
  readonly rateLimit?: WsRateLimit;
  readonly validate?: WsBodyValidator;
}

/** Marks a class as a WebSocket gateway (analogous to `@Controller`). */
export function WebSocketGateway(options: WebSocketGatewayOptions = {}) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    (context.metadata as GatewayCarrier)[GATEWAY_META] = options;
  };
}

function ownHandlers(carrier: GatewayCarrier): MessageHandlerDecl[] {
  if (!Object.prototype.hasOwnProperty.call(carrier, HANDLERS_META)) {
    carrier[HANDLERS_META] = carrier[HANDLERS_META] ? [...carrier[HANDLERS_META]] : [];
  }
  return carrier[HANDLERS_META]!;
}

/**
 * Subscribes a method to one or more events. The handler is called by
 * positional convention: `(socket, body, ack)` — declare only what you need.
 * Returning a value auto-acks when the client packet carried an `id`.
 */
export function SubscribeMessage(event: string | readonly string[], options?: SubscribeMessageOptions) {
  return (_value: (this: never, ...args: never[]) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static) {
      throw new Error("@SubscribeMessage cannot be applied to static methods.");
    }
    ownHandlers(context.metadata as GatewayCarrier).push({
      propertyKey: context.name,
      events: Array.isArray(event) ? [...event] : [event as string],
      ...(options?.rateLimit ? { rateLimit: options.rateLimit } : {}),
      ...(options?.validate ? { validate: options.validate } : {}),
    });
  };
}

export function getWebSocketGatewayMetadata(ctor: object): WebSocketGatewayOptions | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | GatewayCarrier
    | undefined;
  return metadata?.[GATEWAY_META];
}

export function getGatewayMessageHandlers(ctor: object): readonly MessageHandlerDecl[] {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | GatewayCarrier
    | undefined;
  return metadata?.[HANDLERS_META] ?? [];
}

/** Normalizes a namespace to a leading-slash form ("chat" -> "/chat", "" -> "/"). */
export function normalizeNamespace(namespace: string | undefined): string {
  const value = namespace?.trim();
  if (!value || value === "/") {
    return "/";
  }
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (normalized.includes("\0") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error("WebSocket namespace contains an invalid separator.");
  }
  return normalized;
}

export interface ResolvedGatewayOptions {
  readonly namespace: string;
  readonly path: string;
  readonly cors?: { origins?: string[]; credentials?: boolean };
  readonly middleware: WsMiddleware[];
  readonly maxPayloadBytes: number;
  readonly maxOutboundPayloadBytes?: number;
  readonly sessionTtlMs: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export function resolveWebSocketGatewayOptions(options: WebSocketGatewayOptions): ResolvedGatewayOptions {
  const namespace = normalizeNamespace(options.namespace);
  const path = options.path ?? (namespace === "/" ? "/ws" : `/ws${namespace}`);
  if (!path.startsWith("/") || path.includes("\0") || path.includes("?") || path.includes("#")) {
    throw new Error(`WebSocket path "${path}" must be an absolute path without query/hash separators.`);
  }
  const maxPayloadBytes = positiveOption(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
  const sessionTtlMs = positiveOption(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, "sessionTtlMs");
  return {
    namespace,
    path,
    ...(options.cors ? { cors: options.cors } : {}),
    middleware: options.middleware ?? [],
    maxPayloadBytes,
    maxOutboundPayloadBytes: positiveOption(options.maxOutboundPayloadBytes, maxPayloadBytes, "maxOutboundPayloadBytes"),
    sessionTtlMs,
  };
}

function positiveOption(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`WebSocket ${field} must be a positive number.`);
  }
  return Math.floor(value);
}
