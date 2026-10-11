/**
 * Marks an error of a call to another service. The HTTP error boundary answers
 * `504 Gateway Timeout` for a timeout and `502 Bad Gateway` otherwise, like it
 * does for `HttpClientError`. Clients of other protocols (gRPC) set the mark,
 * so the HTTP layer does not depend on them.
 */
export type UpstreamFailure = "timeout" | "failure";

const UPSTREAM_FAILURE = Symbol.for("bazis.http.upstreamFailure");

/** Sets the mark on `error` (non-enumerable) and returns it. */
export function markUpstreamFailure<E extends object>(error: E, kind: UpstreamFailure): E {
  Object.defineProperty(error, UPSTREAM_FAILURE, { value: kind, configurable: true });
  return error;
}

/** The mark of an upstream failure, if any. */
export function upstreamFailure(error: unknown): UpstreamFailure | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const kind = (error as { [UPSTREAM_FAILURE]?: unknown })[UPSTREAM_FAILURE];
  return kind === "timeout" || kind === "failure" ? kind : undefined;
}
