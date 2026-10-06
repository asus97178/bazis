import { HttpClientError, HttpErrorCode } from "./errors";
import { InspectableRedirectProtocol as redirectProtocol } from "./redirectProtocol";
import { InterceptorManager } from "./interceptors";
import { trackDownload } from "./progress";
import {
  appendQuery,
  basicAuthHeader,
  isBodyInit,
  mergeHeaderBags,
  resolveUrl,
  shouldPropagateCorrelation,
} from "./serialize";
import type {
  HeaderBag,
  HttpResponse,
  RequestConfig,
  RequestTransform,
  ResolvedRequestConfig,
  ResponseTransform,
} from "./types";

const DEFAULT_RETRY_ON: readonly number[] = [408, 429, 500, 502, 503, 504];
const DEFAULT_MAX_REDIRECTS = 20;
const MAX_REDIRECTS = 100;
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const SAFE_CROSS_ORIGIN_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type",
  "range",
]);
const BODY_HEADERS: readonly string[] = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
];

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * Framework-agnostic, axios-class HTTP client over `fetch`.
 *
 * Features: `baseUrl` with prefix-preserving resolution, query `params`,
 * automatic JSON request/response, `responseType` decoding, per-request
 * `timeoutMs` + cancellation, request/response interceptors, `validateStatus`,
 * Basic `auth`, `withCredentials`, idempotent retries with backoff, and
 * pluggable correlation-header propagation. No dependency on the Bazis core.
 */
export class HttpClient {
  public readonly defaults: RequestConfig;
  public readonly interceptors: {
    readonly request: InterceptorManager<ResolvedRequestConfig>;
    readonly response: InterceptorManager<HttpResponse>;
  };

  public constructor(defaults: RequestConfig = {}) {
    this.defaults = defaults;
    this.interceptors = {
      request: new InterceptorManager<ResolvedRequestConfig>(),
      response: new InterceptorManager<HttpResponse>(),
    };
  }

  /** Creates a new client whose defaults are this client's defaults merged with `config`. */
  public create(config: RequestConfig = {}): HttpClient {
    return new HttpClient(this.mergeConfig(this.defaults, config));
  }

  public static create(config: RequestConfig = {}): HttpClient {
    return new HttpClient(config);
  }

  public request<T = unknown>(config: RequestConfig): Promise<HttpResponse<T>>;
  public request<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  public request<T = unknown>(configOrUrl: RequestConfig | string, maybeConfig: RequestConfig = {}): Promise<HttpResponse<T>> {
    const config: RequestConfig =
      typeof configOrUrl === "string" ? { ...maybeConfig, url: configOrUrl } : configOrUrl;
    const merged = this.mergeConfig(this.defaults, config);

    // axios ordering: request interceptors run last-registered-first.
    let promise: Promise<ResolvedRequestConfig> = Promise.resolve(merged);
    const requestHandlers = this.interceptors.request.toArray();
    for (let i = requestHandlers.length - 1; i >= 0; i -= 1) {
      const handler = requestHandlers[i]!;
      promise = promise.then(handler.fulfilled, handler.rejected) as Promise<ResolvedRequestConfig>;
    }

    let responsePromise = promise.then((cfg) => this.dispatch<T>(cfg)) as Promise<HttpResponse<T>>;
    for (const handler of this.interceptors.response.toArray()) {
      responsePromise = responsePromise.then(
        handler.fulfilled as (value: HttpResponse<T>) => HttpResponse<T>,
        handler.rejected,
      ) as Promise<HttpResponse<T>>;
    }
    return responsePromise;
  }

