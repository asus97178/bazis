import { REQUEST_ID_STATE_KEY, type Logger } from "../../kernel";
import { redactSensitive, redactSensitiveText } from "../../../library/redaction";
import type { HttpContext } from "../HttpContext/HttpContext";
import { HttpError } from "../Errors/HttpError";
import type { HttpMiddleware } from "./types";

export interface ErrorHandlerOptions {
  /**
   * Include the error message and stack in 500 responses (development only —
   * never enable in production).
   */
  exposeDetails?: boolean;
  /**
   * Notified of every non-{@link HttpError} failure, for example to send it to
   * an error tracker; `HTTP_ERROR_HOOK` registrations are merged in. It does not
   * replace logging: the error is logged as well.
   */
  onUnexpectedError?: (ctx: HttpContext, error: unknown) => void;
  /** Replaces the built-in logging of unexpected errors. */
  logError?: (error: unknown) => void;
  /**
   * Logger for unexpected errors when {@link logError} is absent: one `error`
   * line with the method, path, request id and the redacted error. The server
   * passes the application `LOGGER`; without either, `console.error` is used.
   */
  logger?: Logger;
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

type ErrorLog = (ctx: HttpContext, error: unknown) => void;

function resolveErrorLog(options: ErrorHandlerOptions): ErrorLog {
  const { logError, logger } = options;
  if (logError) {
    return (_ctx, error) => logError(error);
  }
  if (logger) {
    return (ctx, error) => {
      const requestId = ctx.state.get(REQUEST_ID_STATE_KEY);
      logger.error(`${ctx.method} ${ctx.path} failed`, {
        method: ctx.method,
        path: ctx.path,
        ...(typeof requestId === "string" ? { requestId } : {}),
        error: redactSensitive(error),
      });
    };
  }
  return (_ctx, error) => console.error("[http] unhandled error:", redactSensitive(error));
}

function safelyReportUnexpected(
  options: ErrorHandlerOptions,
  log: ErrorLog,
  ctx: HttpContext,
  error: unknown,
): void {
  try {
    options.onUnexpectedError?.(ctx, error);
  } catch (hookError) {
    try {
      log(ctx, hookError);
    } catch {
      // Logging hooks are best-effort; response safety is primary.
    }
  }
  try {
    log(ctx, error);
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
  const log = resolveErrorLog(options);
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
      safelyReportUnexpected(options, log, ctx, error);
      ctx.response = options.exposeDetails
        ? safeJsonResponse(500, {
            error: "Internal Server Error",
            // Development only, but redacted like the log: a secret in an error
            // message must not reach a browser or a shared screenshot.
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            stack: error instanceof Error && error.stack !== undefined ? redactSensitiveText(error.stack) : undefined,
          })
        : safeJsonResponse(500, { error: "Internal Server Error" });
    }
  };
}
