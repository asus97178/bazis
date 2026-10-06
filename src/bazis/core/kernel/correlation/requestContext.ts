import { AsyncLocalStorage } from "node:async_hooks";

/** HTTP header used for inbound/outbound correlation IDs. */
export const REQUEST_ID_HEADER = "x-request-id";

/** W3C Trace Context header propagated on outbound HTTP calls when present. */
export const TRACEPARENT_HEADER = "traceparent";

/** Key in {@link HttpContext.state} for the active request ID. */
export const REQUEST_ID_STATE_KEY = "bazis.requestId";

/** Key in {@link HttpContext.state} for inbound W3C traceparent. */
export const TRACEPARENT_STATE_KEY = "bazis.traceparent";

export interface RequestLogContext {
  readonly requestId: string;
  readonly traceparent?: string;
}

const storage = new AsyncLocalStorage<RequestLogContext>();

/** Returns the correlation ID for the current async context, if any. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Returns the active W3C traceparent value, if any. */
export function getTraceparent(): string | undefined {
  return storage.getStore()?.traceparent;
}

/** Headers to attach to outbound HTTP requests from the current async context. */
export function getOutboundCorrelationHeaders(): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  const requestId = getRequestId();
  if (requestId !== undefined) {
    headers[REQUEST_ID_HEADER] = requestId;
  }
  const traceparent = getTraceparent();
  if (traceparent !== undefined) {
    headers[TRACEPARENT_HEADER] = traceparent;
  }
  return headers;
}

/** Runs `fn` with the given request context bound to the async local store. */
export function runWithRequestContext<T>(context: RequestLogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Runs async `fn` with the given request context bound to the async local store. */
export async function runWithRequestContextAsync<T>(
  context: RequestLogContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}
