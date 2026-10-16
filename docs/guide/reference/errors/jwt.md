# Ошибки JWT

Классы — из `bazis/library/jwt`, все наследуют `JwtError`. Тексты — из
исходников 0.100.7.

Ошибка проверки токена в `@Authorize` становится ответом **`401
Unauthorized`** с заголовком `WWW-Authenticate: Bearer`; текст ошибки
клиенту не уходит ([JWT](../../security/jwt.md#проверка-в-authorize)).

| Класс | Текст | Когда |
| --- | --- | --- |
| `JwtExpiredError` | `Token has expired` | Прошёл `exp` |
| `JwtNotYetValidError` | `Token is not yet valid` | Ещё не наступил `nbf` |
| `JwtSignatureError` | `Invalid token signature` | Подпись не сходится: токен подделан или подписан другим ключом (например, токен другого вида) |
| `JwtAlgorithmError` | `Unexpected algorithm 'none', expected 'HS256'` | Алгоритм в заголовке не тот, что у ключа |
| `JwtMalformedError` | `Malformed JWT: expected three non-empty segments` | Не JWT: не три части, не base64url, не JSON |
| `JwtMalformedError` | `JWT exceeds maxTokenLength` | Токен длиннее разрешённого |
| `JwtClaimError` | `Invalid 'aud' claim: audience mismatch` | Не тот получатель |
| `JwtClaimError` | `Invalid 'iss' claim: issuer mismatch` | Не тот издатель |
| `JwtClaimError` | `Invalid 'exp' claim: expiration is required` | В токене нет срока |
| `JwtClaimError` | `Invalid 'kid' claim: unknown or missing key id` | Ключ с таким `kid` не найден — например, удалён при ротации |
| `JwtClaimError` | `Invalid 'token_use' claim: expected 'access'` | Refresh-токен передан вместо access или наоборот |

Поле `claim` у `JwtClaimError` — имя утверждения.

## Ошибки настройки

Неверный ключ подписи останавливает запуск:

```text
RangeError: HS256 secret must be at least 32 bytes
[bazis] application failed: TypeError: RS256 privateKeyPem is a PKCS#1 key (BEGIN RSA PRIVATE KEY); convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
```

Подробно — в главе [JWT](../../security/jwt.md#ключи).

## Дальше

- [JWT](../../security/jwt.md)
- [Авторизация](../../overview/authorization.md)
