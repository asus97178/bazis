import {
  getGatewayMessageHandlers,
  getWebSocketGatewayMetadata,
  resolveWebSocketGatewayOptions,
  type WsBodyValidator,
  type WsRateLimit,
} from "./decorators";
import type { WsMiddleware } from "./middleware";

export interface CompiledWsHandler {
  events: string[];
  handler: (...args: unknown[]) => unknown;
  handlerName: string | symbol;
  /** Declared parameter count; drives positional `(socket, body, ack)` binding. */
  arity: number;
  rateLimit?: WsRateLimit;
  validate?: WsBodyValidator;
}

export interface RegisteredNamespace {
  namespace: string;
  path: string;
  gatewayInstance: unknown;
  handlers: Map<string, CompiledWsHandler>;
  middleware: WsMiddleware[];
  corsOrigins: string[];
  maxPayloadBytes: number;
  maxOutboundPayloadBytes?: number;
  sessionTtlMs: number;
}

/**
 * Compiles gateway instances into per-namespace handler maps (event -> handler).
 * Handler binding is positional `(socket, body, ack)` by arity — no parameter
 * decorators (TC39 decorators do not support them).
 */
export class WebSocketExplorer {
  public explore(gatewayInstances: readonly unknown[]): RegisteredNamespace[] {
    const namespaces: RegisteredNamespace[] = [];
    const namespacesByName = new Map<string, string>();
    const namespacesByPath = new Map<string, string>();

    for (const instance of gatewayInstances) {
      const gatewayClass = (instance as { constructor: object } | null)?.constructor;
      if (!gatewayClass) {
        continue;
      }
      const metadata = getWebSocketGatewayMetadata(gatewayClass);
      if (!metadata) {
        continue;
      }

      const resolved = resolveWebSocketGatewayOptions(metadata);
      const gatewayName = (gatewayClass as { name?: string }).name ?? "?";
      const duplicateNamespace = namespacesByName.get(resolved.namespace);
      if (duplicateNamespace !== undefined) {
        throw new Error(
          `Duplicate WebSocket namespace "${resolved.namespace}" on gateways "${duplicateNamespace}" and "${gatewayName}".`,
        );
      }
      const duplicatePath = namespacesByPath.get(resolved.path);
      if (duplicatePath !== undefined) {
        throw new Error(
          `Duplicate WebSocket path "${resolved.path}" on gateways "${duplicatePath}" and "${gatewayName}".`,
        );
      }
      namespacesByName.set(resolved.namespace, gatewayName);
      namespacesByPath.set(resolved.path, gatewayName);
      const handlers = new Map<string, CompiledWsHandler>();

      for (const decl of getGatewayMessageHandlers(gatewayClass)) {
        const method = (instance as Record<string | symbol, unknown>)[decl.propertyKey];
        if (typeof method !== "function") {
          continue;
        }
        const compiled: CompiledWsHandler = {
          events: decl.events,
          handler: (method as (...args: unknown[]) => unknown).bind(instance),
          handlerName: decl.propertyKey,
          arity: method.length,
          ...(decl.rateLimit ? { rateLimit: decl.rateLimit } : {}),
          ...(decl.validate ? { validate: decl.validate } : {}),
        };
        if (decl.rateLimit !== undefined) {
          assertRateLimit(decl.rateLimit, gatewayName, decl.propertyKey);
        }
        for (const event of decl.events) {
          if (typeof event !== "string" || event.trim().length === 0) {
            throw new Error(`@SubscribeMessage event on ${gatewayName}.${String(decl.propertyKey)} must not be empty.`);
          }
          if (handlers.has(event)) {
            throw new Error(
              `Duplicate @SubscribeMessage("${event}") in gateway "${(gatewayClass as { name?: string }).name ?? "?"}"`,
            );
          }
          handlers.set(event, compiled);
        }
      }

      namespaces.push({
        namespace: resolved.namespace,
        path: resolved.path,
        gatewayInstance: instance,
        handlers,
        middleware: resolved.middleware,
        // Empty means "inherit the server/module default". An explicit
        // gateway wildcard remains ["*"] and deliberately overrides it.
        corsOrigins: resolved.cors?.origins ? [...resolved.cors.origins] : [],
        maxPayloadBytes: resolved.maxPayloadBytes,
        maxOutboundPayloadBytes: resolved.maxOutboundPayloadBytes,
        sessionTtlMs: resolved.sessionTtlMs,
      });
    }

    return namespaces;
  }
}

function assertRateLimit(rateLimit: WsRateLimit, gateway: string, method: string | symbol): void {
  if (!Number.isInteger(rateLimit.limit) || rateLimit.limit <= 0) {
    throw new Error(`WebSocket rateLimit.limit on ${gateway}.${String(method)} must be a positive integer.`);
  }
  if (!Number.isFinite(rateLimit.windowMs) || rateLimit.windowMs <= 0) {
    throw new Error(`WebSocket rateLimit.windowMs on ${gateway}.${String(method)} must be positive.`);
  }
}
