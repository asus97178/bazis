import type { Class, HostedService, ServiceProvider, ServiceResolver, ServiceScope } from "../di";
import { loadBazisGeneratedRuntime } from "../generatedRuntime";
import { Environment, HealthService, LOGGER, StartupReport, type HealthReport } from "../kernel";
import { redactSensitive } from "../../library/redaction";
import { HttpContext } from "./HttpContext/HttpContext";
import { holdResponseScope } from "./HttpContext/responseLifetime";
import { inspectableRedirectResponse } from "./HttpContext/inspectableRedirects";
import { accessLog } from "./Middleware/accessLog";
import { cors, corsOptionsOf, isPreflight, preflightResponse, type CorsOptions } from "./Middleware/cors";
import { isCorrelationIdMiddleware } from "./correlation/createCorrelationIdMiddleware";
import { errorHandler } from "./Middleware/errorHandler";
import { runPipeline } from "./Middleware/pipeline";
import { applySecurityHeaders, securityHeaders } from "./Middleware/securityHeaders";
import type { HttpMiddleware } from "./Middleware/types";
import { prepareOpenApiDocs, serveOpenApiDocs } from "./OpenApi/openApiDocs";
import type { PreparedOpenApiDocs } from "../../library/openapi";
import { RouterBuilder } from "./Routing/RouterBuilder";
import { defaultAuthorizeChecks } from "./Authorization/metadata";
import type { Router } from "./Routing/Router";
import { parseRequestPath } from "./Routing/template";
import { assertVersioningOptions, createVersionReader, type VersionReader } from "./Versioning/VersionReader";
import { HTTP_ERROR_HOOK, ROUTE_MIDDLEWARE_COMPOSER, SERVER_MIDDLEWARE, sortByOrder } from "./middlewareTokens";
import type { HealthEndpointOptions, RouteMiddlewareComposer, HttpModuleOptions, HttpServerOptions } from "./options";
import { WEBSOCKET_UPGRADE, type WebSocketUpgrade } from "./WebSocketUpgrade";
import { HttpSetupError } from "./Errors/HttpError";
import { clientAddress, trustedProxies, type TrustedProxies } from "./HttpContext/clientAddress";
import { EN_HTTP_MESSAGES, formatMessage, languageHeaders, type HttpMessageKey, type MessageParams, type SelectedLanguage } from "./Errors/messages";
import { getModelValidator, type ModelValidator } from "./Binding/modelValidator";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_REQUEST_SCOPE_DISPOSE_TIMEOUT_MS = 5_000;

interface ListenOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly idleTimeout?: number;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** The client's address (after trusted proxies) and the connection's own. */
interface ClientConnection {
  readonly clientIp?: string;
  readonly peerIp?: string;
}

