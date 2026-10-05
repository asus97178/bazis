/**
 * JWT library for Osnv.
 *
 * Pure JWT logic without services, controllers or kernel dependencies: only
 * Web Crypto and standard APIs, compatible with binary compilation
 * (`bun build --compile`).
 *
 * Layers:
 * - {@link SigningAlgorithm}: signing strategy (HS256 / RS256), caches keys.
 * - {@link JwtKeyRing}: a set of keys addressed by `kid`, for key rotation.
 * - {@link JwtEncoder} / {@link JwtValidator}: encoding and strict validation.
 * - {@link TokenIssuer}: issues an access/refresh pair for one token kind.
 * - {@link TokenService}: registry of token kinds (for example `user` / `admin`),
 *   each with its own key and `aud`; tokens of different kinds reject each other.
 *
 * Secure by default: fail-closed validation, an `alg` check (protection against
 * algorithm confusion), HMAC verification through Web Crypto, and a mandatory
 * `token_use` binding in TokenIssuer (access ≠ refresh). Contracts: MODULE.md.
 */

export { base64UrlEncode, base64UrlDecode, base64UrlEncodeString, base64UrlDecodeToString, timingSafeEqual } from "./base64url";

export {
  RegisteredClaims,
  TOKEN_USE_CLAIM,
  type TokenUse,
  type ClaimValue,
  type JwtPayload,
  type CustomClaims,
  type JwtHeader,
} from "./claims";

export {
  JwtError,
  JwtMalformedError,
  JwtAlgorithmError,
  JwtSignatureError,
  JwtExpiredError,
  JwtNotYetValidError,
  JwtClaimError,
} from "./errors";

export type { SigningAlgorithm } from "./signing/SigningAlgorithm";
export { Hs256Algorithm, hs256, HS256_MIN_KEY_BYTES } from "./signing/Hs256Algorithm";
export { Rs256Algorithm, rs256, generateRsaKeyPairPem, type Rs256KeyMaterial } from "./signing/Rs256Algorithm";
export { decodePem, decodePemToBuffer, encodePem } from "./signing/pem";

export { JwtEncoder } from "./JwtEncoder";
export { JwtKeyRing, type JwtKeyEntry, type JwtKeyRingConfig } from "./JwtKeyRing";
export { DEFAULT_MAX_TOKEN_LENGTH } from "./limits";
export {
  JwtValidator,
  DEFAULT_CLOCK_SKEW_SECONDS,
  type JwtValidationOptions,
  type VerifiedToken,
} from "./JwtValidator";

export { TokenIssuer, type TokenIssuerConfig, type TokenPair } from "./TokenIssuer";
export { TokenService } from "./TokenService";
