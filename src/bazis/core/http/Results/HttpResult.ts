/**
 * An action result: a recipe for building the final `Response`.
 * Returned by the fluent helpers (`Ok`, `Created`, `NotFound`, ...).
 */
export class HttpResult {
  constructor(
    readonly status: number,
    /** Body value: object/array -> JSON, string -> text, Blob/bytes -> as-is, undefined -> empty. */
    readonly body?: unknown,
    readonly headers?: readonly [string, string][],
    /** Explicit Content-Type (overrides automatic negotiation). */
    readonly contentType?: string,
  ) {}

  /** Returns a copy with an extra header. */
  withHeader(name: string, value: string): HttpResult {
    return new HttpResult(this.status, this.body, [...(this.headers ?? []), [name, value]], this.contentType);
  }
}
