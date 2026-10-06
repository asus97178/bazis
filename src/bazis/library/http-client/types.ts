/**
 * Pure, framework-agnostic HTTP client types. No dependency on the Bazis core
 * or runtime — the library works anywhere `fetch` exists (Bun, browsers, Node 18+).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** How the response body is decoded into {@link HttpResponse.data}. */
export type ResponseType = "json" | "text" | "arrayBuffer" | "blob" | "stream";

export type ParamPrimitive = string | number | boolean;
export type ParamValue = ParamPrimitive | null | undefined;
/** Query parameters; array values expand to repeated keys by default. */
export type RequestParams = Record<string, ParamValue | readonly ParamValue[]>;

/** Plain header bag; values are sent verbatim (case-insensitive merge). */
export type HeaderBag = Record<string, string>;

/**
 * Correlation header propagation policy (security-by-default): controls which
 * hosts receive headers from {@link RequestConfig.correlationHeaders}.
 * - `"same-origin"` (default): only the exact `baseUrl` scheme/host/port
 *   (none without a baseUrl);
 * - `"all"`: every host (internal-only meshes);
 * - `string[]`: only the listed hostnames.
 */
export type CorrelationPropagation = "same-origin" | "all" | readonly string[];

export interface RetryOptions {
  /** Extra attempts after the first try (idempotent methods only). Default: 0. */
  readonly maxRetries?: number;
  /** Base backoff in ms; grows exponentially per attempt. Default: 100. */
  readonly backoffMs?: number;
  /** Response statuses that trigger a retry. Default: 408, 429, 500, 502, 503, 504. */
  readonly retryOn?: readonly number[];
}

export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

/** Download progress event (upload progress is not supported by `fetch`). */
export interface ProgressEvent {
  /** Bytes received so far. */
  readonly loaded: number;
  /** Total bytes from `Content-Length`, if known. */
  readonly total?: number;
  /** Completion ratio `0..1` when {@link total} is known. */
  readonly progress?: number;
  /** Bytes in the most recent chunk. */
  readonly bytes: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

/** Mutates/replaces the request body before encoding; may mutate `headers`. */
export type RequestTransform = (data: unknown, headers: HeaderBag) => unknown;

/** Transforms the decoded response data before it is delivered. */
export type ResponseTransform = (data: unknown, headers: Headers, status: number) => unknown;

/**
 * Per-request configuration. Mirrors the axios config surface (baseUrl, params,
 * data, headers, timeout, responseType, validateStatus, auth, withCredentials,
 * interceptors) plus first-class retries and correlation propagation.
 */
export interface RequestConfig {
  /** Request URL; resolved against {@link baseUrl} (prefix preserved). */
  url?: string;
  method?: HttpMethod | string;
  /** Base URL prefix; absolute `url`s bypass it. */
  baseUrl?: string;
  headers?: HeaderBag;
  /** Query parameters appended to the URL. */
  params?: RequestParams;
  /** Custom query serializer; defaults to repeated keys for arrays. */
  paramsSerializer?: (params: RequestParams) => string;
  /** Request body. Plain objects are JSON-encoded; `BodyInit` is sent as-is. */
  data?: unknown;
  /** Pre-process the request body (applied in order before encoding). */
  transformRequest?: RequestTransform | readonly RequestTransform[];
  /** Post-process the decoded response data (applied in order). */
  transformResponse?: ResponseTransform | readonly ResponseTransform[];
  /** Download progress callback (reads the body stream to report bytes). */
  onDownloadProgress?: ProgressListener;
  /** Non-negative safe integer timeout in ms. Default: 0 (disabled at the library level). */
  timeoutMs?: number;
  /** Cap on bytes read after Fetch decoding (including decompression). Non-negative safe integer; `0`/undefined disables it. */
  maxResponseBytes?: number;
  /** Caller cancellation signal; combined with the timeout. */
  signal?: AbortSignal | null;
  /** Expected response decoding. Default: inferred from `content-type`. */
  responseType?: ResponseType;
  /** Sets `credentials: "include"` when true. */
  withCredentials?: boolean;
  /** Fine-grained fetch credentials (overrides {@link withCredentials}). */
  credentials?: RequestInit["credentials"];
  /** HTTP Basic auth; adds an `Authorization` header. */
  auth?: BasicAuth;
  /**
   * Allow custom/auth/cookie headers on an absolute URL or redirect outside
   * `baseUrl`'s origin, and allow a redirect to replay a request body there.
   * Disabled by default to prevent secret exfiltration.
   */
  allowCrossOriginCredentials?: boolean;
  /**
   * Returns `true` for statuses that resolve (others reject with
   * {@link HttpClientError}). Default: `status >= 200 && status < 300`.
   * Pass `null` to never reject on status.
   */
  validateStatus?: ((status: number) => boolean) | null;
  /** Resilience policy for idempotent requests. */
  retry?: RetryOptions;
  /** Correlation header propagation policy. Default: `"same-origin"`. */
  propagateCorrelation?: CorrelationPropagation;
  /** Supplies correlation headers (e.g. from a runtime context). */
  correlationHeaders?: () => HeaderBag;
  /** Custom fetch implementation (testing / instrumentation). */
  fetch?: typeof fetch;
  /**
   * Negotiate inspectable redirects with an Bazis HTTP server that has the
   * same option enabled. Default: false. Applies only to redirect: "follow".
   * Enforces maxRedirects exactly (0–100), including in browsers. Successful
   * responses must acknowledge the protocol; CORS, origin and body replay rules
   * still apply. Disables HTTP caching for this explicitly negotiated mode.
   */
  inspectableRedirects?: boolean;
  /**
   * Redirect behavior. Bun/Node follow hop-by-hop and strip foreign secrets.
   * Browsers follow bodyless requests with safe headers; native Fetch strips
   * Authorization on a foreign redirect and omits foreign cookies. Requests
   * carrying custom secrets, bodies or credentials: "include" follow only
   * within the page/worker origin unless allowCrossOriginCredentials is set.
   * Restricted correlation headers remain guarded. A foreign API can return
   * an ordinary CORS response without opt-in. Manual redirects are opaque
   * (status 0). Uninspectable manual hops use ERR_REDIRECT_NOT_INSPECTABLE;
   * native follow failures use ERR_NETWORK. See inspectableRedirects for the
   * negotiated alternative with per-hop checks.
   */
  redirect?: RequestInit["redirect"];
  /**
   * Maximum redirects per attempt. Default: 20; allowed range: 0–100.
   * Bun/Node enforce the exact cap. Browsers use redirect: "error" for 0 and
   * their native cap of 20 for budgets >= 20. With 1–19, ordinary responses
   * work but hidden redirects fail with ERR_REDIRECT_NOT_INSPECTABLE before
   * following. With inspectableRedirects, the exact cap works in browsers too.
   * No probe or duplicate request is sent.
   */
  maxRedirects?: number;
  cache?: RequestInit["cache"];
  mode?: RequestInit["mode"];
  keepalive?: boolean;
  /** Arbitrary metadata carried through interceptors (not sent). */
  meta?: Record<string, unknown>;
}

/** Config after merging client defaults with the per-request config. */
export type ResolvedRequestConfig = RequestConfig & { method: string };

/** axios-style response envelope. */
export interface HttpResponse<T = unknown> {
  readonly data: T;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly config: ResolvedRequestConfig;
  /**
   * The original Fetch `Response`, retaining URL/type/redirect metadata.
   * Its body may be consumed or locked by the response limit/progress reader.
   * With `responseType: "stream"`, consume or cancel `data` to respect the limit.
   */
  readonly raw: Response;
}
