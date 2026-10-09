import {
  REQUEST_ID_HEADER,
  REQUEST_ID_STATE_KEY,
  TRACEPARENT_HEADER,
  TRACEPARENT_STATE_KEY,
  runWithRequestContextAsync,
} from "../../kernel";
import type { HttpMiddleware } from "../Middleware/types";

export interface CorrelationIdMiddlewareOptions {
  readonly headerName?: string;
  readonly generateId?: () => string;
  /** Validate an inbound request id. Default: conservative visible ASCII, max 128 chars. */
  readonly validateIncomingId?: (value: string) => boolean;
}

/** Marks the middleware so the server also applies it to responses produced before routing. */
const CORRELATION_ID_MIDDLEWARE = Symbol("bazis:http:correlation-id");

/** True for a middleware created by {@link createCorrelationIdMiddleware}. */
export function isCorrelationIdMiddleware(middleware: HttpMiddleware): boolean {
  return (middleware as HttpMiddleware & { [CORRELATION_ID_MIDDLEWARE]?: true })[CORRELATION_ID_MIDDLEWARE] === true;
}

const DEFAULT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,127}$/;
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}(?:-[\x21-\x7e]+)?$/i;

/**
 * Ensures one correlation ID per HTTP request: reads `x-request-id` or
 * generates a UUID, stores it on {@link HttpContext.state}, echoes it on the
 * response, and binds it to async local storage for application logs.
 * Registered among the server's global middleware, it also applies to the
 * responses the server produces before routing (404, 405, 413, preflight).
 */
export function createCorrelationIdMiddleware(
  options: CorrelationIdMiddlewareOptions = {},
): HttpMiddleware {
  const headerName = options.headerName ?? REQUEST_ID_HEADER;
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const validateIncomingId = options.validateIncomingId ?? ((value: string) => DEFAULT_REQUEST_ID.test(value));

  const middleware: HttpMiddleware = async (ctx, next) => {
    const incoming = ctx.header(headerName);
    const trimmedIncoming = incoming?.trim();
    const generated = (): string => {
      const value = generateId().trim();
      return validateIncomingId(value) ? value : crypto.randomUUID();
    };
    const requestId = trimmedIncoming && validateIncomingId(trimmedIncoming) ? trimmedIncoming : generated();
    ctx.state.set(REQUEST_ID_STATE_KEY, requestId);

    const traceparent = ctx.header(TRACEPARENT_HEADER);
    const normalizedTraceparent = normalizeTraceparent(traceparent);
    if (normalizedTraceparent !== undefined) {
      ctx.state.set(TRACEPARENT_STATE_KEY, normalizedTraceparent);
    }

    const context = {
      requestId,
      ...(normalizedTraceparent !== undefined ? { traceparent: normalizedTraceparent } : {}),
    };

    await runWithRequestContextAsync(context, async () => {
      await next();
    });

    if (ctx.response !== undefined && !ctx.response.headers.has(headerName)) {
      const headers = new Headers(ctx.response.headers);
      headers.set(headerName, requestId);
      ctx.response = new Response(ctx.response.body, {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers,
      });
    }
  };
  Object.defineProperty(middleware, CORRELATION_ID_MIDDLEWARE, { value: true });
  return middleware;
}

function normalizeTraceparent(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 512) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const match = TRACEPARENT.exec(normalized);
  if (!match || match[1] === "0".repeat(32) || match[2] === "0".repeat(16) || normalized.startsWith("ff-")) {
    return undefined;
  }
  return normalized;
}