  public get<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "GET", url });
  }

  public delete<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "DELETE", url });
  }

  public head<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "HEAD", url });
  }

  public options<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "OPTIONS", url });
  }

  public post<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "POST", url, data });
  }

  public put<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "PUT", url, data });
  }

  public patch<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "PATCH", url, data });
  }

  private mergeConfig(base: RequestConfig, override: RequestConfig): ResolvedRequestConfig {
    const headers = mergeHeaderBags(base.headers, override.headers);
    const merged: RequestConfig = { ...base, ...override, headers };
    // Optional values are commonly forwarded as `undefined`. Do not let that
    // accidentally erase inherited safety limits or origin/redirect policy;
    // callers can use explicit values (`0`, `"manual"`) to opt out.
    if (override.timeoutMs === undefined) {
      merged.timeoutMs = base.timeoutMs;
    }
    if (override.maxResponseBytes === undefined) {
      merged.maxResponseBytes = base.maxResponseBytes;
    }
    // An empty override is not a security opt-out: an absolute request URL
    // already bypasses prefix resolution, while the inherited base origin must
    // remain available for cross-origin credential checks.
    if (override.baseUrl === undefined || (base.baseUrl !== undefined && override.baseUrl.trim().length === 0)) {
      merged.baseUrl = base.baseUrl;
    }
    if (override.redirect === undefined) {
      merged.redirect = base.redirect;
    }
    if (override.maxRedirects === undefined) {
      merged.maxRedirects = base.maxRedirects;
    }
    if (override.inspectableRedirects === undefined) {
      merged.inspectableRedirects = base.inspectableRedirects;
    }
    if (base.params || override.params) {
      merged.params = { ...base.params, ...override.params };
    }
    if (base.retry || override.retry) {
      merged.retry = { ...base.retry, ...override.retry };
    }
    return { ...merged, method: String(override.method ?? base.method ?? "GET").toUpperCase() };
  }

  private async dispatch<T>(config: ResolvedRequestConfig): Promise<HttpResponse<T>> {
    if (config.inspectableRedirects !== undefined && typeof config.inspectableRedirects !== "boolean") {
      throw new HttpClientError("inspectableRedirects must be a boolean", { config });
    }
    validateNonNegativeSafeInteger(config.timeoutMs, "timeoutMs", config);
    validateNonNegativeSafeInteger(config.maxResponseBytes, "maxResponseBytes", config);
    const method = config.method;
    const resolvedUrl = appendQuery(resolveUrl(config.baseUrl, config.url ?? ""), config.params, config.paramsSerializer);
    const builtHeaders = this.buildHeaders(config, resolvedUrl);
    const headers = builtHeaders.values;
    let body: RequestInit["body"];
    if (!BODYLESS_METHODS.has(method)) {
      let data = config.data;
      for (const transform of toArray<RequestTransform>(config.transformRequest)) {
        data = transform(data, headers);
      }
      body = this.buildBody(data, headers);
    }
    // `transformRequest` intentionally receives a mutable header bag. Re-run
    // the origin policy afterwards so a transform cannot re-introduce auth,
    // API-key or other custom secrets that `buildHeaders` already stripped.
    if (!maySendCredentials(config, resolvedUrl)) {
      stripUnsafeCrossOriginHeaderBag(headers, builtHeaders.correlationNames);
    }

    const init: RequestInit & { duplex?: "half" } = { method, headers: toHeaders(headers) };
    if (body !== undefined) {
      init.body = body;
      // Node Fetch requires an explicit duplex mode for ReadableStream bodies.
      if (!isReplayableBody(body)) init.duplex = "half";
    }
    const credentials = config.credentials ?? (config.withCredentials ? "include" : undefined);
    if (credentials) {
      init.credentials = maySendCredentials(config, resolvedUrl) ? credentials : "omit";
    }
    if (config.cache) init.cache = config.cache;
    if (config.mode) init.mode = config.mode;
    if (config.keepalive !== undefined) init.keepalive = config.keepalive;

    const fetchImpl = config.fetch ?? globalThis.fetch;
    const transport = await this.execute(fetchImpl, resolvedUrl, init, config, builtHeaders.correlationNames);
    const raw = transport.response;
    let readFailure: unknown;
    let response = enforceResponseLimit(raw, config, error => { readFailure = error; });

    const validate = config.validateStatus;
    let ok: boolean;
    try {
      ok = validate === null ? true : (validate ?? defaultValidateStatus)(response.status);
    } catch (error) {
      cancelResponseBody(response);
      throw error;
    }
    // Normalize only body-read failures. User callbacks retain their exceptions,
    // even if they throw a TimeoutError or abort the caller's signal themselves.
    const rejectRead = (error: unknown): never => {
      // Browser Response consumers can replace a stream's original error with
      // TypeError. Preserve the reason observed by our reader before that loss.
      throw responseReadError(readFailure ?? error, config, transport.signal);
    };
    if (config.onDownloadProgress && config.responseType !== "stream") {
      response = await trackDownload(response, config.onDownloadProgress, rejectRead);
    }
    let decoded = await decodeBody(response, config, ok, raw, rejectRead);
    for (const transform of toArray<ResponseTransform>(config.transformResponse)) {
      decoded = transform(decoded, response.headers, response.status);
    }
    const data = decoded as T;
    const result: HttpResponse<T> = {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      config,
      raw,
    };

    if (!ok) {
      throw new HttpClientError(`Request failed with status ${response.status}`, {
        config,
        code: HttpErrorCode.BadStatus,
        status: response.status,
        response: result,
      });
    }
    return result;
  }

  private buildHeaders(
    config: ResolvedRequestConfig,
    resolvedUrl: string,
  ): { readonly values: HeaderBag; readonly correlationNames: readonly string[] } {
    let correlation: HeaderBag | undefined;
    if (config.correlationHeaders) {
      const policy = config.propagateCorrelation ?? "same-origin";
      if (shouldPropagateCorrelation(resolvedUrl, policy, config.baseUrl)) {
        correlation = config.correlationHeaders();
      }
    }
    const headers = mergeHeaderBags(correlation, config.headers);
    const allowCredentials = maySendCredentials(config, resolvedUrl);
    if (config.auth && allowCredentials) {
      headers["authorization"] = basicAuthHeader(config.auth.username, config.auth.password);
    }
    if (!allowCredentials) {
      stripUnsafeCrossOriginHeaderBag(headers, Object.keys(correlation ?? {}));
    }
    return {
      values: headers,
      correlationNames: Object.keys(correlation ?? {}).map((name) => name.toLowerCase()),
    };
  }

  private buildBody(data: unknown, headers: HeaderBag): RequestInit["body"] {
    if (data === undefined || data === null) {
      return undefined;
    }
    if (isBodyInit(data)) {
      return data as RequestInit["body"];
    }
    if (!("content-type" in headers)) {
      headers["content-type"] = "application/json";
    }
    return JSON.stringify(data);
  }

  private async execute(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    config: ResolvedRequestConfig,
    correlationHeaderNames: readonly string[],
  ): Promise<{ response: Response; signal: AbortSignal | undefined }> {
    const userSignal = config.signal ?? undefined;
    const timeoutMs = config.timeoutMs ?? 0;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    const retry = config.retry;
    const configuredRetries = retry?.maxRetries ?? 0;
    const maxRetries = IDEMPOTENT_METHODS.has(config.method)
      && isReplayableBody(init.body)
      && Number.isFinite(configuredRetries)
      ? Math.min(100, Math.max(0, Math.floor(configuredRetries)))
      : 0;
    const configuredBackoff = retry?.backoffMs ?? 100;
    const backoffMs = Number.isFinite(configuredBackoff) && configuredBackoff >= 0
      ? Math.min(configuredBackoff, 2_147_483_647)
      : 100;
    const retryOn = new Set(retry?.retryOn ?? DEFAULT_RETRY_ON);
    const redirectMode = config.redirect ?? "follow";
    const maxRedirects = redirectMode === "follow" ? resolveMaxRedirects(config) : 0;
    const browserInit = browserRedirectInit(url, init, config, redirectMode, maxRedirects, correlationHeaderNames);

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const remainingMs = deadline === undefined ? 0 : deadline - Date.now();
      if (deadline !== undefined && remainingMs <= 0) {
        throw timeoutError(config, timeoutMs, lastError);
      }
      const signal = buildSignal(remainingMs, userSignal);
      try {
        const response = browserInit ? await fetchImpl(url, { ...browserInit, signal }) : await this.executeRedirectChain(
          fetchImpl,
          url,
          init,
          config,
          redirectMode,
          maxRedirects,
          correlationHeaderNames,
          signal,
        );
        if (attempt < maxRetries && retryOn.has(response.status)) {
          const retryDelay = retryDelayMs(response, exponentialBackoff(backoffMs, attempt));
          cancelResponseBody(response);
          await waitForRetry(retryDelay, userSignal, deadline, config, timeoutMs);
          continue;
        }
        return { response, signal };
      } catch (error) {
        lastError = error;
        if (error instanceof HttpClientError) {
          throw error;
        }
        if (userSignal?.aborted) {
          throw new HttpClientError("Request canceled", { config, code: HttpErrorCode.Canceled, cause: error });
        }
        // WebKit may reject fetch with TypeError instead of forwarding the
        // timeout reason. The signal remains authoritative, including body reads.
        if (isTimeout(error) || (signal?.aborted && isTimeout(signal.reason))) {
          if (attempt < maxRetries) {
            await waitForRetry(exponentialBackoff(backoffMs, attempt), userSignal, deadline, config, timeoutMs);
            continue;
          }
          throw new HttpClientError(`Request timed out after ${timeoutMs}ms`, {
            config,
            code: HttpErrorCode.Timeout,
            cause: error,
          });
        }
        if (attempt >= maxRetries) {
          throw new HttpClientError(messageOf(error) ?? "Network request failed", {
            config,
            code: HttpErrorCode.Network,
            cause: error,
          });
        }
        await waitForRetry(exponentialBackoff(backoffMs, attempt), userSignal, deadline, config, timeoutMs);
      }
    }
    throw new HttpClientError(messageOf(lastError) ?? "Network request failed", {
      config,
      code: HttpErrorCode.Network,
      cause: lastError,
    });
  }

  private async executeRedirectChain(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    config: ResolvedRequestConfig,
    redirectMode: NonNullable<RequestInit["redirect"]>,
    maxRedirects: number,
    correlationHeaderNames: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    let redirects = 0;

    while (true) {
      const inspectable = config.inspectableRedirects === true && redirectMode === "follow";
      const requestInit = inspectable ? inspectableRequestInit(currentInit) : currentInit;
      const response = await fetchImpl(
        currentUrl,
        signal ? { ...requestInit, signal, redirect: "manual" } : requestInit,
      );
      if (response.type === "opaqueredirect") {
        if (redirectMode === "manual") {
          return response;
        }
        throw notInspectable(config, "Fetch hides this redirect; exact limits require inspectableRedirects on both client and server");
      }
      const status = inspectable ? inspectableResponseStatus(response, config) : response.status;
      if (!REDIRECT_STATUSES.has(status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (location === null) {
        return response;
      }
      if (redirectMode === "manual") {
        return response;
      }
      if (redirectMode === "error") {
        cancelResponseBody(response);
        throw redirectError(config, "Redirects are disabled for this request");
      }
      if (redirects >= maxRedirects) {
        cancelResponseBody(response);
        throw new HttpClientError(`Request exceeded ${maxRedirects} redirects`, {
          config,
          code: HttpErrorCode.TooManyRedirects,
        });
      }

      cancelResponseBody(response);
      const redirectBaseUrl = resolveRedirectBaseUrl(currentUrl, response, config);
      const nextUrl = resolveRedirectUrl(location, redirectBaseUrl, config);
      const nextInit = redirectedRequestInit(
        currentInit,
        status,
        redirectBaseUrl,
        nextUrl,
        config,
        correlationHeaderNames,
      );
      currentUrl = nextUrl;
      currentInit = nextInit;
      redirects += 1;
    }
  }
}

function browserRedirectInit(
  url: string,
  init: RequestInit,
  config: ResolvedRequestConfig,
  redirect: NonNullable<RequestInit["redirect"]>,
  maxRedirects: number,
  correlationHeaderNames: readonly string[],
): RequestInit | undefined {
  // Window and Worker fetch hide every manual redirect behind an opaque
  // response, even on the same origin. Let the browser follow only when it
  // can enforce the origin boundary before dispatching the next request.
  const browserLocation = (globalThis as { location?: { href: string; origin: string } }).location;
  if (!browserLocation) return undefined;
  if (redirect !== "follow") return { ...init, redirect };
  if (config.inspectableRedirects) return undefined;
  if (maxRedirects === 0) return { ...init, redirect: "error" };
  // Native Fetch follows at most 20 hops, so larger budgets are safe too.
  // A smaller budget requires visible manual hops: ordinary responses still
  // work, but an opaque redirect must fail before any uncounted follow.
  if (maxRedirects < DEFAULT_MAX_REDIRECTS) return undefined;
  const headers = new Headers(init.headers);
  const restrictedCorrelation = config.propagateCorrelation !== "all"
    && correlationHeaderNames.some((name) => headers.has(name));
  if (config.allowCrossOriginCredentials && !restrictedCorrelation) {
    return { ...init, redirect: "follow" };
  }
  const target = new URL(url, browserLocation.href);
  const samePageOrigin = target.origin !== "null" && target.origin === browserLocation.origin;
  const headersSafeToRedirect = [...headers.keys()].every((name) => SAFE_CROSS_ORIGIN_HEADERS.has(name)
    // Fetch itself removes Authorization at a cross-origin redirect. It does
    // not strip arbitrary API-key or correlation headers.
    || name === "authorization"
    || (config.propagateCorrelation === "all" && correlationHeaderNames.includes(name)));
  if (headersSafeToRedirect && !restrictedCorrelation && init.body == null && init.credentials !== "include") {
    return { ...init, redirect: "follow", credentials: samePageOrigin ? init.credentials ?? "same-origin" : "omit" };
  }
  if (samePageOrigin) {
    return { ...init, redirect: "follow", mode: "same-origin" };
  }
  // An authenticated foreign API may still return an ordinary CORS response.
  // Its hidden redirect cannot be followed safely without an explicit opt-in.
  return undefined;
}

function inspectableRequestInit(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(redirectProtocol.header, redirectProtocol.version);
  return { ...init, headers, redirect: "manual", cache: "no-store" };
}

function inspectableResponseStatus(response: Response, config: RequestConfig): number {
  const encoded = response.headers.get(redirectProtocol.statusHeader);
  if (response.headers.get(redirectProtocol.header) !== redirectProtocol.version) {
    // An HTTP error cannot conceal a negotiated redirect (its wire status is
    // always 200). Preserve errors emitted before/after the server pipeline.
    if (response.status >= 400 && encoded === null) return response.status;
    cancelResponseBody(response);
    throw notInspectable(config, "The peer did not acknowledge inspectable redirects; enable the option on the server and allow its CORS headers");
  }
  if (encoded === null) return response.status;
  const status = Number(encoded);
  if (response.status !== 200 || !REDIRECT_STATUSES.has(status) || encoded !== String(status) || !response.headers.has("location")) {
    cancelResponseBody(response);
    throw notInspectable(config, "Invalid inspectable redirect metadata");
  }
  return status;
}

function notInspectable(config: RequestConfig, message: string): HttpClientError {
  return new HttpClientError(message, { config, code: HttpErrorCode.RedirectNotInspectable });
}

function resolveMaxRedirects(config: ResolvedRequestConfig): number {
  const configured = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(configured) || configured < 0 || configured > MAX_REDIRECTS) {
    throw new HttpClientError(`maxRedirects must be an integer between 0 and ${MAX_REDIRECTS}`, { config });
  }
  return configured;
}

