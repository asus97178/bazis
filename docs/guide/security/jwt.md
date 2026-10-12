# Аутентификация через JWT

Библиотека `bazis/library/jwt` выпускает и проверяет JWT: пару токенов
access и refresh, ключи HS256 и RS256, ротацию ключей. Как подключить
проверку к маршрутам через `@Authorize`, показано в главе
[Авторизация](../overview/authorization.md). Здесь — сами токены: обновление,
отзыв, ключи и тонкости проверки.

Все примеры проверены на bazis 0.98.26.

## Пара токенов

```ts
import { TokenIssuer, hs256 } from "bazis/library/jwt";

const issuer = new TokenIssuer({
  issuer: "my-app",
  audience: "user",
  algorithm: hs256(secret),           // секрет не короче 32 байт
  accessTtlSeconds: 900,              // 15 минут
  refreshTtlSeconds: 1_209_600,       // 14 дней
});

const pair = await issuer.issue("ann", { role: "user" });
// { accessToken: "eyJ…", refreshToken: "eyJ…", tokenType: "Bearer", expiresIn: 900 }
```

Что внутри:

| Поле | access | refresh |
| --- | --- | --- |
| `sub`, `iss`, `aud` | `ann`, `my-app`, `user` | те же |
| `iat`, `exp` | сейчас, сейчас + 15 мин | сейчас, сейчас + 14 дней |
| `jti` | новый UUID | новый UUID |
| `token_use` | `access` | `refresh` |
| Свои поля (`role`) | есть | **нет** |

- **Access** — короткий, его шлют с каждым запросом в
  `Authorization: Bearer …`.
- **Refresh** — длинный, им только получают новую пару. Свои поля в него не
  попадают.
- Подменить один другим нельзя: `verifyAccess(refreshToken)` отвергнет токен
  (`Invalid 'token_use' claim: expected 'access'`), и наоборот.

## Проверка в `@Authorize`

```ts
import { bearerToken, PRINCIPAL_STATE_KEY, type AuthorizeCheck } from "bazis/core/http";

export const signedIn: AuthorizeCheck = async (ctx) => {
  const { payload } = await ctx.services.resolve(AuthTokens).issuer.verifyAccess(bearerToken(ctx) ?? "");
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject: String(payload.sub), role: String(payload.role) });
  return true;
};
```

- `bearerToken(ctx)` возвращает токен из `Authorization: Bearer …` или
  `undefined`. Схема не зависит от регистра (`bearer` тоже подойдёт).
- Нет токена, он испорчен, истёк или подписан чужим ключом — `verifyAccess`
  бросает `JwtError`. Из проверки `@Authorize` такая ошибка превращается в
  **`401 Unauthorized`** с заголовком `WWW-Authenticate: Bearer`, а в журнал
  не попадает как ошибка сервера.

> [!NOTE]
> `bearerToken` и `401` для `JwtError` из проверки — с версии 0.98.26.
> Раньше непойманный `JwtError` давал `500`, поэтому в старых примерах
> `verifyAccess` обёрнут в `try/catch`.

## Обновление пары

```ts
const next = await issuer.rotate(refreshToken, { role: currentRole });
```

`rotate` проверяет refresh и выпускает новую пару. Два момента:

- **Свои поля передайте заново.** В refresh их нет, и без второго аргумента
  `role` из нового access пропадёт. Это к лучшему: роль при обновлении
  берут из базы, а не из старого токена.
- **Старый refresh `rotate` не отзывает.** Один и тот же refresh можно
  обменять сколько угодно раз, пока он не истёк. Если его украли, вор
  будет обновлять токены вместе с владельцем. Защита — на стороне
  приложения.

### Один refresh — одно обновление

Храните `jti` выданных refresh-токенов. При обновлении отмечайте токен
использованным, а повторное использование считайте кражей и завершайте все
сессии пользователя:

