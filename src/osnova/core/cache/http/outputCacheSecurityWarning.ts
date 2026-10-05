import type { Class } from "../../di";
import { resolveAuthorizeMeta } from "../../http";
import type { ResolvedOutputCacheOptions } from "../internal/resolveCachePolicy";

export interface OutputCacheSecurityWarningOptions {
  readonly enabled?: boolean;
  /** Default: throw. Use "warn" for compatibility, "ignore" only with an external policy. */
  readonly behavior?: "throw" | "warn" | "ignore";
  /** Match `jwt({ options: { requireAuthenticationByDefault } })`. Default false. */
  readonly requireAuthenticationByDefault?: boolean;
  readonly warn?: (message: string) => void;
}

/**
 * Guards against `@OutputCache` on a protected route without user isolation.
 * Called once per route at HTTP startup (composer time).
 */
export function guardInsecureOutputCacheRoute(
  controllerClass: Class<object>,
  methodName: string | symbol,
  config: ResolvedOutputCacheOptions,
  options: OutputCacheSecurityWarningOptions = {},
): void {
  if (options.enabled === false) {
    return;
  }
  const behavior = options.behavior ?? "throw";
  if (behavior === "ignore") {
    return;
  }

  if (
    config.varyByUser === true
    || config.varyByClaim !== undefined
    || config.unlessAuthenticated === true
    || config.noStore === true
  ) {
    return;
  }

  const authorize = resolveAuthorizeMeta(controllerClass, methodName);
  const protectedRoute =
    !authorize.allowAnonymous
    && (authorize.authorize !== undefined || options.requireAuthenticationByDefault === true);
  if (!protectedRoute) {
    return;
  }

  const route = `${controllerClass.name}.${String(methodName)}`;
  const message =
    `[cache] @OutputCache on ${route} is on an authorized route without varyByUser or unlessAuthenticated — `
    + "responses may leak between users. Add varyByUser: true or unlessAuthenticated: true.";

  if (behavior === "throw") {
    throw new Error(message);
  }
  (options.warn ?? console.warn)(message);
}
