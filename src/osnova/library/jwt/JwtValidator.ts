import { base64UrlDecode, base64UrlDecodeToString } from "./base64url";
import { RegisteredClaims, TOKEN_USE_CLAIM, type JwtHeader, type JwtPayload, type TokenUse } from "./claims";
import {
  JwtAlgorithmError,
  JwtClaimError,
  JwtExpiredError,
  JwtMalformedError,
  JwtNotYetValidError,
  JwtSignatureError,
} from "./errors";
import type { SigningAlgorithm } from "./signing/SigningAlgorithm";
import { JwtKeyRing } from "./JwtKeyRing";
import { resolveMaxTokenLength } from "./limits";

/** Default leeway (seconds) for `exp`/`nbf` to tolerate clock drift. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

export interface JwtValidationOptions {
  /** Require `iss` to equal this value. */
  readonly issuer?: string;
  /** Require `aud` to contain at least one of these values. */
  readonly audience?: string | readonly string[];
  /** Require the `token_use` claim to equal this value. */
  readonly expectedTokenUse?: TokenUse;
  /** Finite, non-negative leeway in seconds (default {@link DEFAULT_CLOCK_SKEW_SECONDS}). */
  readonly clockSkewSeconds?: number;
  /** Require `exp` to be present as a NumericDate. Default true. */
  readonly requireExpiration?: boolean;
  /** Maximum compact JWS length, checked before parsing or crypto. Default 16384. */
  readonly maxTokenLength?: number;
}

/** A successfully verified token: decoded header and payload. */
export interface VerifiedToken {
  readonly header: JwtHeader;
  readonly payload: JwtPayload;
}

/**
 * Verifies a compact JWS and validates its registered claims.
 *
 * Invalid tokens throw a {@link JwtError} subclass. Operational failures of
 * the configured signing strategy propagate unchanged. The `alg` header must match the configured
 * algorithm, which blocks algorithm-confusion attacks. Bound to one
 * {@link SigningAlgorithm}; create separate validators for separate keys.
 */
export class JwtValidator {
  private readonly clockSkewSeconds: number;
  private readonly options: JwtValidationOptions;
  private readonly maxTokenLength: number;

