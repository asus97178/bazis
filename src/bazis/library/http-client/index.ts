/**
 * Bazis HTTP client library — a pure, framework-agnostic, axios-class client
 * over native `fetch`. Zero dependency on the Bazis core or runtime; works in
 * Bun, browsers and Node 18+.
 *
 * ```ts
 * import { HttpClient } from "@/library/http-client";
 *
 * const api = new HttpClient({ baseUrl: "https://api.example.com", timeoutMs: 5000 });
 * const { data } = await api.get<User[]>("/users", { params: { page: 2 } });
 * ```
 */
export { HttpClient } from "./HttpClient";
export { InspectableRedirectProtocol } from "./redirectProtocol";
export { HttpClientFactoryBuilder, type HttpClientFactory } from "./HttpClientFactory";
export { HttpClientError, HttpClientConfigError, HttpErrorCode } from "./errors";
export { InterceptorManager, type FulfilledFn, type RejectedFn } from "./interceptors";
export {
  appendQuery,
  basicAuthHeader,
  defaultParamsSerializer,
  isBodyInit,
  resolveUrl,
  shouldPropagateCorrelation,
} from "./serialize";
export type {
  BasicAuth,
  CorrelationPropagation,
  HeaderBag,
  HttpMethod,
  HttpResponse,
  ParamPrimitive,
  ParamValue,
  ProgressEvent,
  ProgressListener,
  RequestConfig,
  RequestParams,
  RequestTransform,
  ResolvedRequestConfig,
  ResponseTransform,
  ResponseType,
  RetryOptions,
} from "./types";
