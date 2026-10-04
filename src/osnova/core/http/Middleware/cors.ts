import type { HttpMiddleware } from "./types";
import { HttpSetupError } from "../Errors/HttpError";
import { redactSensitive } from "../../../library/redaction";

export interface CorsOptions {
  /**
   * Allowed origins: exact string, list, predicate, or "*" (default).
   * `credentials: true` requires an explicit allow-list or predicate.
   */
  origin?: string | readonly string[] | ((origin: string) => boolean);
  /** Allowed methods for preflight (default: common verbs). */
  methods?: readonly string[];
  /** Allowed request headers for preflight (default: echo requested headers). */
  allowedHeaders?: readonly string[];
  /** Headers exposed to the browser. */
  exposedHeaders?: readonly string[];
  /** Allow cookies/credentials. */
  credentials?: boolean;
  /** Preflight cache time (Access-Control-Max-Age). */
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

function assertSafeCorsOptions(options: CorsOptions): void {
  if (!options.credentials) {
    return;
  }
  const { origin } = options;
  const allowsWildcard = origin === undefined || origin === "*" || (Array.isArray(origin) && origin.includes("*"));
  if (allowsWildcard) {
    throw new HttpSetupError(
      "CORS credentials require an explicit origin allow-list or predicate. " +
        "Do not combine credentials: true with omitted origin or '*'.",
    );
  }
}

function resolveOrigin(options: CorsOptions, requestOrigin: string): string | undefined {
  const { origin } = options;
  if (origin === undefined || origin === "*") {
    return options.credentials ? requestOrigin : "*";
  }
  if (typeof origin === "string") {
    return origin === requestOrigin ? requestOrigin : undefined;
  }
  if (typeof origin === "function") {
    return origin(requestOrigin) ? requestOrigin : undefined;
  }
  if (origin.includes("*")) {
    return "*";
  }
  return origin.includes(requestOrigin) ? requestOrigin : undefined;
}

function variesByOrigin(options: CorsOptions): boolean {
  const origin = options.origin;
  return origin !== undefined && origin !== "*" && !(Array.isArray(origin) && origin.includes("*"));
}

function applyCommonHeaders(headers: Headers, options: CorsOptions, allowedOrigin: string): void {
  headers.set("access-control-allow-origin", allowedOrigin);
  if (allowedOrigin !== "*") {
    appendVaryOrigin(headers);
  }
  if (options.credentials) {
    headers.set("access-control-allow-credentials", "true");
  }
  if (options.exposedHeaders?.length) {
    headers.set("access-control-expose-headers", options.exposedHeaders.join(", "));
  }
}

function appendVaryOrigin(headers: Headers): void {
  const vary = headers.get("vary");
  if (vary === null) {
    headers.set("vary", "Origin");
    return;
  }
  if (!vary.toLowerCase().split(",").map((item) => item.trim()).includes("origin")) {
    headers.append("vary", "Origin");
  }
}

/**
 * Is this request a CORS preflight (OPTIONS + Access-Control-Request-Method)?
 * Preflights are answered by the server before routing, so they work even
 * for routes that do not declare an OPTIONS handler.
 */
export function isPreflight(request: Request): boolean {
  return request.method === "OPTIONS" && request.headers.has("access-control-request-method");
}

/** Builds the preflight response (204 with the negotiated CORS headers). */
export function preflightResponse(options: CorsOptions, request: Request): Response {
  assertSafeCorsOptions(options);
  const requestOrigin = request.headers.get("origin");
  const headers = new Headers();
  if (variesByOrigin(options)) {
    appendVaryOrigin(headers);
  }
  if (requestOrigin) {
    const allowedOrigin = resolveOrigin(options, requestOrigin);
    if (allowedOrigin) {
      applyCommonHeaders(headers, options, allowedOrigin);
      headers.set("access-control-allow-methods", (options.methods ?? DEFAULT_METHODS).join(", "));
      const requestedHeaders = request.headers.get("access-control-request-headers");
      const allowHeaders = options.allowedHeaders?.join(", ") ?? requestedHeaders;
      if (allowHeaders) {
        headers.set("access-control-allow-headers", allowHeaders);
      }
      if (options.maxAgeSeconds !== undefined) {
        headers.set("access-control-max-age", String(options.maxAgeSeconds));
      }
    }
  }
  return new Response(null, { status: 204, headers });
}

/**
 * CORS middleware: adds response headers for cross-origin requests.
 * Use globally via `httpModule({ cors })` (which also answers preflights)
 * or per controller/route via `@Middleware(cors({...}))`.
 */
export function cors(options: CorsOptions = {}): HttpMiddleware {
  assertSafeCorsOptions(options);
  return async (ctx, next) => {
    await next();
    const requestOrigin = ctx.header("origin");
    if (!ctx.response) {
      return;
    }
    try {
      // The representation depends on Origin even when this particular origin
      // is absent or denied, so shared caches must always vary on it.
      const varies = variesByOrigin(options);
      if (varies) {
        appendVaryOrigin(ctx.response.headers);
      }
      if (!requestOrigin && varies) {
        return;
      }
      // A wildcard policy is truly invariant: emit its headers even without
      // Origin, so a cached same-origin response also works for a CORS caller.
      const allowedOrigin = requestOrigin ? resolveOrigin(options, requestOrigin) : "*";
      if (allowedOrigin) {
        applyCommonHeaders(ctx.response.headers, options, allowedOrigin);
      }
    } catch (error) {
      // CORS is response decoration, not authorization. A buggy predicate or
      // immutable raw response must not expose Bun's development error page or
      // replace an otherwise valid response.
      try {
        console.error("[http] CORS evaluation failed:", redactSensitive(error));
      } catch {
        // Best-effort diagnostics only.
      }
    }
  };
}
