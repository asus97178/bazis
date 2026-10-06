/**
 * HTTP module of the Bazis framework (ASP.NET Core-inspired).
 *
 * Controllers are classes with TC39 decorators; routes are compiled into a
 * radix tree at startup; every request runs in its own DI scope. No external
 * dependencies, compatible with `bun build --compile`.
 */
export { httpModule } from "./httpModule";
export { HttpServer } from "./HttpServer";
export { WEBSOCKET_UPGRADE, type WebSocketUpgrade } from "./WebSocketUpgrade";
export type {
  ApiVersioningOptions,
  HealthEndpointOptions,
  HttpModuleOptions,
  RouteMiddlewareComposer,
} from "./options";
export type { OpenApiDocsOptions } from "../../library/openapi";
export { composeRouteMiddlewareComposers } from "./composeRouteMiddlewareComposers";
export {
  HTTP_ERROR_HOOK,
  ROUTE_MIDDLEWARE_COMPOSER,
  SERVER_MIDDLEWARE,
  sortByOrder,
  type HttpErrorHook,
  type RouteMiddlewareComposerRegistration,
  type ServerMiddlewareRegistration,
} from "./middlewareTokens";

// HttpContext
export { HttpContext, type RouteParams } from "./HttpContext/HttpContext";
export { ResponseBuilder } from "./HttpContext/ResponseBuilder";
export { PRINCIPAL_STATE_KEY, type RequestPrincipal } from "./HttpContext/principal";

// Authorization
export { Authorize, AllowAnonymous } from "./Authorization/Authorize";
export { createAuthorizeComposer } from "./Authorization/authorizeComposer";
export {
  resolveAuthorizeMeta,
  type AuthorizeCheck,
  type AuthorizeOptions,
  type ResolvedAuthorizeMeta,
} from "./Authorization/metadata";

// Decorators
export { Controller } from "./Decorators/controller";
export { All, Delete, Get, Head, Options, Patch, Post, Put, type RouteOptions } from "./Decorators/routes";
export {
  ActionFilter,
  ApiVersion,
  Catch,
  Consumes,
  HttpCode,
  Middleware,
  Produces,
} from "./Decorators/attributes";

// Binding
export type { BindingSource, ParameterBinding } from "./Binding/bindings";
export type { ValueType } from "./Binding/convert";
export { RequestModel } from "./Binding/RequestModel";

// Universal list request (sorting/filtering/paging): a declarative
// request class bound by signature. Engine and types live in `@/library/jsonapi`.
export {
  ListRequest,
  Filterable,
  ListOptions,
  Sortable,
  buildListDocument,
  serializeListQuery,
  type BuildListDocumentOptions,
  type FilterOperator,
  type ListDocument,
  type ListQuery,
} from "../../library/jsonapi";
export {
  AMBIGUOUS_REQUEST_MODEL,
  findRequestModelByName,
  findRequestModelShape,
  registerRequestModelClass,
  registerRequestModelShape,
  type RequestModelFieldShape,
  type RequestModelNestedFieldShape,
  type RequestModelPrimitive,
  type RequestModelPrimitiveFieldShape,
  type RequestModelClass,
  type RequestModelShape,
} from "./Binding/requestModelRegistry";
export {
  useModelValidator,
  getModelValidator,
  type ModelValidator,
  type ModelValidationIssue,
} from "./Binding/modelValidator";

// Results
export { HttpResult } from "./Results/HttpResult";
export {
  Accepted,
  BadRequest,
  Conflict,
  Created,
  File,
  Forbidden,
  InternalServerError,
  NoContent,
  NotFound,
  Ok,
  Redirect,
  StatusCode,
  Unauthorized,
} from "./Results/results";

// Middleware
export { accessLog, type AccessLogEntry, type AccessLogOptions } from "./Middleware/accessLog";
export { cors, type CorsOptions } from "./Middleware/cors";
export { createCorrelationIdMiddleware, type CorrelationIdMiddlewareOptions } from "./correlation/createCorrelationIdMiddleware";
export { errorHandler, type ErrorHandlerOptions } from "./Middleware/errorHandler";
export { rateLimit, type RateLimitOptions } from "./Middleware/rateLimit";
export {
  securityHeaders,
  type HstsOptions,
  type SecurityHeadersOptions,
} from "./Middleware/securityHeaders";
export type { ActionFilterHooks, HttpMiddleware } from "./Middleware/types";

// Errors
export {
  BadRequestError,
  ForbiddenError,
  HttpError,
  HttpSetupError,
  MethodNotAllowedError,
  ModelValidationError,
  NotFoundError,
  PayloadTooLargeError,
  TooManyRequestsError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from "./Errors/HttpError";
