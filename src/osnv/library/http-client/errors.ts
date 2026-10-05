import type { HttpResponse, RequestConfig } from "./types";

/** Stable error codes (axios-compatible names where applicable). */
export const HttpErrorCode = {
  /** Caller aborted via `signal`. */
  Canceled: "ERR_CANCELED",
  /** Request exceeded `timeoutMs`. */
  Timeout: "ETIMEDOUT",
  /** Transport failure (DNS, connection reset, CORS, …). */
  Network: "ERR_NETWORK",
  /** `validateStatus` rejected the response status. */
  BadStatus: "ERR_BAD_STATUS",
  /** An accepted response could not be decoded as JSON. */
  BadResponse: "ERR_BAD_RESPONSE",
  /** Response body exceeded `maxResponseBytes`. */
  ResponseTooLarge: "ERR_RESPONSE_TOO_LARGE",
  /** A redirect chain exceeded `maxRedirects`. */
  TooManyRedirects: "ERR_TOO_MANY_REDIRECTS",
  /** The transport hides a redirect or does not acknowledge its protocol. */
  RedirectNotInspectable: "ERR_REDIRECT_NOT_INSPECTABLE",
  /** A redirect cannot safely replay its request body. */
  RedirectBodyNotReplayable: "ERR_REDIRECT_BODY_NOT_REPLAYABLE",
} as const;

export type HttpErrorCode = (typeof HttpErrorCode)[keyof typeof HttpErrorCode];

/**
 * axios-style error: carries the originating {@link RequestConfig}, a stable
 * {@link code}, and (for status failures) the full {@link HttpResponse}.
 */
export class HttpClientError<T = unknown> extends Error {
  public readonly config?: RequestConfig;
  public readonly code?: HttpErrorCode;
  public readonly status?: number;
  public readonly response?: HttpResponse<T>;

  public constructor(
    message: string,
    options: {
      readonly config?: RequestConfig;
      readonly code?: HttpErrorCode;
      readonly status?: number;
      readonly response?: HttpResponse<T>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HttpClientError";
    this.config = options.config;
    this.code = options.code;
    this.status = options.status ?? options.response?.status;
    this.response = options.response;
  }

  /** True when the error represents a non-2xx (or `validateStatus`-rejected) response. */
  public get isStatusError(): boolean {
    return this.code === HttpErrorCode.BadStatus;
  }
}

/** Thrown when a named client is requested but was never registered. */
export class HttpClientConfigError extends Error {
  public constructor(name: string, known: readonly string[]) {
    const hint = known.length > 0 ? `known clients: ${known.join(", ")}` : "no named clients registered";
    super(`HttpClient "${name}" is not configured (${hint})`);
    this.name = "HttpClientConfigError";
  }
}
