# Авторизация

Доступ к маршрутам закрывается декоратором `@Authorize`. Он принимает
функцию-проверку: она получает контекст запроса и решает, пускать ли его
дальше. Что именно проверять — JWT, ключ API, сессию, вход через Telegram, —
решает сама функция. Ядро HTTP знает только её ответ.

```ts
import { AllowAnonymous, Authorize, Controller, Get, Post } from "bazis/core/http";

@Controller("auth")
@Authorize(signedIn)                 // все методы — только для вошедших
export class AuthController {
  @Post("login")
  @AllowAnonymous()                  // кроме входа
  login(body: LoginRequest) { ... }

  @Get("me")
  me(ctx: HttpContext) { ... }
}
```

## Проверка: `AuthorizeCheck`

```ts
type AuthorizeCheck = (ctx: HttpContext) => boolean | Promise<boolean>;
```

| Что сделала проверка | Ответ клиенту |
| --- | --- |
| Вернула `true` | Запрос идёт дальше |
| Вернула `false` | `403 Forbidden` |
| Бросила `HttpError` | Код этой ошибки — например, `UnauthorizedError` → `401` |

Обычное разделение: «кто ты — не знаю» (нет токена или он неверный) —
бросить `UnauthorizedError`, получится 401; «знаю, но нельзя» (нет нужной
роли) — вернуть `false`, получится 403.

