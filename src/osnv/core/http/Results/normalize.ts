import type { HttpContext } from "../HttpContext/HttpContext";
import { HttpResult } from "./HttpResult";

/** Per-action response defaults coming from decorators. */
export interface ResponseDefaults {
  /** `@HttpCode(...)` value. */
  httpCode?: number;
  /** `@Produces(...)` value. */
  produces?: string;
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

function isBinaryBody(body: unknown): body is Blob | Uint8Array | ArrayBuffer | ReadableStream {
  return (
    body instanceof Blob || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof ReadableStream
  );
}

/**
 * Turns whatever an action returned into a `Response` with automatic
 * Content-Type negotiation:
 *
 * - `Response` — returned as-is (full manual control);
 * - `HttpResult` — status/headers/body from the helper;
 * - `string` — text/plain (unless `@Produces` says otherwise);
 * - `Blob`/bytes/stream — binary passthrough;
 * - any other object/array/number/boolean — JSON;
 * - `undefined`/`null` — empty body, 204 (or `@HttpCode`).
 *
 * Status priority: result helper > `@HttpCode` > `ctx.res.status(...)` > default.
 * Headers from `ctx.res.header(...)` are merged into every non-raw response.
 */
export function normalizeResult(result: unknown, ctx: HttpContext, defaults: ResponseDefaults): Response {
  if (result instanceof Response) {
    return result;
  }

  const builderStatus = ctx.res.statusOverride;
  const builderHeaders = ctx.res.headers;

  let status: number;
  let body: unknown;
  let contentType: string | undefined = defaults.produces;
  let extraHeaders: readonly [string, string][] | undefined;

  if (result instanceof HttpResult) {
    status = result.status;
    body = result.body;
    contentType = result.contentType ?? defaults.produces;
    extraHeaders = result.headers;
  } else {
    body = result;
    status = defaults.httpCode ?? builderStatus ?? (result === undefined || result === null ? 204 : 200);
  }

  const headers = new Headers();
  if (extraHeaders) {
    for (const [name, value] of extraHeaders) {
      headers.append(name, value);
    }
  }
  for (const [name, value] of builderHeaders) {
    headers.append(name, value);
  }

  let payload: ResponseBody = null;
  if (body === undefined || body === null) {
    payload = null;
  } else if (typeof body === "string") {
    payload = body;
    if (!headers.has("content-type")) {
      headers.set("content-type", contentType ?? "text/plain; charset=utf-8");
    }
  } else if (isBinaryBody(body)) {
    payload = body as ResponseBody;
    if (contentType) {
      headers.set("content-type", contentType);
    }
  } else {
    payload = JSON.stringify(body);
    if (!headers.has("content-type")) {
      headers.set("content-type", contentType ?? "application/json; charset=utf-8");
    }
  }

  // 204/304 must not carry a body.
  if (status === 204 || status === 304) {
    payload = null;
  }

  return new Response(payload, { status, headers });
}