function resolveRedirectUrl(
  location: string,
  baseUrl: string,
  config: ResolvedRequestConfig,
): string {
  try {
    const target = new URL(location, baseUrl);
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) {
      throw new TypeError("Only credential-free HTTP(S) redirect URLs are supported");
    }
    return target.toString();
  } catch (error) {
    throw redirectError(config, "Invalid redirect URL", error);
  }
}

function resolveRedirectBaseUrl(
  currentUrl: string,
  response: Response,
  config: ResolvedRequestConfig,
): string {
  if (absoluteUrl(currentUrl)) {
    return currentUrl;
  }
  if (absoluteUrl(response.url)) {
    return response.url;
  }
  throw redirectError(config, "Redirect base URL is not available");
}

function redirectedRequestInit(
  init: RequestInit,
  status: number,
  currentUrl: string,
  nextUrl: string,
  config: ResolvedRequestConfig,
  correlationHeaderNames: readonly string[],
): RequestInit {
  const headers = new Headers(init.headers);
  let method = String(init.method ?? "GET").toUpperCase();
  let body = init.body;
  const switchesToGet = ((status === 301 || status === 302) && method === "POST")
    || (status === 303 && method !== "GET" && method !== "HEAD");

  if (switchesToGet) {
    method = "GET";
    body = undefined;
    for (const name of BODY_HEADERS) {
      headers.delete(name);
    }
  } else if (body !== undefined && body !== null && !isReplayableBody(body)) {
    throw new HttpClientError("Redirect cannot safely replay the request body", {
      config,
      code: HttpErrorCode.RedirectBodyNotReplayable,
    });
  }

  let credentials = init.credentials;
  const crossesOrigin = !sameOrigin(currentUrl, nextUrl);
  if (
    crossesOrigin &&
    !config.allowCrossOriginCredentials &&
    body !== undefined &&
    body !== null
  ) {
    throw new HttpClientError(
      "Cross-origin redirect cannot safely replay the request body without allowCrossOriginCredentials",
      { config, code: HttpErrorCode.RedirectBodyNotReplayable },
    );
  }
  if (!config.allowCrossOriginCredentials && crossesOrigin) {
    const policy = config.propagateCorrelation ?? "same-origin";
    const allowedCorrelationNames = shouldPropagateCorrelation(nextUrl, policy, config.baseUrl)
      ? correlationHeaderNames
      : [];
    stripUnsafeCrossOriginHeaders(headers, allowedCorrelationNames);
    credentials = "omit";
  }
  if (correlationHeaderNames.length > 0) {
    const policy = config.propagateCorrelation ?? "same-origin";
    if (!shouldPropagateCorrelation(nextUrl, policy, config.baseUrl)) {
      for (const name of correlationHeaderNames) {
        headers.delete(name);
      }
    }
  }

  return { ...init, method, body, headers, credentials, redirect: "manual" };
}

