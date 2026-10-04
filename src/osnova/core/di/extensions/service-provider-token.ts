import { ServiceProvider } from "../ServiceProvider";
import { createToken } from "../token";

/**
 * The container itself as an injectable service (.NET's IServiceProvider).
 *
 * Registered automatically by `createContainer` as a global provider, so any
 * service can receive the root container — primarily to create per-request
 * scopes (`provider.createScope()`) from infrastructure like the HTTP server.
 *
 * Resolve it sparingly: business services should depend on their actual
 * dependencies, not on the container (service-locator anti-pattern).
 */
export const SERVICE_PROVIDER = createToken<ServiceProvider>("IServiceProvider");

/**
 * Internal alias for the canonical class token used by generated constructor
 * dependencies. Legacy name-based dependencies resolve this same token, so no
 * second token with the debug name `ServiceProvider` competes with the class.
 */
export const SERVICE_PROVIDER_BY_TYPE = ServiceProvider;
