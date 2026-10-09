import { REQUEST_ID_STATE_KEY, type Logger } from "../../kernel";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { HttpMiddleware } from "./types";
import { redactSensitive } from "../../../library/redaction";

export interface AccessLogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Wall-clock time spent in the pipeline, in milliseconds, rounded to 0.01. */
  readonly durationMs: number;
  /** Correlation id from {@link createCorrelationIdMiddleware}, if present. */
  readonly requestId?: string;
}

export interface AccessLogOptions {
  /** Sink for entries (highest precedence). Default: structured `logger`, else stdout. */
  readonly log?: (entry: AccessLogEntry) => void;
  /** Structured sink: `logger.info` per request. Used when `log` is absent. */
  readonly logger?: Logger;
  /** Return `true` to skip logging a request (e.g. noisy probes). */
  readonly skip?: (ctx: HttpContext) => boolean;
}

function defaultLog(entry: AccessLogEntry): void {
  const requestId = entry.requestId ? ` ${entry.requestId}` : "";
  console.log(`[http] ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs.toFixed(1)}ms${requestId}`);
}

function resolveSink(options: AccessLogOptions): (entry: AccessLogEntry) => void {
  if (options.log) {
    return options.log;
  }
  const logger = options.logger;
  if (logger) {
    return (entry) =>
      logger.info(
        `${entry.method} ${entry.path} ${entry.status} ${entry.durationMs.toFixed(1)}ms`,
        {
          method: entry.method,
          path: entry.path,
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        },
      );
  }
  return defaultLog;
}

/**
 * Access log middleware: records method, path, final status and duration for
 * every request. The correlation id is read from `ctx.state` (set by
 * {@link createCorrelationIdMiddleware}), so it is captured regardless of the
 * order relative to the correlation middleware.
 *
 * Install it outermost (the server does this automatically for
 * `httpModule({ accessLog })`) so it measures the whole pipeline and observes
 * the final status, including errors mapped by the error boundary.
 */
export function accessLog(options: AccessLogOptions = {}): HttpMiddleware {
  const log = resolveSink(options);
  const skip = options.skip;
  return async (ctx, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      try {
        if (!skip?.(ctx)) {
          const requestId = ctx.state.get(REQUEST_ID_STATE_KEY);
          log({
            method: ctx.method,
            path: ctx.path,
            status: ctx.response?.status ?? 0,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            ...(typeof requestId === "string" ? { requestId } : {}),
          });
        }
      } catch (error) {
        // Observability must never replace an application response.
        try {
          console.error("[http] access log sink failed:", redactSensitive(error));
        } catch {
          // Even the fallback console may be replaced by application code.
        }
      }
    }
  };
}