function isReplayableBody(body: RequestInit["body"]): boolean {
  if (body === undefined || body === null) {
    return true;
  }
  return !(typeof (body as { getReader?: unknown }).getReader === "function"
    || (typeof ReadableStream !== "undefined" && body instanceof ReadableStream));
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function absoluteUrl(value: string): boolean {
  try {
    return new URL(value).origin !== "null";
  } catch {
    return false;
  }
}

function cancelResponseBody(response: Response): void {
  // Cancellation closes the stream immediately, but the producer's cleanup
  // promise need not settle. It must not retain a retry, redirect or deadline.
  void response.body?.cancel().catch(() => undefined);
}

function redirectError(config: RequestConfig, message: string, cause?: unknown): HttpClientError {
  return new HttpClientError(message, {
    config,
    code: HttpErrorCode.Network,
    cause,
  });
}

function maySendCredentials(config: ResolvedRequestConfig, resolvedUrl: string): boolean {
  if (config.allowCrossOriginCredentials || !config.baseUrl) {
    return true;
  }
  try {
    return new URL(config.baseUrl).origin === new URL(resolvedUrl).origin;
  } catch {
    return false;
  }
}

function stripUnsafeCrossOriginHeaderBag(headers: HeaderBag, allowedCorrelationNames: readonly string[]): void {
  const allowed = new Set(allowedCorrelationNames.map((name) => name.toLowerCase()));
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (!SAFE_CROSS_ORIGIN_HEADERS.has(normalized) && !allowed.has(normalized)) {
      delete headers[name];
    }
  }
}

