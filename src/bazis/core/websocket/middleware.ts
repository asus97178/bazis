import type { SocketUser } from "./types";

const MAX_SOCKET_USER_ID_LENGTH = 256;

/** Mutable context for the upgrade pipeline; `data` flows into `ws.data.context`. */
export interface WsUpgradeContext {
  readonly request: Request;
  readonly namespace: string;
  readonly path: string;
  /** Aborted when the upgrade is cancelled or exceeds its deadline. */
  readonly signal: AbortSignal;
  data: Record<string, unknown>;
}

/** Upgrade middleware (Koa/ASP.NET-style); throw {@link WsUpgradeError} to reject. */
export type WsMiddleware = (ctx: WsUpgradeContext, next: () => Promise<void>) => void | Promise<void>;

/** Authenticates a connection at upgrade. Return `null` for anonymous. */
export interface WsAuthenticationContext {
  readonly signal: AbortSignal;
  readonly namespace: string;
  readonly path?: string;
  readonly request?: Request;
}

export type WsAccessTokenAuthenticator = (
  token: string | null,
  /** Optional second argument preserves the existing positional token API. */
  context?: WsAuthenticationContext,
) => SocketUser | null | Promise<SocketUser | null>;

export interface WebSocketTokenExtractionOptions {
  /** Accept `?token=` during upgrade. Disabled by default because URLs leak. */
  readonly allowQueryToken?: boolean;
}

/** Rejects an upgrade with an HTTP status (the handshake never completes). */
export class WsUpgradeError extends Error {
  public constructor(
    message: string,
    public readonly status = 403,
  ) {
    super(message);
    this.name = "WsUpgradeError";
  }
}

/** Composes upgrade middleware into a single runnable pipeline. */
export function composeWsUpgradeMiddleware(
  middlewares: readonly WsMiddleware[],
  terminal: () => Promise<void>,
): (ctx: WsUpgradeContext) => Promise<void> {
  return (ctx) => {
    let index = -1;
    const run = (i: number): Promise<void> => {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }
      index = i;
      const middleware = middlewares[i];
      if (!middleware) {
        return terminal();
      }
      return Promise.resolve(middleware(ctx, () => run(i + 1)));
    };
    return run(0);
  };
}

/** Rejects upgrades whose `Origin` is not allow-listed (`"*"` allows all). */
export function createOriginCheckMiddleware(allowed: readonly string[]): WsMiddleware {
  const allowAll = allowed.includes("*");
  return (ctx, next) => {
    const origin = ctx.request.headers.get("origin");
    if (!allowAll && origin !== null && !allowed.includes(origin)) {
      throw new WsUpgradeError("Origin not allowed", 403);
    }
    return next();
  };
}

/**
 * Extracts a bearer token from `Authorization` or the `Sec-WebSocket-Protocol`
 * `bearer.<token>` convention. Query-string tokens are disabled by default
 * because URLs commonly leak into logs, proxies and browser history.
 */
export function extractWebSocketToken(
  request: Request,
  options: WebSocketTokenExtractionOptions = {},
): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }
  const protocol = request.headers.get("sec-websocket-protocol");
  if (protocol) {
    for (const part of protocol.split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("bearer.")) {
        return trimmed.slice("bearer.".length) || null;
      }
    }
  }
  return options.allowQueryToken === true ? new URL(request.url).searchParams.get("token") : null;
}

/** Authenticates the upgrade; sets `ctx.data.user`. Closes with 401 when required. */
export function createWsAuthMiddleware(
  authenticator: WsAccessTokenAuthenticator,
  options?: { required?: boolean; allowQueryToken?: boolean },
): WsMiddleware {
  return async (ctx, next) => {
    const user = await authenticator(
      extractWebSocketToken(ctx.request, { allowQueryToken: options?.allowQueryToken }),
      {
        signal: ctx.signal,
        namespace: ctx.namespace,
        path: ctx.path,
        request: ctx.request,
      },
    );
    if (user !== null && !isValidSocketUser(user)) {
      throw new WsUpgradeError("Unauthorized", 401);
    }
    if (user === null) {
      if (options?.required) {
        throw new WsUpgradeError("Unauthorized", 401);
      }
      return next();
    }
    ctx.data.user = user;
    return next();
  };
}

/** Runtime guard for authenticator and custom upgrade-middleware principals. */
export function isValidSocketUser(value: unknown): value is SocketUser {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string"
    && id.trim().length > 0
    && id.length <= MAX_SOCKET_USER_ID_LENGTH
    && !id.includes("\0");
}
