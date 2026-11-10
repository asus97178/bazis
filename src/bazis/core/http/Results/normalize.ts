import type { HttpContext } from "../HttpContext/HttpContext";
import { httpErrorOfStatus } from "../Errors/HttpError";
import { HttpResult } from "./HttpResult";

/** Per-action response defaults coming from decorators. */
export interface ResponseDefaults {
  /** `@HttpCode(...)` value. */
  httpCode?: number;
  /** `@Produces(...)` value. */
  produces?: string;
  /** `nullAs` of the route: the result that stands for `null` and `undefined`. */
  nullAs?: () => HttpResult;
  /**
   * Address of a created item for an automatic `Location` header: given the
   * `id` of a 201 body, returns the address or `undefined` when the
   * application has no GET route for it.
   */
  locate?: (ctx: HttpContext, id: string | number) => string | undefined;
}

/** `id` of a 201 body that can name the created item. */
function createdItemId(body: unknown): string | number | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body) || isBinaryBody(body)) {
    return undefined;
  }
  const id = (body as { id?: unknown }).id;
  if (typeof id === "number" && Number.isFinite(id)) {
    return id;
  }
  return typeof id === "string" && id !== "" ? id : undefined;
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
 * - `undefined`/`null` — empty body, 204 (or `@HttpCode`), unless the route says `nullAs`.
 *
 * Status priority: result helper > `@HttpCode` > `ctx.res.status(...)` > default.
 * Headers from `ctx.res.header(...)` are merged into every non-raw response.
 *
 * A 201 without `Location` whose body is an object with `id` gets
 * `Location: <request path>/<id>` when a GET route answers that address.
 */
export function normalizeResult(result: unknown, ctx: HttpContext, defaults: ResponseDefaults): Response {
  if (result instanceof Response) {
    return result;
  }
  if ((result === null || result === undefined) && defaults.nullAs !== undefined) {
    const instead = defaults.nullAs();
    // An error goes through the error handler: the standard body, in the language of the request.
    if (instead.status >= 400) throw httpErrorOfStatus(instead.status);
    result = instead;
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
  if (status === 201 && defaults.locate && !headers.has("location")) {
    const id = createdItemId(body);
    const location = id === undefined ? undefined : defaults.locate(ctx, id);
    if (location !== undefined) {
      headers.set("location", location);
    }
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
  // A known length survives HEAD: the server answers it with the headers of
  // this response and no body, and Bun would otherwise send content-length: 0.
  const length = typeof payload === "string" ? Buffer.byteLength(payload) : payload instanceof Uint8Array || payload instanceof ArrayBuffer ? payload.byteLength : undefined;
  if (length !== undefined && !headers.has("content-length")) {
    headers.set("content-length", String(length));
  }

  return new Response(payload, { status, headers });
}