```ts
@Entity({ table: "refresh_tokens" })
export class RefreshToken {
  @Key({ generated: false }) @Column({ type: "text" }) jti = "";
  @Column({ type: "text" }) subject = "";
  @Column({ type: "datetime" }) expiresAt = new Date(0);
  @Column({ type: "datetime" }) usedAt: Date | null = null;
}

export class SessionsService {
  constructor(private readonly tokens: AuthTokens, private readonly db: AuthDb) {}

  async signIn(subject: string, role: string) {
    const pair = await this.tokens.issuer.issue(subject, { role });
    await this.remember(pair.refreshToken);
    return pair;
  }

  async refresh(refreshToken: string) {
    const { payload } = await this.tokens.issuer.verifyRefresh(refreshToken);
    const result = await this.db.transactionScope(async () => {
      const row = await this.db.refreshTokens.findForUpdate(String(payload.jti));
      if (!row) return "unknown" as const;
      if (row.usedAt !== null) {
        // Повтор: завершить все сессии. Вернуть, а не бросить — исключение
        // откатило бы этот DELETE вместе с транзакцией.
        await this.db.database.executeSqlRaw("DELETE FROM refresh_tokens WHERE subject = {0}", row.subject);
        return "reused" as const;
      }
      row.usedAt = new Date();
      await this.db.saveChanges();
      const role = await this.currentRole(row.subject);
      const pair = await this.tokens.issuer.rotate(refreshToken, { role });
      await this.remember(pair.refreshToken);
      return pair;
    });
    if (result === "unknown") throw new UnauthorizedError();
    if (result === "reused") throw new UnauthorizedError("Refresh token reuse");
    return result;
  }

  async signOut(refreshToken: string) {
    const { payload } = await this.tokens.issuer.verifyRefresh(refreshToken);
    const row = await this.db.refreshTokens.find(String(payload.jti));
    if (row) { this.db.refreshTokens.remove(row); await this.db.saveChanges(); }
  }

  private async remember(refreshToken: string) {
    const { payload } = await this.tokens.issuer.verifyRefresh(refreshToken);
    this.db.refreshTokens.add(Object.assign(new RefreshToken(), {
      jti: String(payload.jti), subject: String(payload.sub), expiresAt: new Date(Number(payload.exp) * 1000),
    }));
    await this.db.saveChanges();
  }
}
```

| Запрос | Ответ |
| --- | --- |
| `POST /auth/refresh` с новым refresh | `200`, новая пара |
| Тот же refresh второй раз | `401 {"error":"Refresh token reuse"}`, все сессии пользователя удалены |
| Свежий refresh того же пользователя после этого | `401` |
| `POST /auth/logout`, затем refresh этим токеном | `204`, затем `401` |

