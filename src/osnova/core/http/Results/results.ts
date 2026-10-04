import { HttpResult } from "./HttpResult";

/** 200 OK. Body optional: object -> JSON, string -> text. */
export function Ok(body?: unknown): HttpResult {
  return new HttpResult(200, body);
}

/** 201 Created with optional Location header. */
export function Created(location?: string, body?: unknown): HttpResult {
  return new HttpResult(201, body, location ? [["location", location]] : undefined);
}

/** 202 Accepted. */
export function Accepted(body?: unknown): HttpResult {
  return new HttpResult(202, body);
}

/** 204 No Content. */
export function NoContent(): HttpResult {
  return new HttpResult(204);
}

/** 400 Bad Request. */
export function BadRequest(body?: unknown): HttpResult {
  return new HttpResult(400, body ?? { error: "Bad Request" });
}

/** 401 Unauthorized. */
export function Unauthorized(body?: unknown): HttpResult {
  return new HttpResult(401, body ?? { error: "Unauthorized" });
}

/** 403 Forbidden. */
export function Forbidden(body?: unknown): HttpResult {
  return new HttpResult(403, body ?? { error: "Forbidden" });
}

/** 404 Not Found. */
export function NotFound(body?: unknown): HttpResult {
  return new HttpResult(404, body ?? { error: "Not Found" });
}

/** 409 Conflict. */
export function Conflict(body?: unknown): HttpResult {
  return new HttpResult(409, body ?? { error: "Conflict" });
}

/** 500 Internal Server Error. */
export function InternalServerError(body?: unknown): HttpResult {
  return new HttpResult(500, body ?? { error: "Internal Server Error" });
}

/** Redirect: 302 by default, 301 when `permanent`. */
export function Redirect(location: string, permanent = false): HttpResult {
  return new HttpResult(permanent ? 301 : 302, undefined, [["location", location]]);
}

/** Arbitrary status with a JSON body. */
export function StatusCode(status: number, body?: unknown): HttpResult {
  return new HttpResult(status, body);
}

/**
 * File response backed by `Bun.file` (zero-copy streaming) or an explicit
 * Blob/bytes. Content-Type is inferred by Bun for files on disk.
 */
export function File(pathOrBlob: string | Blob | Uint8Array, contentType?: string): HttpResult {
  const body = typeof pathOrBlob === "string" ? Bun.file(pathOrBlob) : pathOrBlob;
  return new HttpResult(200, body, undefined, contentType);
}