Проверка выполняется до middleware контроллера и метода, до привязки
аргументов и проверки модели. Запрос без прав не доходит ни до логики
контроллера, ни до разбора тела. Порядок целиком — в главе
[Middleware](middleware.md#порядок-выполнения).

## Пример: вход по JWT

Полный рабочий пример: вход выдаёт токен, защищённые методы его проверяют,
один метод доступен только администратору.

### Настройки и выдача токенов

Секрет подписи хранится в настройках модуля. В разработке есть значение по
умолчанию, в production его обязательно задать через окружение:

```ts
// Auth.config.ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface AuthConfig { jwtSecret: Secret; accessTtlSeconds: number; }

export const authConfig = defineConfig<AuthConfig>("auth", {
  default: { jwtSecret: secret("dev-only-secret-at-least-32-bytes!!"), accessTtlSeconds: 900 },
  production: { jwtSecret: secret() },             // без значения — обязателен
});
```

Если запустить приложение в production без секрета, оно не стартует:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
auth.jwtSecret: required non-empty secret is not set (BAZIS_AUTH__JWTSECRET).
```

Сервис оборачивает `TokenIssuer` из `bazis/library/jwt`:

```ts
// AuthTokens.service.ts
import { TokenIssuer, hs256 } from "bazis/library/jwt";
import type { ConfigView } from "bazis/core/kernel";
import type { AuthConfig } from "./Auth.config";

export class AuthTokens {
  private readonly issuer: TokenIssuer;

  constructor(config: ConfigView<AuthConfig>) {
    this.issuer = new TokenIssuer({
      issuer: "my-app",
      audience: "user",
      algorithm: hs256(config.get("jwtSecret").reveal()),   // секрет не короче 32 байт
      accessTtlSeconds: config.get("accessTtlSeconds"),
      refreshTtlSeconds: 86_400,
    });
  }

  issue(userId: string, role: string) { return this.issuer.issue(userId, { role }); }
  verify(token: string) { return this.issuer.verifyAccess(token); }
}
```

`issue` возвращает пару токенов:

```json
{ "accessToken": "eyJhbGciOiJI…", "refreshToken": "eyJhbGciOiJI…", "tokenType": "Bearer", "expiresIn": 900 }
```

`verifyAccess` проверяет подпись, срок, издателя и аудиторию и возвращает
`{ header, payload }`; при любой ошибке бросает исключение.

### Проверки

```ts
// checks.ts
import {
  PRINCIPAL_STATE_KEY, UnauthorizedError,
  type AuthorizeCheck, type HttpContext, type RequestPrincipal,
} from "bazis/core/http";
import { AuthTokens } from "./AuthTokens.service";

export interface UserPrincipal extends RequestPrincipal {
  readonly subject: string;
  readonly role: string;
}

/** Есть верный Bearer-токен → пользователь сохраняется в ctx.state; иначе 401. */
export const signedIn: AuthorizeCheck = async (ctx) => {
  const header = ctx.header("authorization");
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
  try {
    const { payload } = await ctx.services.resolve(AuthTokens).verify(header.slice("Bearer ".length));
    const principal: UserPrincipal = { subject: String(payload.sub), role: String(payload.role) };
    ctx.state.set(PRINCIPAL_STATE_KEY, principal);
    return true;
  } catch {
    throw new UnauthorizedError();
  }
};

/** Нужная роль; ставится после signedIn. Нет роли → false → 403. */
export const hasRole = (role: string): AuthorizeCheck => (ctx) => currentUser(ctx).role === role;

export function currentUser(ctx: HttpContext): UserPrincipal {
  return ctx.state.get(PRINCIPAL_STATE_KEY) as UserPrincipal;
}
```

Проверка — обычная функция без конструктора, поэтому сервисы она берёт из
`ctx.services`, как и [middleware](middleware.md#сервисы-внутри-middleware).

`PRINCIPAL_STATE_KEY` — общий ключ, под которым в `ctx.state` лежит текущий
пользователь. Его читают и встроенные части bazis: кэш ответов с
`varyByUser` и `unlessAuthenticated` узнаёт по нему, чей это запрос.

### Контроллер

```ts
// Auth.controller.ts
import { AllowAnonymous, Authorize, Controller, Get, HttpContext, Post, RequestModel, UnauthorizedError } from "bazis/core/http";
import { Validator } from "bazis/library/validation";
import { AuthTokens } from "./AuthTokens.service";
import { currentUser, hasRole, signedIn } from "./checks";

@RequestModel()
export class LoginRequest {
  @Validator({ required: true }) login!: string;
  @Validator({ required: true }) password!: string;
}

@Controller("auth")
@Authorize(signedIn)
export class AuthController {
  constructor(private readonly tokens: AuthTokens) {}

  @Post("login")
  @AllowAnonymous()
  login(body: LoginRequest) {
    if (body.password !== "demo") throw new UnauthorizedError();   // здесь — проверка пароля по базе
    return this.tokens.issue(body.login, body.login === "admin" ? "admin" : "user");
  }

  @Get("me")
  me(ctx: HttpContext) {
    return currentUser(ctx);
  }

  @Get("admin")
  @Authorize(signedIn, hasRole("admin"))      // метод заменяет проверки класса — signedIn повторяем
  admin() {
    return { secret: "only for admins" };
  }
}
```

Что получает клиент:

| Запрос | Ответ |
| --- | --- |
| `POST /auth/login` с верным паролем | `200` и пара токенов |
| `POST /auth/login` с неверным паролем | `401 {"error":"Unauthorized"}` |
| `POST /auth/login` с пустым телом | `400` с ошибками проверки модели |
| `GET /auth/me` без токена или с испорченным | `401 {"error":"Unauthorized"}` |
| `GET /auth/me` с токеном | `200 {"subject":"ann","role":"user"}` |
| `GET /auth/admin` с токеном пользователя | `403 {"error":"Forbidden"}` |
| `GET /auth/admin` с токеном администратора | `200 {"secret":"only for admins"}` |

## Класс, метод и `@AllowAnonymous`

| Где стоит | Что действует |
| --- | --- |
| `@Authorize` на классе | Проверки для всех методов |
| `@Authorize` на методе | **Только** проверки метода — классовые для него больше не действуют |
| `@AllowAnonymous()` на методе | Метод открыт, даже если класс защищён |
| `@AllowAnonymous()` на классе | Все методы открыты, кроме тех, где есть свой `@Authorize` |
| Несколько проверок `@Authorize(a, b)` или `@Authorize(a)` `@Authorize(b)` | Должны пройти все, по порядку |

> [!WARNING]
> `@Authorize` на методе **заменяет** проверки класса, а не добавляется к
> ним. Если на классе `@Authorize(signedIn)`, а на методе
> `@Authorize(hasRole("admin"))`, проверка входа для этого метода не
> выполнится. Перечисляйте на методе полный набор: `@Authorize(signedIn,
> hasRole("admin"))`. Так же устроено наследование: подкласс со своим
> `@Authorize` заменяет проверки базового класса.

Проверки выполняются по порядку и останавливаются на первой неудаче: если
`signedIn` бросил 401, `hasRole` уже не вызывается.

## Чем авторизация отличается от middleware

Проверку доступа можно написать и как middleware, но у `@Authorize` два
преимущества:

- Её видно в объявлении контроллера, и её можно точечно снять
  `@AllowAnonymous()`.
- Она выполняется раньше middleware контроллера и метода и раньше разбора
  тела запроса — неавторизованный запрос стоит серверу меньше.

Middleware уместнее для того, что касается всех запросов независимо от
прав: журнал, ограничение частоты, заголовки.

## Дальше

- [Middleware](middleware.md)
- [Модели запросов и валидация](validation.md)
- Обработка ошибок *(в работе)*
