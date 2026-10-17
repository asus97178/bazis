# `bazis/library/jwt`

JWT без внешних пакетов: выдача и проверка пары токенов, ключи HS256 и
RS256, ротация. Список — по пакету 0.104.0.

## Токены

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `TokenIssuer` | Выдача и проверка пары access/refresh для одного вида токенов | [Пара токенов](../../security/jwt.md#пара-токенов) |
| `TokenService` | Несколько видов токенов: `forKind("user")` | [Несколько видов токенов](../../security/jwt.md#несколько-видов-токенов) |
| `hs256(secret)`, `Hs256Algorithm`, `HS256_MIN_KEY_BYTES` | Подпись HMAC-SHA256; ключ не короче 32 байт | [HS256](../../security/jwt.md#hs256) |
| `rs256(keys)`, `Rs256Algorithm`, `generateRsaKeyPairPem()` | Подпись RSA; пара ключей для разработки и тестов | [RS256](../../security/jwt.md#rs256) |
| `JwtKeyRing` | Набор ключей с `kid` для ротации | [Ротация ключей](../../security/jwt.md#ротация-ключей) |
| `JwtEncoder`, `JwtValidator` | Низкоуровневые подпись и проверка токена | [Тонкости проверки](../../security/jwt.md#тонкости-проверки) |
| `RegisteredClaims`, `TOKEN_USE_CLAIM` | Имена стандартных утверждений и `token_use` | — |
| `DEFAULT_CLOCK_SKEW_SECONDS`, `DEFAULT_MAX_TOKEN_LENGTH` | Допуск по времени и предел длины токена | — |

## Ошибки

`JwtError` и наследники: `JwtExpiredError`, `JwtNotYetValidError`,
`JwtSignatureError`, `JwtAlgorithmError`, `JwtMalformedError`,
`JwtClaimError` — [Ошибки JWT](../errors/jwt.md).

## Кодирование

`base64UrlEncode`, `base64UrlEncodeString`, `base64UrlDecode`,
`base64UrlDecodeToString`, `encodePem`, `decodePem`, `decodePemToBuffer`,
`timingSafeEqual` (сравнение без утечки по времени).

## Типы

`TokenIssuerConfig`, `TokenPair`, `TokenUse`, `VerifiedToken`, `JwtPayload`,
`JwtHeader`, `ClaimValue`, `CustomClaims`, `JwtValidationOptions`,
`SigningAlgorithm`, `Rs256KeyMaterial`, `JwtKeyEntry`, `JwtKeyRingConfig`.
