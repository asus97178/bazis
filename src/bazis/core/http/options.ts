import type { Class } from "../di";
import type { AccessLogOptions } from "./Middleware/accessLog";
import type { CorsOptions } from "./Middleware/cors";
import type { ErrorHandlerOptions } from "./Middleware/errorHandler";
import type { SecurityHeadersOptions } from "./Middleware/securityHeaders";
import type { HttpMiddleware } from "./Middleware/types";
import type { ActionMeta, ControllerMeta } from "./Decorators/metadata";
import type { OpenApiDocsOptions } from "../../library/openapi";
import type { ModelValidator } from "./Binding/modelValidator";

/** Built-in health endpoint (liveness/readiness probe). */
export interface HealthEndpointOptions {
  /** Absolute path served outside routing/pipeline (default "/health"). */
  readonly path?: string;
  /** Include check-provided diagnostic details. Default: false. */
  readonly exposeDetails?: boolean;
  /** Maximum time for the aggregate health check. Default: 5000ms. `0` disables it. */
  readonly timeoutMs?: number;
  /** Cache a completed report for this many milliseconds. Default: 0 (single-flight only). */
  readonly cacheMs?: number;
}

/** Composes per-route middleware from controller metadata at startup (e.g. JWT authorization). */
export type RouteMiddlewareComposer = (
  controllerClass: Class<object>,
  methodName: string | symbol,
  httpMeta: ControllerMeta,
  action: ActionMeta,
) => readonly HttpMiddleware[];

/** How the requested API version is read. */
export interface ApiVersioningOptions {
  /**
   * - `"url"` — version is a path segment: `/api/v1.0/users` (fastest:
   *   static match, default);
   * - `"query"` — `?api-version=1.0` (parameter name configurable);
   * - `"header"` — custom header (default `x-api-version`).
   */
  readonly source: "url" | "query" | "header";
  /** Query parameter name for `source: "query"` (default "api-version"). */
  readonly parameterName?: string;
  /** Header name for `source: "header"` (default "x-api-version"). */
  readonly headerName?: string;
  /** Version assumed when the request does not specify one. */
  readonly defaultVersion?: string;
}

export interface HttpModuleOptions {
  /**
   * Permit explicitly negotiated redirects for exact browser-side limits.
   * The HttpClient must also enable inspectableRedirects. Default: false.
   * Authorized/CORS-allowed clients can then inspect each redirect Location.
   */
  readonly inspectableRedirects?: boolean;
  /**
   * Controller classes (decorated with @Controller). Optional when controllers
   * are declared on imported modules via `controllers` on `BazisModule`.
   */
  readonly controllers?: readonly Class<object>[];
  /** Request-model validator captured by this HTTP server instance. */
  readonly validator?: ModelValidator;
  /**
   * Modules providing the controllers' dependencies. Controllers live inside
   * the returned HttpModule, so their dependencies must be visible to it:
   * either listed here or exported by global modules.
   */
  readonly imports?: readonly import("../di").BazisModuleRef[];
  /** Listen port (default 3000; 0 — random free port). */
  readonly port?: number;
  readonly hostname?: string;
  /** Global route prefix, e.g. "api". */
  readonly prefix?: string;
  /** Global middleware (after the built-in error handler, before controller ones). */
  readonly middleware?: readonly HttpMiddleware[];
  /**
   * Per-route middleware inserted after controller/action middleware, argument
   * binding and `ActionFilter.before`, but before controller/action execution.
   * Built-in `@Authorize` runs before controller middleware and therefore also
   * ahead of any composer provided here.
   */
  readonly routeMiddlewareComposer?: RouteMiddlewareComposer;
  /** Global CORS: response headers + automatic preflight answers. `false` (default) — off. */
  readonly cors?: CorsOptions | false;
  /**
   * Security response headers (secure-by-default). Enabled with conservative
   * defaults when omitted; pass an object to tune (HSTS/CSP are opt-in) or
   * `false` to disable entirely.
   */
  readonly securityHeaders?: SecurityHeadersOptions | false;
  /** Options for the built-in error boundary (e.g. logging hook from hosting). */
  readonly errorHandler?: ErrorHandlerOptions;
  /** API versioning; required to honor @ApiVersion (default: url source when any controller is versioned). */
  readonly versioning?: ApiVersioningOptions;
  /**
   * Include error details in 500 responses. Default: `Environment.debug`
   * when the kernel is present, otherwise false.
   */
  readonly exposeErrorDetails?: boolean;
  /**
   * Max request body size in bytes. Requests advertising a larger
   * `Content-Length` get a clean 413 before the body is read; unsized/chunked
   * bodies are capped while framework body readers consume the stream.
   * Default: 1 MiB. `0` disables the framework check.
   */
  readonly maxBodyBytes?: number;
  /** Per-connection idle timeout in seconds (Bun.serve, 0–255). Default: Bun's. */
  readonly idleTimeoutSeconds?: number;
  /** Maximum wait for request-scope disposal. Default 5000ms; `0` restores an unbounded wait. */
  readonly requestScopeDisposeTimeoutMs?: number;
  /**
   * Built-in health endpoint. `true` serves `/health`; pass an object to set
   * the path. Resolves the kernel `HealthService` (200 healthy / 503 unhealthy);
   * bypasses application routing/middleware but retains built-in error handling,
   * security/CORS headers and access logging.
   */
  readonly health?: HealthEndpointOptions | boolean;
  /**
   * Built-in generated API docs. No user-facing Swagger decorators are needed:
   * `bazis codegen` derives request models and schemas from controllers.
   *
   * Default: enabled in debug environments, disabled in production. `true`
   * serves `/docs` and `/docs/openapi.json`; pass an object to change paths or
   * title/version.
   */
  readonly docs?: OpenApiDocsOptions | boolean;
  /**
   * Access log for every request (method, path, status, duration, correlation
   * id). `true` enables the default single-line sink; pass an object to plug a
   * structured sink or skip predicate. Installed outermost.
   */
  readonly accessLog?: AccessLogOptions | boolean;
  /** Hosted-service startup phase (default 10 — after infrastructure). */
  readonly phase?: number;
}