  public constructor(
    private readonly algorithm: SigningAlgorithm | JwtKeyRing,
    options: JwtValidationOptions = {},
  ) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("JWT validation options must be an object");
    }
    const snapshot = { ...options };
    if (snapshot.issuer !== undefined && (typeof snapshot.issuer !== "string" || snapshot.issuer.length === 0)) {
      throw new TypeError("JWT issuer must be a non-empty string");
    }
    if (snapshot.audience !== undefined) {
      const values = typeof snapshot.audience === "string" ? [snapshot.audience]
        : Array.isArray(snapshot.audience) ? [...snapshot.audience] : snapshot.audience;
      if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== "string" || value.length === 0)) {
        throw new TypeError("JWT audience must be a non-empty string or array of non-empty strings");
      }
      if (Array.isArray(snapshot.audience)) snapshot.audience = Object.freeze(values);
    }
    if (snapshot.expectedTokenUse !== undefined && snapshot.expectedTokenUse !== "access" && snapshot.expectedTokenUse !== "refresh") {
      throw new TypeError("JWT expectedTokenUse must be access or refresh");
    }
    if (snapshot.requireExpiration !== undefined && typeof snapshot.requireExpiration !== "boolean") {
      throw new TypeError("JWT requireExpiration must be a boolean");
    }
    const skew = snapshot.clockSkewSeconds === undefined ? DEFAULT_CLOCK_SKEW_SECONDS : snapshot.clockSkewSeconds;
    if (typeof skew !== "number" || !Number.isFinite(skew) || skew < 0) {
      throw new RangeError("JWT clockSkewSeconds must be finite and non-negative");
    }
    this.options = Object.freeze(snapshot);
    this.clockSkewSeconds = skew;
    this.maxTokenLength = resolveMaxTokenLength(snapshot.maxTokenLength);
  }

  public async validate(token: string): Promise<VerifiedToken> {
    if (typeof token !== "string") {
      throw new JwtMalformedError("Malformed JWT: expected a string");
    }
    if (token.length > this.maxTokenLength) throw new JwtMalformedError("JWT exceeds maxTokenLength");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => part.length === 0)) {
      throw new JwtMalformedError("Malformed JWT: expected three non-empty segments");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    const header = this.parseSegment<JwtHeader & Record<string, unknown>>(encodedHeader, "header");
    if (typeof header.alg !== "string" || header.alg.length === 0) {
      throw new JwtMalformedError("Malformed JWT algorithm");
    }
    for (const field of ["kid", "typ", "cty"] as const) {
      if (header[field] !== undefined && typeof header[field] !== "string") {
        throw new JwtMalformedError(`Malformed JWT ${field}`);
      }
    }
    if (header.crit !== undefined) {
      throw new JwtMalformedError("JWT critical extensions are not supported");
    }
    if (header.b64 !== undefined && header.b64 !== true) {
      throw new JwtMalformedError("JWT unencoded payloads are not supported");
    }
    const algorithm = this.algorithm instanceof JwtKeyRing ? this.algorithm.verificationKey(header.kid, header.alg) : this.algorithm;
    if (header.alg !== algorithm.alg) {
      throw new JwtAlgorithmError(`Unexpected algorithm '${header.alg}', expected '${algorithm.alg}'`);
    }
    if (!(this.algorithm instanceof JwtKeyRing) && algorithm.keyId !== undefined && header.kid !== algorithm.keyId) {
      throw new JwtClaimError("kid", "key id mismatch");
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    let signature: Uint8Array;
    try {
      signature = base64UrlDecode(encodedSignature);
    } catch {
      throw new JwtMalformedError("Malformed JWT signature encoding");
    }
    if (!(await algorithm.verify(signingInput, signature))) {
      throw new JwtSignatureError();
    }
    if (this.algorithm instanceof JwtKeyRing) {
      this.algorithm.assertCurrent(algorithm);
      // Recheck migration cutoff/policy after crypto, including a concurrent policy change.
      if (this.algorithm.verificationKey(header.kid, header.alg) !== algorithm) throw new JwtClaimError("kid", "key policy changed during the operation");
    }

    const payload = this.parseSegment<JwtPayload>(encodedPayload, "payload");
    this.validateClaims(payload);
    return { header, payload };
  }

  private parseSegment<T>(segment: string, label: string): T {
    try {
      const value: unknown = JSON.parse(base64UrlDecodeToString(segment));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Expected a JSON object");
      }
      return value as T;
    } catch {
      throw new JwtMalformedError(`Malformed JWT ${label}`);
    }
  }

  private validateClaims(payload: JwtPayload): void {
    const now = Date.now() / 1000;

    for (const claim of [RegisteredClaims.Issuer, RegisteredClaims.Subject, RegisteredClaims.JwtId]) {
      if (payload[claim] !== undefined && typeof payload[claim] !== "string") {
        throw new JwtClaimError(claim, "must be a string");
      }
    }
    const audience = payload[RegisteredClaims.Audience];
    if (audience !== undefined && typeof audience !== "string" &&
        (!Array.isArray(audience) || audience.length === 0 || audience.some(value => typeof value !== "string"))) {
      throw new JwtClaimError(RegisteredClaims.Audience, "must be a string or non-empty array of strings");
    }

    if (this.options.issuer !== undefined && payload[RegisteredClaims.Issuer] !== this.options.issuer) {
      throw new JwtClaimError(RegisteredClaims.Issuer, "issuer mismatch");
    }

    if (this.options.audience !== undefined) {
      this.assertAudience(payload[RegisteredClaims.Audience]);
    }

    if (this.options.expectedTokenUse !== undefined && payload[TOKEN_USE_CLAIM] !== this.options.expectedTokenUse) {
      throw new JwtClaimError(TOKEN_USE_CLAIM, `expected '${this.options.expectedTokenUse}'`);
    }

    const exp = this.numericDate(payload, RegisteredClaims.ExpiresAt);
    if (exp === undefined) {
      if (this.options.requireExpiration !== false) {
        throw new JwtClaimError(RegisteredClaims.ExpiresAt, "expiration is required");
      }
    } else if (now - this.clockSkewSeconds >= exp) {
      throw new JwtExpiredError();
    }

    const nbf = this.numericDate(payload, RegisteredClaims.NotBefore);
    if (nbf !== undefined && now + this.clockSkewSeconds < nbf) {
      throw new JwtNotYetValidError();
    }
    this.numericDate(payload, RegisteredClaims.IssuedAt);
  }

  private numericDate(payload: JwtPayload, claim: string): number | undefined {
    const value = payload[claim];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new JwtClaimError(claim, "must be a finite NumericDate");
    }
    return value;
  }

  private assertAudience(actual: JwtPayload[string]): void {
    const expected = typeof this.options.audience === "string" ? [this.options.audience] : this.options.audience!;
    const present = typeof actual === "string" ? [actual] : Array.isArray(actual) ? actual : [];
    if (!present.some((value) => expected.includes(value))) {
      throw new JwtClaimError(RegisteredClaims.Audience, "audience mismatch");
    }
  }
}