function stripUnsafeCrossOriginHeaders(headers: Headers, allowedCorrelationNames: readonly string[]): void {
  const allowed = new Set(allowedCorrelationNames.map((name) => name.toLowerCase()));
  const remove: string[] = [];
  headers.forEach((_value, name) => {
    const normalized = name.toLowerCase();
    if (!SAFE_CROSS_ORIGIN_HEADERS.has(normalized) && !allowed.has(normalized)) {
      remove.push(name);
    }
  });
  for (const name of remove) {
    headers.delete(name);
  }
}

function validateNonNegativeSafeInteger(
  value: number | undefined,
  field: "timeoutMs" | "maxResponseBytes",
  config: RequestConfig,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new HttpClientError(`${field} must be a non-negative safe integer`, { config });
  }
}

function enforceResponseLimit(
  response: Response,
  config: ResolvedRequestConfig,
  captureReadFailure: (error: unknown) => void,
): Response {
  const configured = config.maxResponseBytes;
  if (configured === undefined || configured === 0) {
    return response;
  }
  // HEAD and bodyless statuses may legitimately advertise the size of the
  // corresponding representation. A response cap limits bytes actually
  // readable by the client, not metadata for a body that is absent.
  if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
    return response;
  }
  const advertised = Number(response.headers.get("content-length"));
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  // Fetch may decode the body while retaining the encoded Content-Length.
  // Only identity representations allow this early check; the stream below
  // always counts the bytes actually exposed to the caller, including gzip.
  // A CORS response can expose Content-Length while hiding Content-Encoding.
  const identityLength = encoding === "identity" || (!encoding && response.type !== "cors");
  if (identityLength && Number.isFinite(advertised) && advertised > configured) {
    cancelResponseBody(response);
    throw responseTooLargeError(config, configured);
  }

  const reader = response.body.getReader();
  let received = 0;
  let finished = false;
  const finish = (cancel: boolean, reason?: unknown): void => {
    if (finished) return;
    finished = true;
    if (cancel) void reader.cancel(reason).catch(() => undefined);
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (finished) return;
        if (item.done) {
          finish(false);
          controller.close();
          return;
        }
        received += item.value.byteLength;
        if (received > configured) {
          const error = responseTooLargeError(config, configured);
          captureReadFailure(error);
          finish(true);
          controller.error(error);
          return;
        }
        controller.enqueue(item.value);
      } catch (error) {
        if (finished) return;
        captureReadFailure(error);
        finish(true, error);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish(true, reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function responseTooLargeError(config: RequestConfig, maxBytes: number): HttpClientError {
  return new HttpClientError(`Response exceeded ${maxBytes} bytes`, {
    config,
    code: HttpErrorCode.ResponseTooLarge,
  });
}

function timeoutError(config: RequestConfig, timeoutMs: number, cause?: unknown): HttpClientError {
  return new HttpClientError(`Request timed out after ${timeoutMs}ms`, {
    config,
    code: HttpErrorCode.Timeout,
    cause,
  });
}

function retryDelayMs(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) {
    return fallbackMs;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(2_147_483_647, seconds * 1_000);
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.min(2_147_483_647, Math.max(0, date - Date.now())) : fallbackMs;
}

function exponentialBackoff(baseMs: number, attempt: number): number {
  return Math.min(2_147_483_647, baseMs * 2 ** Math.min(attempt, 30));
}

async function waitForRetry(
  ms: number,
  userSignal: AbortSignal | undefined,
  deadline: number | undefined,
  config: RequestConfig,
  timeoutMs: number,
): Promise<void> {
  const remainingMs = deadline === undefined ? 0 : deadline - Date.now();
  if (deadline !== undefined && remainingMs <= 0) {
    throw timeoutError(config, timeoutMs);
  }
  try {
    await delay(ms, buildSignal(remainingMs, userSignal));
  } catch (error) {
    if (userSignal?.aborted) {
      throw new HttpClientError("Request canceled", { config, code: HttpErrorCode.Canceled, cause: error });
    }
    if (isTimeout(error) || (deadline !== undefined && Date.now() >= deadline)) {
      throw timeoutError(config, timeoutMs, error);
    }
    throw error;
  }
}

function toArray<F>(value: F | readonly F[] | undefined): readonly F[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value as F];
}

function buildSignal(timeoutMs: number, userSignal?: AbortSignal): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (userSignal) {
    signals.push(userSignal);
  }
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

function toHeaders(bag: HeaderBag): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(bag)) {
    headers.set(key, value);
  }
  return headers;
}

