import { redactSensitive } from "../../../library/redaction";
import type { HttpContext } from "../HttpContext/HttpContext";
import { HttpError } from "../Errors/HttpError";
import type { HttpMiddleware } from "./types";

export interface ErrorHandlerOptions {
  /**
   * Include the error message and stack in 500 responses (development only —
   * never enable in production).
   */
  exposeDetails?: boolean;
  /** Called for non-{@link HttpError} failures (self-wired via `HTTP_ERROR_HOOK`, e.g. the logging module). */
  onUnexpectedError?: (ctx: HttpContext, error: unknown) => void;
  /** Fallback when {@link onUnexpectedError} is omitted or does not handle the error. */
  logError?: (error: unknown) => void;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: readonly [string, string][]): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (extraHeaders) {
    for (const [name, value] of extraHeaders) {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function safeJsonResponse(status: number, body: unknown, extraHeaders?: readonly [string, string][]): Response {
  try {
    return jsonResponse(status, body, extraHeaders);
  } catch {
    return jsonResponse(500, { error: "Internal Server Error" });
  }
}

function safelyReportUnexpected(
  options: ErrorHandlerOptions,
  fallback: (error: unknown) => void,
  ctx: HttpContext,
  error: unknown,
): void {
  try {
    options.onUnexpectedError?.(ctx, error);
  } catch (hookError) {
    try {
      fallback(hookError);
    } catch {
      // Logging hooks are best-effort; response safety is primary.
    }
  }
  try {
    fallback(error);
  } catch {
    // A broken sink must not escape the HTTP error boundary.
  }
}

/**
 * Built-in error boundary (always installed by the server). `HttpError` maps
 * to its status with a safe JSON payload; anything
 * else becomes 500 Internal Server Error.
 */
export function errorHandler(options: ErrorHandlerOptions = {}): HttpMiddleware {
  const fallback = options.logError ?? ((error: unknown) => console.error("[http] unhandled error:", redactSensitive(error)));
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof HttpError) {
        const extra: [string, string][] = [];
        const allow = (error as { allow?: readonly string[] }).allow;
        if (allow) {
          extra.push(["allow", allow.join(", ")]);
        }
        const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
        if (retryAfter !== undefined) {
          extra.push(["retry-after", String(retryAfter)]);
        }
        const challenge = (error as { challenge?: string }).challenge;
        if (challenge !== undefined) {
          extra.push(["www-authenticate", challenge]);
        }
        ctx.response = safeJsonResponse(
          error.status,
          error.details === undefined ? { error: error.message } : { error: error.message, details: error.details },
          extra,
        );
        return;
      }
      safelyReportUnexpected(options, fallback, ctx, error);
      ctx.response = options.exposeDetails
        ? safeJsonResponse(500, {
            error: "Internal Server Error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })
        : safeJsonResponse(500, { error: "Internal Server Error" });
    }
  };
}