`findForUpdate` внутри транзакции не даёт двум параллельным обновлениям
одним токеном пройти оба ([Транзакции](../database/transactions.md#блокировка-строк)):
второе увидит `usedAt` и будет считаться повтором. Это цена защиты —
клиент, который одновременно обновляет токен из двух вкладок, выйдет из
всех сессий; обновляйте токен из одного места.
Access-токены после выхода живут до своего `exp` — поэтому их делают
короткими.

## Ключи

### HS256

Один общий секрет подписывает и проверяет. Подходит, когда токены выпускает
и проверяет одно приложение. Секрет короче 32 байт отвергается:

```text
RangeError: HS256 secret must be at least 32 bytes
```

### RS256

Приватный ключ подписывает, публичный — проверяет. Другим сервисам
достаточно публичного ключа, и подделать токен они не смогут:

```ts
import { generateRsaKeyPairPem, JwtValidator, rs256 } from "bazis/library/jwt";

// один раз, например в служебном скрипте
const { publicKeyPem, privateKeyPem } = await generateRsaKeyPairPem();

// сервис входа
const issuer = new TokenIssuer({
  issuer: "auth", audience: "api",
  algorithm: rs256({ privateKeyPem, publicKeyPem, keyId: "rsa-2026-10" }),
  accessTtlSeconds: 900, refreshTtlSeconds: 1_209_600,
});

// любой другой сервис — только публичный ключ
const verifier = new JwtValidator(rs256({ publicKeyPem, keyId: "rsa-2026-10" }), {
  issuer: "auth", audience: "api", expectedTokenUse: "access",
});
const { payload } = await verifier.validate(token);
```

Ключи — в настройках модуля, приватный — как секрет:

```ts
export interface AuthConfig { privateKeyPem: Secret; publicKeyPem: string; }

export const authConfig = defineConfig<AuthConfig>("auth", {
  default: { privateKeyPem: secret(""), publicKeyPem: "" },
});
// BAZIS_AUTH__PRIVATEKEYPEM, BAZIS_AUTH__PUBLICKEYPEM
```

PEM можно передать как есть, с переводами строк, или одной строкой с `\n`
вместо них — так ключ обычно хранят в `.env` и секретах CI.

Ключ проверяется сразу при создании `rs256(...)`. Но обычный `singleton`
создаётся при первом обращении — то есть на первом входе пользователя.
Чтобы ошибка ключа остановила запуск, создайте сервис токенов при старте
через [асинхронную фабрику](../fundamentals/dependency-injection.md#асинхронные-фабрики):

```ts
@Module({
  config: authConfig,
  providers: [
    singletonAsyncFactory(AuthTokens, [authConfig.token] as const, async (config) => new AuthTokens(config)),
  ],
})
export class AuthModule {}
```

```text
[bazis] application failed: TypeError: RS256 privateKeyPem is a PKCS#1 key (BEGIN RSA PRIVATE KEY); convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
```

Что сообщает проверка:

| Ошибка | Исправление |
| --- | --- |
| `privateKeyPem is a PKCS#1 key (BEGIN RSA PRIVATE KEY)` | `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem` |
| `privateKeyPem is encrypted` | `openssl pkcs8 -in key.pem -out key-plain.pem` |
| `privateKeyPem contains a PUBLIC KEY` | Ключи перепутаны |
| `publicKeyPem contains a private key` | `openssl pkey -in key.pem -pubout -out public.pem` |
| `publicKeyPem is a PKCS#1 public key (BEGIN RSA PUBLIC KEY)` | `openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public-spki.pem` |
| `is not a PEM: expected "-----BEGIN PRIVATE KEY-----"` | Не тот файл или пустая переменная |

> [!NOTE]
> Проверка PEM при создании и поддержка `\n` — с версии 0.98.26. Раньше
> любая из этих ошибок всплывала только на первом входе как
> `DOMException: Invalid keyData`.

Публичный ключ можно раздать в формате JWK, например по адресу
`/.well-known/jwks.json`:

```ts
@Get(".well-known/jwks.json") @AllowAnonymous()
async jwks() {
  return { keys: [await rs256({ publicKeyPem, keyId: "rsa-2026-10" }).exportPublicJwk()] };
}
// { "keys": [{ "kty": "RSA", "use": "sig", "alg": "RS256", "n": "…", "e": "AQAB", "kid": "rsa-2026-10" }] }
```

### Отдельный ключ для refresh

`refreshAlgorithm` подписывает refresh-токены своим ключом. Утечка ключа
access тогда не позволит подделать refresh:

```ts
new TokenIssuer({ ..., algorithm: hs256(accessSecret), refreshAlgorithm: hs256(refreshSecret) });
```

## Ротация ключей

`JwtKeyRing` держит несколько ключей с идентификаторами (`kid`): новые
токены подписываются активным, старые проверяются своим ключом, пока его
не уберут.

```ts
import { JwtKeyRing } from "bazis/library/jwt";

const ring = await JwtKeyRing.create({
  keys: [{ keyId: "2026-09", algorithm: hs256(septemberSecret) }],
  activeKeyId: "2026-09",
});
const issuer = new TokenIssuer({ issuer: "my-app", audience: "user", algorithm: ring, accessTtlSeconds: 900, refreshTtlSeconds: 1_209_600 });
```

Плановая смена ключа — три шага:

```ts
// 1. добавить новый и сделать его активным; старые токены ещё действуют
await ring.replace({
  keys: [{ keyId: "2026-09", algorithm: hs256(septemberSecret) }, { keyId: "2026-10", algorithm: hs256(octoberSecret) }],
  activeKeyId: "2026-10",
});

// 2. подождать, пока истекут токены старого ключа (refreshTtlSeconds)

// 3. убрать старый ключ: его токены перестают приниматься
ring.revoke("2026-09");
// Invalid 'kid' claim: unknown or missing key id
```

`ring.status()` показывает ключи без секретов:
`{ revision: 1, activeKeyId: "2026-10", keys: [{ keyId: "2026-09", alg: "HS256", canSign: true }, …] }`.

- При утечке ключа — сразу `revoke`, не дожидаясь шага 2.
- Токен без `kid` (выпущенный до перехода на `JwtKeyRing`) связка не примет.
  Для такого перехода есть `legacy: { keyId, acceptUntil }` — он принимает
  токены без `kid` одним ключом до указанного момента.
- Состояние связки живёт в процессе. Если экземпляров приложения несколько,
  меняйте ключи на всех: через конфигурацию и перезапуск или своим
  механизмом рассылки.

## Несколько видов токенов

Пользователи и администраторы, клиенты и сотрудники — разные виды токенов
со своими ключами и аудиториями. `TokenService` держит их вместе:

```ts
import { TokenService } from "bazis/library/jwt";

type Kind = "user" | "admin";
const tokens = new TokenService<Kind>({
  user:  { issuer: "my-app", audience: "user",  algorithm: hs256(userSecret),  accessTtlSeconds: 900, refreshTtlSeconds: 1_209_600 },
  admin: { issuer: "my-app", audience: "admin", algorithm: hs256(adminSecret), accessTtlSeconds: 300, refreshTtlSeconds: 3_600 },
});

const adminPair = await tokens.forKind("admin").issue("root");
await tokens.forKind("user").verifyAccess(adminPair.accessToken);   // JwtSignatureError
```

Токен одного вида не принимается проверкой другого.

## Тонкости проверки

- **Запас по времени.** По умолчанию `clockSkewSeconds: 60`: токен
  принимается ещё минуту после `exp` — на случай расхождения часов между
  серверами. Строже — `clockSkewSeconds: 0` в настройках `TokenIssuer` или
  `JwtValidator`.
- **Длина.** Токен длиннее `maxTokenLength` (16 384 символа) отвергается
  до разбора.
- **Подмена алгоритма.** Проверка RS256 не примет токен HS256
  (`Unexpected algorithm 'HS256', expected 'RS256'`), и наоборот. Токен с
  `alg: none` отвергается так же.
- `iat` и `exp` — секунды с дробной частью (`1791674766.96`); стандарт это
  допускает.

| Ошибка | Когда |
| --- | --- |
| `JwtMalformedError` | Не JWT: не три части, не base64url, слишком длинный |
| `JwtSignatureError` | Подпись не сходится: чужой ключ, токен изменён |
| `JwtAlgorithmError` | Алгоритм не тот, что ожидает проверка |
| `JwtExpiredError` / `JwtNotYetValidError` | Истёк / ещё не действует |
| `JwtClaimError` | Не тот `iss`, `aud`, `token_use`, неизвестный `kid` |

Все они — подклассы `JwtError`. Ошибка настройки (короткий секрет, не тот
PEM) — это `TypeError` или `RangeError` при запуске, а не `JwtError`.

## Дальше

- [Авторизация](../overview/authorization.md)
- [Шаблоны авторизации](authorization-patterns.md)
- [Транзакции](../database/transactions.md)
- [Конфигурация](../fundamentals/configuration.md)
