import {
  RegisteredClaims,
  TOKEN_USE_CLAIM,
  type CustomClaims,
  type JwtPayload,
  type TokenUse,
} from "./claims";
import { JwtEncoder } from "./JwtEncoder";
import { JwtValidator, type VerifiedToken } from "./JwtValidator";
import { JwtClaimError } from "./errors";
import type { SigningAlgorithm } from "./signing/SigningAlgorithm";
import type { JwtKeyRing } from "./JwtKeyRing";

export interface TokenIssuerConfig {
  /** `iss` claim written to every token of this kind. */
  readonly issuer: string;
  /**
   * `aud` claim binding tokens to this kind (e.g. `user`, `admin`, `employee`).
   * Tokens of one kind never validate against another kind's audience.
   */
  readonly audience: string;
  /** Signs and verifies tokens of this kind. Use a distinct key per kind. */
  readonly algorithm: SigningAlgorithm | JwtKeyRing;
  /** Optional separate algorithm for refresh tokens (defaults to {@link algorithm}). */
  readonly refreshAlgorithm?: SigningAlgorithm | JwtKeyRing;
  /** Finite, positive access token lifetime in seconds. */
  readonly accessTtlSeconds: number;
  /** Finite, positive refresh token lifetime in seconds. */
  readonly refreshTtlSeconds: number;
  /** Finite, non-negative clock skew leeway for validation (seconds). */
  readonly clockSkewSeconds?: number;
  /** Bound both issued and received compact JWS tokens. Default 16384. */
  readonly maxTokenLength?: number;
}

/** An access + refresh token pair, shaped for an OAuth-style response. */
export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  /** Access token lifetime in seconds. */
  readonly expiresIn: number;
}

/**
 * Issues and verifies access/refresh tokens for a single audience ("kind").
 *
 * Access and refresh tokens are both signed JWTs (stateless): they carry a
 * `token_use` claim so a refresh token can never be presented as an access
 * token and vice versa. Each kind has its own signing key and `aud`, so a
 * token minted for one kind (e.g. `user`) is cryptographically rejected by
 * another kind's validator (e.g. `admin`).
 *
 * Rotation here is stateless — {@link rotate} verifies a refresh token and
 * mints a fresh pair. Reuse detection / revocation requires a store and is
 * intentionally left to the application layer.
 */
export class TokenIssuer {
  private readonly accessEncoder: JwtEncoder;
  private readonly refreshEncoder: JwtEncoder;
  private readonly accessValidator: JwtValidator;
  private readonly refreshValidator: JwtValidator;
  private readonly config: TokenIssuerConfig;

  public constructor(config: TokenIssuerConfig) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("TokenIssuer config must be an object");
    }
    this.config = Object.freeze({ ...config });
    for (const field of ["issuer", "audience"] as const) {
      if (typeof this.config[field] !== "string" || this.config[field].length === 0) {
        throw new TypeError(`TokenIssuer ${field} must be a non-empty string`);
      }
    }
    for (const field of ["accessTtlSeconds", "refreshTtlSeconds"] as const) {
      const value = this.config[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`TokenIssuer ${field} must be finite and positive`);
      }
    }
    const refreshAlgorithm = this.config.refreshAlgorithm === undefined ? this.config.algorithm : this.config.refreshAlgorithm;
    this.accessEncoder = new JwtEncoder(this.config.algorithm, this.config);
    this.refreshEncoder = new JwtEncoder(refreshAlgorithm, this.config);
    this.accessValidator = this.buildValidator(this.config.algorithm, "access");
    this.refreshValidator = this.buildValidator(refreshAlgorithm, "refresh");
  }

  /** Mints a fresh access + refresh pair for the given subject. */
  public async issue(subject: string, claims?: CustomClaims): Promise<TokenPair> {
    if (typeof subject !== "string" || subject.length === 0) {
      throw new JwtClaimError(RegisteredClaims.Subject, "must be a non-empty string");
    }
    if (claims !== undefined && (claims === null || typeof claims !== "object" || Array.isArray(claims))) {
      throw new TypeError("Custom claims must be an object");
    }
    const [accessToken, refreshToken] = await Promise.all([
      this.accessEncoder.encode(this.buildPayload(subject, "access", this.config.accessTtlSeconds, claims)),
      this.refreshEncoder.encode(this.buildPayload(subject, "refresh", this.config.refreshTtlSeconds)),
    ]);
    return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: this.config.accessTtlSeconds };
  }

  /** Verifies an access token; throws a {@link JwtError} on any problem. */
  public verifyAccess(token: string): Promise<VerifiedToken> {
    return this.accessValidator.validate(token);
  }

  /** Verifies a refresh token; throws a {@link JwtError} on any problem. */
  public verifyRefresh(token: string): Promise<VerifiedToken> {
    return this.refreshValidator.validate(token);
  }

  /**
   * Verifies a refresh token and issues a brand-new pair for the same subject.
   * Optionally refreshes the access-token claims (e.g. updated roles).
   */
  public async rotate(refreshToken: string, claims?: CustomClaims): Promise<TokenPair> {
    const { payload } = await this.verifyRefresh(refreshToken);
    const subject = payload[RegisteredClaims.Subject];
    if (typeof subject !== "string" || subject.length === 0) {
      throw new JwtClaimError(RegisteredClaims.Subject, "refresh subject is required");
    }
    return this.issue(subject, claims);
  }

  private buildValidator(algorithm: SigningAlgorithm | JwtKeyRing, use: TokenUse): JwtValidator {
    return new JwtValidator(algorithm, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      expectedTokenUse: use,
      clockSkewSeconds: this.config.clockSkewSeconds,
      maxTokenLength: this.config.maxTokenLength,
    });
  }

  private buildPayload(subject: string, use: TokenUse, ttlSeconds: number, claims?: CustomClaims): JwtPayload {
    const now = Date.now() / 1000;
    return {
      ...claims,
      [RegisteredClaims.Subject]: subject,
      [RegisteredClaims.Issuer]: this.config.issuer,
      [RegisteredClaims.Audience]: this.config.audience,
      [RegisteredClaims.IssuedAt]: now,
      [RegisteredClaims.ExpiresAt]: now + ttlSeconds,
      [RegisteredClaims.JwtId]: crypto.randomUUID(),
      [TOKEN_USE_CLAIM]: use,
    };
  }
}
