/**
 * Библиотека JWT для Osnova.
 *
 * Чистая логика JWT без сервисов, контроллеров и зависимостей от ядра:
 * только Web Crypto и стандартные API, совместимо с компиляцией в бинарник
 * (`bun build --compile`).
 *
 * Слои:
 * - {@link SigningAlgorithm} — стратегия подписи (HS256 / RS256), кэширует ключи.
 * - {@link JwtEncoder} / {@link JwtValidator} — кодирование и строгая валидация.
 * - {@link TokenIssuer} — выпуск пары access/refresh для одного вида токена.
 * - {@link TokenService} — реестр видов токенов (USER / ADMIN / EMPLOYEE …),
 *   каждый со своим ключом и `aud`; токены видов взаимно невалидны.
 *
 * Безопасность по умолчанию: fail-closed валидация, проверка `alg` (защита от
 * algorithm confusion), проверка HMAC через Web Crypto, обязательная привязка
 * `token_use` в TokenIssuer (access ≠ refresh). Контракты: MODULE.md.
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