/** HEAD responses must carry no body, only headers/status. */
function stripBody(response: Response): Response {
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  // A GET fallback may have returned a file/upstream stream. Explicitly cancel
  // it so HEAD does not leave the producer or an outbound connection hanging.
  // An asynchronous producer may never acknowledge cancellation. HEAD must
  // still return its status/headers; observe cleanup without awaiting it.
  void response.body.cancel().catch(() => undefined);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The HTTP host: a regular `HostedService` (phase 10 by default, so it
 * starts after infrastructure and stops first).
 *
 * Startup builds the router and all per-route pipelines once; request
 * dispatch is: parse path -> radix match -> create DI scope -> run the
 * precompiled chain -> finish response producer -> dispose scope.
 * All responses retain the native Bun body path. JS producers retain their
 * scope until EOF, error, cancellation or disconnect; materialized/native
 * bodies release it after Bun takes ownership.
 * Built-in security/CORS/error/access-log
 * middleware also wraps framework-generated short-circuit responses.
 */
export class HttpServer implements HostedService {
  readonly phase: number;

  private server?: ReturnType<typeof Bun.serve>;
  private router?: Router;
  private readVersion: VersionReader = () => undefined;
  /** CORS options for every preflight: `cors` or a `cors()` among the global middleware. */
  private globalCors: CorsOptions | undefined;
  /** Body cap in bytes; `undefined` when the limit is disabled (`maxBodyBytes: 0`). */
  private readonly maxBodyBytes?: number;
  private readonly trustedProxies?: TrustedProxies;
  private readonly requestScopeDisposeTimeoutMs?: number;
  private readonly responseCompletions = new Set<Promise<void>>();
  /** Absolute health-probe path, or `undefined` when disabled. */
  private readonly healthPath?: string;
  private readonly healthOptions?: HealthEndpointOptions;
  private healthInFlight?: Promise<HealthReport>;
  private healthCache?: { readonly report: HealthReport; readonly expiresAt: number };
  /** Built-ins reused for 404/405/health/docs/preflight responses. */
  private shortCircuitChain: readonly HttpMiddleware[] = [];
  private readonly modelValidator?: ModelValidator;
  /** Optional WebSocket runtime sharing this listener (resolved at start). */
  private webSocket?: WebSocketUpgrade;
  /** Generated API docs served outside the controller router. */
  private docs?: PreparedOpenApiDocs;

  constructor(
    private readonly options: HttpServerOptions,
    /** Root container: the per-request scope factory. */
    private readonly provider: ServiceProvider,
    /** Root resolver for optional kernel services (Environment). */
    private readonly resolver: ServiceResolver,
  ) {
    this.phase = options.phase ?? 10;
    this.modelValidator = options.validator ?? getModelValidator();
    assertHttpLimits(options);
    assertVersioningOptions(options.versioning);
    if (options.inspectableRedirects !== undefined && typeof options.inspectableRedirects !== "boolean") {
      throw new HttpSetupError("inspectableRedirects must be a boolean.");
    }
    this.maxBodyBytes = options.maxBodyBytes === 0 ? undefined : (options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    this.trustedProxies = options.trustedProxies === undefined || options.trustedProxies.length === 0 ? undefined : trustedProxies(options.trustedProxies);
    this.requestScopeDisposeTimeoutMs = options.requestScopeDisposeTimeoutMs === 0
      ? undefined
      : options.requestScopeDisposeTimeoutMs ?? DEFAULT_REQUEST_SCOPE_DISPOSE_TIMEOUT_MS;
    if (options.health) {
      this.healthOptions = options.health === true ? {} : options.health;
      this.healthPath = this.healthOptions.path ?? DEFAULT_HEALTH_PATH;
      if (!this.healthPath.startsWith("/")) {
        throw new HttpSetupError("HTTP health path must be absolute and start with '/'.");
      }
    }
  }

  /** Actual listening port (useful with `port: 0` in tests). */
  get port(): number {
    return this.server?.port ?? -1;
  }

  async start(): Promise<void> {
    // Auto-register convention body/list models and OpenAPI metadata generated
    // by `di:generate`. The generated code is project-owned and loaded through
    // registries, so framework core does not import application modules directly.
    await loadBazisGeneratedRuntime();

    const exposeDetails =
      this.options.exposeErrorDetails ?? this.resolver.tryResolve(Environment)?.debug ?? false;

    // Outermost first: access log measures the whole pipeline, CORS decorates
    // responses, the error boundary guards everything below (global -> route
    // -> action).
    const serverChain: HttpMiddleware[] = [];
    if (this.options.accessLog) {
      const base = this.options.accessLog === true ? {} : this.options.accessLog;
      const logger = this.resolver.tryResolve(LOGGER);
      // Explicit `log`/`logger` in options win; otherwise use the kernel logger.
      serverChain.push(accessLog(logger ? { logger, ...base } : base));
    }
    if (this.options.cors) {
      serverChain.push(cors(this.options.cors));
    }
    // Secure-by-default: on unless explicitly disabled. Wraps the error
    // boundary so headers land on error responses too.
    if (this.options.securityHeaders !== false) {
      serverChain.push(securityHeaders(this.options.securityHeaders ?? {}));
    }
    const serverMiddleware = this.collectServerMiddleware();
    // A global correlation middleware wraps the error boundary, so error
    // responses (401, 403, 500, a thrown NotFoundError) and the responses
    // produced before routing (404, 405, 413, preflight, docs, health) carry
    // the request id, and the error log line runs inside its request context.
    serverChain.push(...serverMiddleware.filter(isCorrelationIdMiddleware));
    // Unexpected errors go to the application logger, like the access log.
    const errorLogger = this.resolver.tryResolve(LOGGER);
    serverChain.push(
      errorHandler({
        exposeDetails,
        ...(errorLogger ? { logger: errorLogger } : {}),
        ...(this.options.languages ? { languages: this.options.languages } : {}),
        ...this.options.errorHandler,
        onUnexpectedError: this.collectErrorHook(),
      }),
    );
    this.shortCircuitChain = [...serverChain];
    // A global `cors()` among the middleware answers preflights like `cors`.
    this.globalCors = this.options.cors || serverMiddleware.map(corsOptionsOf).find((options) => options !== undefined);
    serverChain.push(...serverMiddleware.filter((middleware) => !isCorrelationIdMiddleware(middleware)));

    const defaultChecks = defaultAuthorizeChecks(this.options.authorize);
    const builder = new RouterBuilder(
      serverChain,
      this.options.prefix,
      this.options.versioning,
      this.collectRouteComposer(),
      defaultChecks,
    );
    this.router = builder.build(this.options.controllers);
    const routes = builder.routes;
    this.readVersion = createVersionReader(this.options.versioning);
    this.docs = prepareOpenApiDocs({
      option: this.options.docs,
      controllers: this.options.controllers,
      globalPrefix: this.options.prefix,
      versioning: this.options.versioning,
      environment: this.resolver.tryResolve(Environment),
      authorize: defaultChecks,
    });

    this.webSocket = this.resolver.tryResolve(WEBSOCKET_UPGRADE);

    if (this.webSocket) {
      const ws = this.webSocket;
      try {
        // Initialize adapters and gateways before exposing a listener. This
        // prevents successful upgrades into a partially initialized runtime.
        await ws.initialize();
        this.server = await this.startBunServer((listen) => Bun.serve({
          ...listen,
          error: (error) => this.transportError(error, undefined),
          websocket: ws.createBunHandler(),
          fetch: async (request, server) => {
            // null -> not for the WS runtime, fall through to HTTP.
            // undefined -> upgraded (return nothing). Response -> rejected handshake.
            const upgraded = await ws.tryUpgrade(request, server);
            return upgraded === null ? this.dispatch(request, server.requestIP(request)?.address) : (upgraded ?? undefined);
          },
        }));
      } catch (error) {
        const listener = this.server;
        this.server = undefined;
        this.webSocket = undefined;
        // A Bun listener normally cannot exist when its constructor throws,
        // but keep rollback complete if that contract changes.
        if (listener) {
          void Promise.resolve(listener.stop(true)).catch(() => undefined);
        }
        await Promise.resolve(ws.close()).catch(() => undefined);
        throw error;
      }
    } else {
      this.server = await this.startBunServer((listen) =>
        Bun.serve({
          ...listen,
          fetch: (request, server) => this.dispatch(request, server.requestIP(request)?.address),
          error: (error) => this.transportError(error, undefined),
        }),
      );
    }
    this.reportStarted(routes);
  }

  /** Routes and the address for the startup screen. */
  private reportStarted(routes: readonly import("./Routing/RouterBuilder").RegisteredRoute[]): void {
    const report = this.resolver.tryResolve(StartupReport);
    const server = this.server;
    if (report === undefined || server === undefined) return;
    report.routes(routes.map((route) => ({
      method: route.method,
      path: route.path.startsWith("/") ? route.path : `/${route.path}`,
      handler: route.handler,
      open: route.open,
      ...(route.anonymous ? { access: "anonymous" } : {}),
    })));
    const builtIn = [
      ...(this.healthPath === undefined ? [] : [{ method: "GET", path: this.healthPath }]),
      ...(this.docs === undefined ? [] : [{ method: "GET", path: this.docs.uiPath }, { method: "GET", path: this.docs.specPath }]),
    ];
    report.routes(builtIn.map((route) => ({ ...route, handler: "", open: true, builtIn: true })));
    const hostname = server.hostname ?? "0.0.0.0";
    const shown = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname.includes(":") ? `[${hostname}]` : hostname;
    const url = `http://${shown}:${server.port}`;
    report.listener({
      protocol: "http",
      url,
      hostname,
      port: server.port ?? 0,
      ...(this.healthPath === undefined ? {} : { health: `${url}${this.healthPath}` }),
      ...(this.docs === undefined ? {} : { docs: `${url}${this.docs.uiPath}` }),
    });
  }

  private async startBunServer(create: (listen: ListenOptions) => ReturnType<typeof Bun.serve>): Promise<ReturnType<typeof Bun.serve>> {
    const attempts = this.options.port === 0 ? 10 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const listen = await this.resolveListenOptions();
      try {
        return create(listen);
      } catch (error) {
        if (this.options.port !== 0 || !isAddressInUse(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  private async resolveListenOptions(): Promise<ListenOptions> {
    const hostname = this.options.hostname ?? (this.options.port === 0 ? "127.0.0.1" : undefined);
    // Let the operating system reserve an ephemeral port atomically. Picking a
    // random port in user space creates a check/use race between concurrent
    // application or test processes and can still exhaust every retry.
    const port = this.options.port ?? 3000;
    return {
      port,
      ...(hostname !== undefined ? { hostname } : {}),
      ...(this.options.idleTimeoutSeconds !== undefined ? { idleTimeout: this.options.idleTimeoutSeconds } : {}),
    };
  }

  /** Explicit `options.middleware` (order 0) merged with DI {@link SERVER_MIDDLEWARE}. */
  private collectServerMiddleware(): HttpMiddleware[] {
    const explicit = (this.options.middleware ?? []).map((middleware) => ({ order: 0, middleware }));
    const collected = this.resolver.resolveAll(SERVER_MIDDLEWARE);
    return sortByOrder([...explicit, ...collected]).map((registration) => registration.middleware);
  }

  /** Explicit `options.errorHandler.onUnexpectedError` merged with DI {@link HTTP_ERROR_HOOK} hooks. */
  private collectErrorHook(): ((ctx: HttpContext, error: unknown) => void) | undefined {
    const explicit = this.options.errorHandler?.onUnexpectedError;
    const hooks = this.resolver.resolveAll(HTTP_ERROR_HOOK);
    if (explicit === undefined && hooks.length === 0) {
      return undefined;
    }
    return (ctx, error) => {
      explicit?.(ctx, error);
      for (const hook of hooks) {
        hook(ctx, error);
      }
    };
  }

  /** Explicit `options.routeMiddlewareComposer` (order 0) merged with DI {@link ROUTE_MIDDLEWARE_COMPOSER}. */
  private collectRouteComposer(): RouteMiddlewareComposer | undefined {
    const explicit = this.options.routeMiddlewareComposer
      ? [{ order: 0, compose: this.options.routeMiddlewareComposer }]
      : [];
    const collected = this.resolver.resolveAll(ROUTE_MIDDLEWARE_COMPOSER);
    const userComposers = sortByOrder([...explicit, ...collected]).map((registration) => registration.compose);

    if (userComposers.length === 0) {
      return undefined;
    }
    return (controllerClass, methodName, httpMeta, action) =>
      userComposers.flatMap((compose) => compose(controllerClass, methodName, httpMeta, action));
  }

  async stop(): Promise<void> {
    // Graceful: stop accepting new connections, let in-flight requests finish.
    // Long-lived WebSocket connections never drain on their own, so when a WS
    // runtime is attached we force active connections closed.
    const webSocket = this.webSocket;
    const listener = this.server;
    this.webSocket = undefined;
    this.server = undefined;
    this.docs = undefined;

    let firstError: unknown;
    try {
      await webSocket?.close();
    } catch (error) {
      firstError = error;
    }

    if (listener) {
      try {
        const stopped = Promise.resolve(listener.stop(webSocket !== undefined));
        if (webSocket) {
          // Bun 1.3 keeps this promise pending after a listener has ever upgraded
          // a WebSocket, even after all sockets are terminated. `stop(true)` is
          // still synchronous in initiating the forced listener shutdown.
          void stopped.catch(() => undefined);
        } else {
          await stopped;
        }
      } catch (error) {
        firstError ??= error;
      }
    }
    await Promise.allSettled([...this.responseCompletions]);
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private async dispatch(incoming: Request, peerIp?: string): Promise<Response> {
    const request = this.withAbsoluteUrl(incoming);
    let response: Response;
    try {
      const client: ClientConnection = { clientIp: clientAddress(peerIp, request.headers.get("x-forwarded-for"), this.trustedProxies), peerIp };
      response = await this.handle(request, client);
    } catch (error) {
      // Covers failures before a request context can be created. Normal route
      // and short-circuit failures are handled by the configured error boundary.
      response = this.prepareClientResponse(this.transportError(error, request), request);
    }
    // HEAD must echo the GET response's status/headers without a body.
    return request.method === "HEAD" ? stripBody(response) : response;
  }

  /** The response language of a request; `undefined` without `runApp({ language })`. */
  private selected(request: Request | undefined): SelectedLanguage | undefined {
    try {
      return this.options.languages?.select(request?.headers.get("accept-language"));
    } catch {
      return undefined;
    }
  }

  /** A response text the server writes itself, in the language of the request. */
  private text(key: HttpMessageKey, request: Request | undefined, params: MessageParams = {}): string {
    const english = formatMessage(EN_HTTP_MESSAGES[key], params);
    try {
      return this.selected(request)?.localize(key, params) ?? english;
    } catch {
      return english;
    }
  }

  /** `{ error, …extra }` the server writes itself, with the language headers when negotiated. */
  private errorJson(request: Request | undefined, status: number, key: HttpMessageKey, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
    const language = Object.fromEntries(languageHeaders(this.options.languages, this.selected(request)));
    return json(status, { error: this.text(key, request), ...extra }, { ...headers, ...language });
  }

  private transportError(error: unknown, request: Request | undefined): Response {
    try {
      console.error("[http] transport failed:", redactSensitive(error));
    } catch {
      // Best-effort diagnostics only.
    }
    const response = this.errorJson(request, 500, "internalServerError");
    if (this.options.securityHeaders !== false) {
      applySecurityHeaders(response, this.options.securityHeaders ?? {});
    }
    return response;
  }

  /**
   * HTTP/1.0 allows a request without `Host`; Bun then gives a path, not a
   * URL. Such a request is addressed to this server, so it gets the server's
   * own origin and the rest of the pipeline sees an ordinary absolute URL.
   */
  private withAbsoluteUrl(request: Request): Request {
    if (URL.canParse(request.url)) return request;
    const server = this.server;
    const host = server?.hostname === undefined || server.hostname === "0.0.0.0" || server.hostname === "::" ? "localhost" : server.hostname.includes(":") ? `[${server.hostname}]` : server.hostname;
    return new Request(new URL(request.url, `http://${host}:${server?.port ?? 80}`).href, request);
  }

  private async handle(request: Request, client: ClientConnection): Promise<Response> {
    const url = new URL(request.url);

    if (this.healthPath !== undefined && url.pathname === this.healthPath && isReadMethod(request.method)) {
      return this.runShortCircuit(request, url, client, () => this.healthResponse());
    }

    if (this.docs !== undefined) {
      const docsResponse = serveOpenApiDocs(this.docs, url.pathname, request.method);
      if (docsResponse !== undefined) {
        return this.runShortCircuit(request, url, client, () => docsResponse);
      }
    }

    if (isPreflight(request)) {
      const corsOptions = this.globalCors ?? this.routeCors(request, url);
      if (corsOptions !== undefined) {
        return this.runShortCircuit(request, url, client, () => preflightResponse(corsOptions, request));
      }
    }

    const segments = parseRequestPath(url.pathname);
    if (!segments) {
      if (this.maxBodyBytes !== undefined && exceedsBodyLimit(request, this.maxBodyBytes)) {
        return this.runShortCircuit(request, url, client, () =>
          this.errorJson(request, 413, "payloadTooLarge", { details: { maxBytes: this.maxBodyBytes } }));
      }
      return this.runShortCircuit(request, url, client, () => this.errorJson(request, 400, "malformedPath"));
    }

    const match = this.router!.match(request.method, segments, this.readVersion(request, url));
    const effectiveMaxBodyBytes = match.kind === "matched"
      ? (match.action.maxBodyBytes ?? this.maxBodyBytes)
      : this.maxBodyBytes;
    if (effectiveMaxBodyBytes !== undefined && exceedsBodyLimit(request, effectiveMaxBodyBytes)) {
      return this.runShortCircuit(request, url, client, () =>
        this.errorJson(request, 413, "payloadTooLarge", { details: { maxBytes: effectiveMaxBodyBytes } }));
    }
    if (match.kind === "not-found") {
      return this.runShortCircuit(request, url, client, () => this.errorJson(request, 404, "notFound"));
    }
    if (match.kind === "method-not-allowed") {
      return this.runShortCircuit(request, url, client, () =>
        this.errorJson(request, 405, "methodNotAllowed", {}, { allow: match.allow.join(", ") }));
    }
    if (match.kind === "unsupported-version") {
      return this.runShortCircuit(request, url, client, () =>
        this.errorJson(request, 400, "unsupportedApiVersion", { details: { supported: match.supported } }));
    }

    const scope = this.provider.createScope();
    const ctx = new HttpContext(
      request,
      url,
      match.params,
      scope,
      match.action.version,
      effectiveMaxBodyBytes,
      client.clientIp,
      this.modelValidator,
      this.selected(request)?.language,
      client.peerIp,
    );
    let scopeTransferred = false;
    try {
      await runPipeline(match.action.chain, ctx);
      // The error boundary always sets a response on failure; an empty
      // response here means no middleware produced one.
      const response = this.prepareClientResponse(ctx.response ?? this.errorJson(request, 404, "notFound"), request);
      if (request.method === "HEAD") return stripBody(response);
      if (!response.body) return response;
      this.trackResponse(holdResponseScope(response, request.signal, () =>
        disposeRequestScope(scope, this.requestScopeDisposeTimeoutMs)));
      scopeTransferred = true;
      return response;
    } finally {
      // Disposal must never replace the response with Bun's bare 500.
      if (!scopeTransferred) await disposeRequestScope(scope, this.requestScopeDisposeTimeoutMs);
    }
  }

  /** CORS options of the route a preflight asks about (its `Access-Control-Request-Method`). */
  private routeCors(request: Request, url: URL): CorsOptions | undefined {
    const segments = parseRequestPath(url.pathname);
    const method = request.headers.get("access-control-request-method")?.trim().toUpperCase();
    if (!segments || !method) return undefined;
    const match = this.router!.match(method, segments, this.readVersion(request, url));
    return match.kind === "matched" ? match.action.cors : undefined;
  }

  private async runShortCircuit(
    request: Request,
    url: URL,
    client: ClientConnection,
    produce: () => Response | Promise<Response>,
  ): Promise<Response> {
    const scope = this.provider.createScope();
    const ctx = new HttpContext(
      request,
      url,
      {},
      scope,
      undefined,
      this.maxBodyBytes,
      client.clientIp,
      this.modelValidator,
      this.selected(request)?.language,
      client.peerIp,
    );
    const terminal: HttpMiddleware = async (context) => {
      context.response = await produce();
    };
    let scopeTransferred = false;
    try {
      await runPipeline([...this.shortCircuitChain, terminal], ctx);
      const response = this.prepareClientResponse(ctx.response ?? this.errorJson(request, 500, "internalServerError"), request);
      if (request.method === "HEAD") return stripBody(response);
      if (!response.body) return response;
      this.trackResponse(holdResponseScope(response, request.signal, () =>
        disposeRequestScope(scope, this.requestScopeDisposeTimeoutMs)));
      scopeTransferred = true;
      return response;
    } finally {
      if (!scopeTransferred) await disposeRequestScope(scope, this.requestScopeDisposeTimeoutMs);
    }
  }

  private trackResponse(completion: Promise<void>): void {
    this.responseCompletions.add(completion);
    void completion.finally(() => this.responseCompletions.delete(completion)).catch(() => undefined);
  }

  private prepareClientResponse(response: Response, request: Request): Response {
    return this.options.inspectableRedirects ? inspectableRedirectResponse(response, request) : response;
  }

  private async healthResponse(): Promise<Response> {
    const report = await this.getHealthReport();
    const exposed = this.healthOptions?.exposeDetails
      ? report
      : {
          healthy: report.healthy,
          checks: report.checks.map(({ details: _details, ...entry }) => entry),
        };
    return json(report.healthy ? 200 : 503, exposed);
  }

  private async getHealthReport(): Promise<HealthReport> {
    const now = Date.now();
    if (this.healthCache && this.healthCache.expiresAt > now) {
      return this.healthCache.report;
    }
    if (this.healthInFlight) {
      return this.healthInFlight;
    }

    const service = this.resolver.tryResolve(HealthService);
    const timeoutMs = this.healthOptions?.timeoutMs ?? 5_000;
    const startedAt = performance.now();
    const work = Promise.resolve().then(() =>
      service?.check() ?? ({ healthy: true, checks: [] } satisfies HealthReport));
    const inFlight = timeoutMs === 0
      ? work
      : healthWithTimeout(work, timeoutMs, startedAt);
    this.healthInFlight = inFlight;
    // A timed-out check may ignore cancellation and never settle. Keep its
    // already-resolved timeout report as the single-flight quarantine so every
    // later probe does not start another immortal check. Release only after the
    // source work itself eventually settles.
    void Promise.allSettled([work, inFlight]).then(() => {
      if (this.healthInFlight === inFlight) {
        this.healthInFlight = undefined;
      }
    });
    const report = await inFlight;
    const cacheMs = this.healthOptions?.cacheMs ?? 0;
    if (cacheMs > 0) {
      this.healthCache = { report, expiresAt: Date.now() + cacheMs };
    }
    return report;
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Fast pre-read guard for requests that advertise a `Content-Length`. */
function exceedsBodyLimit(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }
  const length = Number(contentLength);
  return Number.isFinite(length) && length > maxBytes;
}

function assertHttpLimits(options: HttpModuleOptions): void {
  if (
    options.maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 0)
  ) {
    throw new HttpSetupError("HTTP maxBodyBytes must be a non-negative integer.");
  }
  if (
    options.idleTimeoutSeconds !== undefined &&
    (!Number.isFinite(options.idleTimeoutSeconds) || options.idleTimeoutSeconds < 0 || options.idleTimeoutSeconds > 255)
  ) {
    throw new HttpSetupError("HTTP idleTimeoutSeconds must be between 0 and 255.");
  }
  if (
    options.requestScopeDisposeTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.requestScopeDisposeTimeoutMs) || options.requestScopeDisposeTimeoutMs < 0)
  ) {
    throw new HttpSetupError("HTTP requestScopeDisposeTimeoutMs must be a non-negative safe integer.");
  }
  if (typeof options.health === "object") {
    const { timeoutMs, cacheMs } = options.health;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new HttpSetupError("HTTP health timeoutMs must be a non-negative finite number.");
    }
    if (cacheMs !== undefined && (!Number.isFinite(cacheMs) || cacheMs < 0)) {
      throw new HttpSetupError("HTTP health cacheMs must be a non-negative finite number.");
    }
  }
}

async function disposeRequestScope(scope: ServiceScope, timeoutMs: number | undefined): Promise<void> {
  const disposal = Promise.resolve().then(() => scope.dispose());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === undefined) {
      await disposal;
      return;
    }
    const timedOut = Symbol("request-scope-disposal-timeout");
    const outcome = await Promise.race([
      disposal.then(() => undefined),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (outcome === timedOut) {
      // Keep the late rejection observed even though the response is released.
      void disposal.catch((error) => logScopeDisposalError(error));
      try {
        console.error(`[http] request scope disposal timed out after ${timeoutMs}ms`);
      } catch {
        // Best-effort diagnostics only.
      }
    }
  } catch (error) {
    logScopeDisposalError(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function logScopeDisposalError(error: unknown): void {
  // Disposal must never replace the response, and cleanup errors may contain
  // connection/configuration secrets.
  try {
    console.error("[http] request scope disposal failed:", redactSensitive(error));
  } catch {
    // Best-effort diagnostics only.
  }
}

async function healthWithTimeout(
  work: Promise<HealthReport>,
  timeoutMs: number,
  startedAt: number,
): Promise<HealthReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HealthReport>((resolve) => {
    timer = setTimeout(() => resolve({
      healthy: false,
      checks: [{
        name: "health",
        healthy: false,
        details: `Health check timed out after ${timeoutMs}ms`,
        durationMs: performance.now() - startedAt,
      }],
    }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
