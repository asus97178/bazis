import type { HttpMiddleware } from "./types";
import { redactSensitive } from "../../../library/redaction";

/** `Strict-Transport-Security` tuning (only meaningful over HTTPS). */
export interface HstsOptions {
  /** max-age in seconds. Default: 15552000 (180 days). */
  readonly maxAgeSeconds?: number;
  /** Append `includeSubDomains`. Default: true. */
  readonly includeSubDomains?: boolean;
  /** Append `preload`. Default: false. */
  readonly preload?: boolean;
}

export interface SecurityHeadersOptions {
  /** `X-Content-Type-Options: nosniff`. Default: true. */
  readonly contentTypeOptions?: boolean;
  /** `X-Frame-Options`. Default: "DENY". `false` omits it. */
  readonly frameOptions?: "DENY" | "SAMEORIGIN" | false;
  /** `Referrer-Policy`. Default: "no-referrer". `false` omits it. */
  readonly referrerPolicy?: string | false;
  /** `X-DNS-Prefetch-Control`. Default: "off". `false` omits it. */
  readonly dnsPrefetchControl?: "off" | "on" | false;
  /**
   * `Strict-Transport-Security`. Default: off (apps are often behind TLS
   * terminators and dev runs on HTTP). Pass `true` for sane defaults or an
   * object to tune. Never sent unless explicitly enabled.
   */
  readonly hsts?: HstsOptions | boolean;
  /**
   * `Content-Security-Policy`. Default: off (a wrong CSP breaks apps). Provide
   * a policy string to enable.
   */
  readonly contentSecurityPolicy?: string;
  /** Extra headers to set (set-if-absent), e.g. a custom `Permissions-Policy`. */
  readonly headers?: Readonly<Record<string, string>>;
}

function buildHeaders(options: SecurityHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {};

  if (options.contentTypeOptions !== false) {
    headers["x-content-type-options"] = "nosniff";
  }
  if (options.frameOptions !== false) {
    headers["x-frame-options"] = options.frameOptions ?? "DENY";
  }
  if (options.referrerPolicy !== false) {
    headers["referrer-policy"] = options.referrerPolicy ?? "no-referrer";
  }
  if (options.dnsPrefetchControl !== false) {
    headers["x-dns-prefetch-control"] = options.dnsPrefetchControl ?? "off";
  }
  if (options.hsts) {
    const hsts: HstsOptions = options.hsts === true ? {} : options.hsts;
    const parts = [`max-age=${hsts.maxAgeSeconds ?? 15_552_000}`];
    if (hsts.includeSubDomains !== false) {
      parts.push("includeSubDomains");
    }
    if (hsts.preload) {
      parts.push("preload");
    }
    headers["strict-transport-security"] = parts.join("; ");
  }
  if (options.contentSecurityPolicy) {
    headers["content-security-policy"] = options.contentSecurityPolicy;
  }
  if (options.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      headers[name.toLowerCase()] = value;
    }
  }

  return headers;
}

/**
 * Sets conservative security response headers (secure-by-default): `nosniff`,
 * `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, DNS-prefetch off.
 * HSTS and CSP are opt-in (a wrong value breaks real apps). Headers are written
 * set-if-absent, so a route that sets its own value wins.
 *
 * Installed automatically by `httpModule` unless `securityHeaders: false`.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): HttpMiddleware {
  const headers = buildHeaders(options);
  return async (ctx, next) => {
    await next();
    const response = ctx.response;
    if (!response) {
      return;
    }
    applySecurityHeaders(response, options, headers);
  };
}

/** Applies the configured defaults to a response without throwing. */
export function applySecurityHeaders(
  response: Response,
  options: SecurityHeadersOptions = {},
  prepared: Record<string, string> = buildHeaders(options),
): Response {
  try {
    for (const [name, value] of Object.entries(prepared)) {
      if (!response.headers.has(name)) {
        response.headers.set(name, value);
      }
    }
  } catch (error) {
    // A raw/foreign Response may expose immutable headers. Keep the original
    // response rather than allowing response decoration to become a bare 500.
    try {
      console.error("[http] security header decoration failed:", redactSensitive(error));
    } catch {
      // Best-effort diagnostics only.
    }
  }
  return response;
}