async function decodeBody(
  response: Response,
  config: ResolvedRequestConfig,
  statusAccepted: boolean,
  raw: Response,
  rejectRead: (error: unknown) => never,
): Promise<unknown> {
  const responseType = config.responseType;
  if (responseType === "stream") {
    return response.body;
  }
  if (responseType === "arrayBuffer") {
    return response.arrayBuffer().catch(rejectRead);
  }
  if (responseType === "blob") {
    return response.blob().catch(rejectRead);
  }
  if (response.status === 204 || response.status === 205 || response.headers.get("content-length") === "0") {
    return undefined;
  }
  const text = await response.text().catch(rejectRead);
  if (responseType === "text") return text;
  // Infer from content-type.
  const contentType = response.headers.get("content-type") ?? "";
  if (responseType === "json" || contentType.includes("application/json") || contentType.includes("+json")) {
    return parseJsonSafe(text, raw, config, statusAccepted);
  }
  return text;
}

function parseJsonSafe(text: string, raw: Response, config: ResolvedRequestConfig, statusAccepted: boolean): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    // A malformed error page still carries useful HTTP status and headers.
    // Retain the already-read text for diagnostics, without cloning
    // or reading the transport body a second time.
    throw new HttpClientError(
      statusAccepted ? "Response contains invalid JSON" : `Request failed with status ${raw.status}`,
      {
        config,
        code: statusAccepted ? HttpErrorCode.BadResponse : HttpErrorCode.BadStatus,
        response: {
          data: text,
          status: raw.status,
          statusText: raw.statusText,
          headers: raw.headers,
          config,
          raw,
        },
        cause,
      },
    );
  }
}

function responseReadError(error: unknown, config: ResolvedRequestConfig, signal?: AbortSignal): HttpClientError {
  if (error instanceof HttpClientError) return error;
  if (config.signal?.aborted) {
    return new HttpClientError("Request canceled", { config, code: HttpErrorCode.Canceled, cause: error });
  }
  if (isTimeout(error) || (signal?.aborted && isTimeout(signal.reason))) {
    return timeoutError(config, config.timeoutMs ?? 0, error);
  }
  return new HttpClientError(messageOf(error) ?? "Response body read failed", {
    config,
    code: HttpErrorCode.Network,
    cause: error,
  });
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "TimeoutError";
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
