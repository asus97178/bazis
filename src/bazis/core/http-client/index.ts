/**
 * Core DI/correlation integration for the pure `@/library/http-client`.
 *
 * The HTTP engine lives in the library (framework-agnostic). This module only
 * wires it into the runtime: clients of other services are declared like
 * controllers — a class with `@HttpClient`, listed in `httpClients` of a
 * module — and get the kernel's correlation headers. All library symbols are
 * re-exported for convenience.
 *
 * ```ts
 * import { HttpClient, HttpClientBase } from "bazis/core/http-client";
 *
 * @HttpClient({ config: weatherConfig })
 * export class WeatherClient extends HttpClientBase {}
 *
 * @Module({ httpClients: [WeatherClient], providers: [scoped(WeatherService)] })
 * class WeatherModule {}
 *
 * class WeatherService { constructor(private readonly weather: WeatherClient) {} }
 * ```
 */
export * from "../../library/http-client";
export { HttpClient, type HttpClientConfig, type HttpClientDeclaration } from "./httpClients";
