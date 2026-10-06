/**
 * Mutable response state an action (or middleware) can shape before the
 * result is materialized into a `Response`. Available as `ctx.res` and via
 * a typed ResponseBuilder action parameter.
 *
 * Explicitly returned `Response` instances and result helpers (`Ok(...)`)
 * win over the builder's status; builder headers are merged in either way.
 */
export class ResponseBuilder {
  private statusCode?: number;
  private readonly headerList: [string, string][] = [];

  /** Overrides the response status (weaker than `@HttpCode` and result helpers). */
  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  /** Adds a response header (appended to whatever the result produces). */
  header(name: string, value: string): this {
    this.headerList.push([name, value]);
    return this;
  }

  /** Shortcut for the Content-Type header. */
  contentType(value: string): this {
    return this.header("content-type", value);
  }

  get statusOverride(): number | undefined {
    return this.statusCode;
  }

  get headers(): readonly [string, string][] {
    return this.headerList;
  }
}
