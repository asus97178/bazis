# JWT и защита маршрутов

Продолжение [CRUD-модуля](crud-module.md): пользователи в базе с хешем
пароля, вход и обновление пары токенов, первый администратор из
настроек, задачи, которые видит только их владелец, и маршруты только для
администратора.

Модуль `auth` из рецепта устроен так, как его ищет CLI: после него
`bazis g module <Имя> --full` сам ставит `@Authorize` на маршруты нового
модуля.

Проверено на bazis 0.105.3 и PostgreSQL 17.

## 1. Модуль

```sh
bunx bazis g module Auth --empty
```

```text
src/app/modules/auth/
├── Auth.module.ts
├── auth.config.ts        настройки: ключ подписи, сроки токенов, первый администратор
├── tokenKinds.ts         виды токенов: admin, client
├── CurrentUser.ts        кто делает запрос
├── AuthTokens.service.ts выдача и проверка токенов
├── jwtAuth.ts            проверка для @Authorize
├── AdminSeed.ts          первый администратор при старте
├── model/                пользователи
├── services/Auth.service.ts
└── http/Auth.controller.ts
```

## 2. Настройки

```ts
// auth.config.ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface AuthConfig {
  jwtSecret: Secret;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  adminEmail: string;
  adminPassword: Secret;
}

export const authConfig = defineConfig<AuthConfig>("auth", {
  default: {
    jwtSecret: secret("dev-only-secret-at-least-32-bytes!!"),
    accessTtlSeconds: 900,
    refreshTtlSeconds: 1_209_600,
    adminEmail: "admin@planner.local",
    adminPassword: secret("dev-admin-password"),
  },
  production: { jwtSecret: secret(), adminPassword: secret() },
});
```

В production ключ подписи и пароль администратора берутся только из
окружения — `BAZIS_AUTH__JWTSECRET` и `BAZIS_AUTH__ADMINPASSWORD`; без них
приложение не стартует ([Секреты](../security/secrets.md)).

## 3. Виды токенов и текущий пользователь

```ts
// tokenKinds.ts
/** Who a token belongs to. Modules from `bazis g module --full` protect their routes with it. */
export const TokenKind = { Admin: "admin", Client: "client" } as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];
```

```ts
// CurrentUser.ts
import { UnauthorizedError } from "bazis/core/http";
import type { TokenKind } from "./tokenKinds";

export interface SignedInUser {
  readonly id: string;
  readonly kind: TokenKind;
}

/** Who makes this request; filled by the @Authorize check. */
export class CurrentUser {
  #user?: SignedInUser;

  set(user: SignedInUser): void {
    this.#user = user;
  }

  get(): SignedInUser {
    if (!this.#user) throw new UnauthorizedError();
    return this.#user;
  }
}
```

`CurrentUser` — scoped-сервис: свой на каждый запрос. Проверка входа
заполняет его, сервисы читают ([Текущий пользователь в сервисах](../security/authorization-patterns.md#текущий-пользователь-в-сервисах)).

## 4. Токены и проверка

```ts
// AuthTokens.service.ts
import type { ConfigView } from "bazis/core/kernel";
import { TokenIssuer, hs256 } from "bazis/library/jwt";
import type { AuthConfig } from "./auth.config";

export class AuthTokens {
  readonly issuer: TokenIssuer;

  constructor(config: ConfigView<AuthConfig>) {
    this.issuer = new TokenIssuer({
      issuer: "planner",
      audience: "planner-api",
      algorithm: hs256(config.get("jwtSecret").reveal()),
      accessTtlSeconds: config.get("accessTtlSeconds"),
      refreshTtlSeconds: config.get("refreshTtlSeconds"),
    });
  }
}
```

```ts
// jwtAuth.ts
import { bearerToken, PRINCIPAL_STATE_KEY, type AuthorizeCheck } from "bazis/core/http";
import { AuthTokens } from "./AuthTokens.service";
import { CurrentUser } from "./CurrentUser";
import type { TokenKind } from "./tokenKinds";

/**
 * A valid access token of one of the kinds. No token or a bad one → 401
 * (the JwtError becomes 401 by itself); a token of another kind → 403.
 */
export function requireTokenKind(...kinds: TokenKind[]): AuthorizeCheck {
  return async (ctx) => {
    const { payload } = await ctx.services.resolve(AuthTokens).issuer.verifyAccess(bearerToken(ctx) ?? "");
    const user = { id: String(payload.sub), kind: payload.kind as TokenKind };
    ctx.state.set(PRINCIPAL_STATE_KEY, { subject: user.id, kind: user.kind });
    ctx.services.resolve(CurrentUser).set(user);
    return kinds.includes(user.kind);
  };
}
```

`verifyAccess` проверяет подпись, срок, издателя, аудиторию и что это
access-токен, а не refresh. Любая ошибка — `401` с заголовком
`WWW-Authenticate: Bearer`; `false` из проверки — `403`
([JWT](../security/jwt.md#проверка-в-authorize)).

## 5. Пользователи

```ts
// model/User.model.ts
import { Column, Entity, Index, Required, UUID } from "bazis/core/orm";

@Entity({ table: "users" })
export class User {
  @UUID()
  id = "";

  @Required()
  @Index({ unique: true })
  @Column({ type: "text" })
  email = "";

  @Required()
  @Column({ type: "text" })
  passwordHash = "";

  @Required()
  @Column({ type: "text" })
  kind = "client";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
```

```ts
// model/Auth.dbContext.ts
import { DbContext } from "bazis/core/orm";
import { User } from "./User.model";

export class AuthDbContext extends DbContext {
  readonly users = this.set(User);
}
```

```ts
// services/Auth.service.ts
import { UnauthorizedError } from "bazis/core/http";
import type { TokenPair } from "bazis/library/jwt";
import { AuthTokens } from "../AuthTokens.service";
import { TokenKind } from "../tokenKinds";
import { AuthDbContext } from "../model/Auth.dbContext";
import { User } from "../model/User.model";

export class AuthService {
  constructor(private readonly db: AuthDbContext, private readonly tokens: AuthTokens) {}

  /** A new client account. A taken email is a unique violation: 409. */
  async register(email: string, password: string): Promise<{ id: string; email: string }> {
    const user = Object.assign(new User(), {
      email: email.toLowerCase(),
      passwordHash: await Bun.password.hash(password),
      kind: TokenKind.Client,
    });
    this.db.users.add(user);
    await this.db.saveChanges();
    return { id: user.id, email: user.email };
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.db.users.where((u) => u.email.eq(email.toLowerCase())).firstOrDefault();
    // The same 401 for an unknown email and a wrong password.
    if (!user || !(await Bun.password.verify(password, user.passwordHash))) throw new UnauthorizedError();
    return this.issue(user);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const { payload } = await this.tokens.issuer.verifyRefresh(refreshToken);
    const user = await this.db.users.find(String(payload.sub));
    if (!user) throw new UnauthorizedError();
    return this.issue(user);
  }

  /** The first administrator, from the configuration, if there is none. */
  async ensureAdmin(email: string, password: string): Promise<boolean> {
    if (await this.db.users.where((u) => u.kind.eq(TokenKind.Admin)).any()) return false;
    this.db.users.add(Object.assign(new User(), { email, passwordHash: await Bun.password.hash(password), kind: TokenKind.Admin }));
    await this.db.saveChanges();
    return true;
  }

  async users(): Promise<{ id: string; email: string; kind: string }[]> {
    const users = await this.db.users.asNoTracking().orderBy((u) => u.email).toList();
    return users.map((user) => ({ id: user.id, email: user.email, kind: user.kind }));
  }

  private issue(user: User): Promise<TokenPair> {
    return this.tokens.issuer.issue(user.id, { kind: user.kind });
  }
}
```

- **`Bun.password`** хеширует пароль (argon2id) и проверяет его — в
  таблице хранится только хеш.
- **Неизвестный email и неверный пароль** отвечают одинаково, `401`: по
  ответу нельзя узнать, есть ли такой пользователь.
- **Повторная регистрация** нарушает уникальный индекс `email`, и
  `databaseErrorStatus` из [рецепта CRUD](crud-module.md#1-проект-и-база)
  отвечает `409`.
- **`refresh`** проверяет refresh-токен и что пользователь ещё есть, и
  выдаёт новую пару. Вид токена берётся из базы, а не из старого токена:
  сменили роль — следующее обновление её учтёт.

## 6. Первый администратор

Регистрация создаёт только клиентов. Администратора создаёт служба при
старте — после создания таблиц и до HTTP-сервера:

```ts
// AdminSeed.ts
import type { HostedService, ServiceProvider } from "bazis/core/di";
import { LOGGER, type ConfigView } from "bazis/core/kernel";
import type { AuthConfig } from "./auth.config";
import { AuthService } from "./services/Auth.service";

/** Creates the first administrator at start, after the schema and before HTTP. */
export class AdminSeed implements HostedService {
  constructor(private readonly services: ServiceProvider, private readonly config: ConfigView<AuthConfig>) {}

  async start(): Promise<void> {
    const scope = this.services.createScope();
    try {
      const created = await scope.resolve(AuthService).ensureAdmin(this.config.get("adminEmail"), this.config.get("adminPassword").reveal());
      if (created) scope.resolve(LOGGER).info("auth: administrator created", { email: this.config.get("adminEmail") });
    } finally {
      await scope.dispose();
    }
  }

  stop(): void {}
}
```

```text
[orm:schema] applied 2 operation(s): create table users, create unique index ix_users_email on users (email)
info: auth: administrator created {"email":"admin@planner.local"}
```

Служба — singleton, а `AuthService` и контекст базы — scoped, поэтому
служба создаёт свою область ([Scoped-сервисы в фоновой службе](../fundamentals/lifecycle.md#scoped-сервисы-в-фоновой-службе)).

## 7. Контроллер и модуль

```ts
// http/Auth.controller.ts
import { AllowAnonymous, Authorize, Controller, Created, Get, Post, RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";
import { CurrentUser } from "../CurrentUser";
import { requireTokenKind } from "../jwtAuth";
import { TokenKind } from "../tokenKinds";
import { AuthService } from "../services/Auth.service";

@RequestModel()
export class CredentialsRequest {
  @Validator({ required: true, email: true, maxLength: 120 })
  email!: string;

  @Validator({ required: true, minLength: 8, maxLength: 200 })
  password!: string;
}

@RequestModel()
export class RefreshRequest {
  @Validator({ required: true })
  refreshToken!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly current: CurrentUser) {}

  @Post("register")
  @AllowAnonymous()
  async register(body: CredentialsRequest) {
    const user = await this.auth.register(body.email, body.password);
    return Created(`/auth/me`, user);
  }

  @Post("login")
  @AllowAnonymous()
  login(body: CredentialsRequest) {
    return this.auth.login(body.email, body.password);
  }

  @Post("refresh")
  @AllowAnonymous()
  refresh(body: RefreshRequest) {
    return this.auth.refresh(body.refreshToken);
  }

  @Get("users")
  @Authorize(requireTokenKind(TokenKind.Admin))
  users() {
    return this.auth.users();
  }

  @Get("me")
  @Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))
  me() {
    return this.current.get();
  }
}
```

```ts
// Auth.module.ts
import { Module, scoped, singleton } from "bazis/core/di";
import { AdminSeed } from "./AdminSeed";
import { authConfig } from "./auth.config";
import { AuthTokens } from "./AuthTokens.service";
import { CurrentUser } from "./CurrentUser";
import { AuthController } from "./http/Auth.controller";
import { AuthDbContext } from "./model/Auth.dbContext";
import { User } from "./model/User.model";
import { AuthService } from "./services/Auth.service";

@Module({
  config: authConfig,
  ormBazis: {
    context: AuthDbContext,
    entities: [User],
    ensureCreated: true,
  },
  controllers: [AuthController],
  providers: [
    singleton(AuthTokens),
    scoped(CurrentUser),
    scoped(AuthService),
  ],
  background: [AdminSeed],
  exports: [CurrentUser, AuthTokens],
})
export class AuthModule {}
```

Модуль экспортирует `CurrentUser` и `AuthTokens` — их используют другие
модули.

## 8. Задачи — у каждого свои

В модуле задач из [рецепта CRUD](crud-module.md): поле владельца в
модели, импорт `AuthModule`, защита контроллера и проверка владельца в
сервисе.

```ts
// tasks/model/Tasks.model.ts — новое поле
  @Required()
  @Index()
  @Column({ type: "text" })
  ownerId = "";
```

```ts
// tasks/Tasks.module.ts
@Module({
  imports: [AuthModule],
  ormBazis: { context: TasksDbContext, entities: [Task], ensureCreated: true },
  …
})
```

```ts
// tasks/http/Tasks.controller.ts
@Controller("tasks")
@Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))
export class TasksController { … }
```

```ts
// tasks/services/Tasks.service.ts — что изменилось
export class TasksService implements ITasksService {
  constructor(private readonly db: TasksDbContext, private readonly current: CurrentUser) {}

  async list(query: ListQuery): Promise<PageResult<TaskResponse>> {
    const me = this.current.get();
    // An administrator sees every task, a client only their own.
    const tasks = me.kind === TokenKind.Admin ? this.db.tasks.asNoTracking() : this.db.tasks.asNoTracking().where((t) => t.ownerId.eq(me.id));
    const { items, total } = await paginate(tasks, query);
    return { items: items.map(toTaskResponse), total };
  }

  async get(id: string): Promise<TaskResponse | null> {
    const task = await this.findOwn(id);
    return task ? toTaskResponse(task) : null;
  }

  /** Someone else's task is "not found": 404 does not confirm that it exists. */
  private async findOwn(id: string): Promise<Task | null> {
    const me = this.current.get();
    const task = await this.db.tasks.find(id);
    return task && (task.ownerId === me.id || me.kind === TokenKind.Admin) ? task : null;
  }

  async create(body: CreateTaskRequest): Promise<TaskResponse> {
    const task = Object.assign(new Task(), {
      ownerId: this.current.get().id,
      title: body.title,
      priority: body.priority ?? 3,
      dueAt: body.dueAt === undefined ? null : new Date(body.dueAt),
    });
    // … как раньше
  }

  // update и delete ищут задачу через findOwn вместо this.db.tasks.find
}
```

Чужая задача отвечает `404`, а не `403`: `403` подтвердил бы, что задача с
таким номером существует ([Владелец записи](../security/authorization-patterns.md#владелец-записи)).

> [!WARNING]
> Если таблица `tasks` уже создана по рецепту CRUD, `ensureCreated` не
> добавит в неё столбец и остановит запуск:
>
> ```text
> SchemaMigrationRequiredError: PostgreSQL schema change requires an explicit migration.
> - Table "public"."tasks", object "ownerId": column is missing (column.missing); …
> ```
>
> Для учебной базы удалите таблицу; для настоящей — добавьте миграцию
> ([Управление схемой](../database/schema.md)).

## 9. Проверка

```text
$ curl -i -X POST localhost:3000/auth/register -H 'content-type: application/json' \
    -d '{"email":"Ann@example.com","password":"correct-horse"}'
HTTP/1.1 201 Created
{"id":"c8fa199c-…","email":"ann@example.com"}

$ … тот же email ещё раз                         → 409 {"error":"Conflict"}
$ curl -i -X POST localhost:3000/auth/login … неверный пароль
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer
{"error":"Unauthorized"}

$ curl -X POST localhost:3000/auth/login … верный пароль
{"accessToken":"eyJhbGciOiJI…","refreshToken":"eyJhbGciOiJI…","tokenType":"Bearer","expiresIn":900}

$ curl localhost:3000/auth/me -H "authorization: Bearer $ANN"
{"id":"c8fa199c-…","kind":"client"}
```

| Запрос | Ответ |
| --- | --- |
| `GET /tasks` без токена | `401` |
| `GET /tasks` с токеном Ann | только задачи Ann |
| `GET /tasks/<задача Ann>` с токеном Bob | `404` |
| `GET /tasks` с токеном администратора | все задачи |
| `GET /auth/users` с токеном клиента | `403` |
| `GET /auth/users` с токеном администратора | `200`, список пользователей |
| `GET /auth/me` с refresh-токеном вместо access | `401` |
| `POST /auth/refresh` с refresh-токеном | `200`, новая пара |

> [!NOTE]
> В `development` ответ на ошибку содержит ещё `message` и `stack` — так
> `409` выше выглядит в production.

## 10. Тест

Приложению в тесте нужны те же опции, что в `src/index.ts`: без
`errorHandler` дубликат email дал бы в тесте `500`, а не `409`. Общий
помощник:

```ts
// src/app/test/testApp.ts
import { databaseErrorStatus } from "bazis/core/orm";
import { startTestApp, type TestApp } from "bazis/core/testing";
import { AppModule } from "../modules/App.module";
import { AppInfra } from "../infra/App.infra";

/** The application as src/index.ts starts it, on a free port and the test database. */
export function startPlanner(): Promise<TestApp> {
  return startTestApp(AppModule, { infra: AppInfra, http: { errorHandler: { status: databaseErrorStatus } } });
}
```

```ts
// src/app/modules/auth/test/auth.http.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DATABASE_PROVIDER } from "bazis/core/orm";
import type { TestApp } from "bazis/core/testing";
import { startPlanner } from "../../../test/testApp";

let app: TestApp;

beforeAll(async () => {
  app = await startPlanner();
});
afterAll(async () => {
  await app.stop();
});
beforeEach(async () => {
  await app.container.resolve(DATABASE_PROVIDER).execute("DELETE FROM tasks", []);
  await app.container.resolve(DATABASE_PROVIDER).execute("DELETE FROM users WHERE kind = 'client'", []);
});

async function call(path: string, init: { body?: unknown; token?: string; method?: string } = {}) {
  return app.fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function signIn(email: string, password = "correct-horse"): Promise<string> {
  if (email !== "admin@planner.local") await call("/auth/register", { body: { email, password } });
  const response = await call("/auth/login", { body: { email, password } });
  return ((await response.json()) as { accessToken: string }).accessToken;
}

test("routes need a token; a client token is not enough for admin routes", async () => {
  expect((await call("/tasks")).status).toBe(401);
  const ann = await signIn("ann@example.com");
  expect((await call("/tasks", { token: ann })).status).toBe(200);
  expect((await call("/auth/users", { token: ann })).status).toBe(403);
  const admin = await signIn("admin@planner.local", "dev-admin-password");
  expect((await call("/auth/users", { token: admin })).status).toBe(200);
});

test("a client sees only their own tasks; someone else's is 404", async () => {
  const ann = await signIn("ann@example.com");
  const bob = await signIn("bob@example.com");
  const created = await (await call("/tasks", { token: ann, body: { title: "Ann task" } })).json() as { id: string };
  expect((await call(`/tasks/${created.id}`, { token: ann })).status).toBe(200);
  expect((await call(`/tasks/${created.id}`, { token: bob })).status).toBe(404);
  const bobList = await (await call("/tasks", { token: bob })).json() as { data: unknown[] };
  expect(bobList.data).toEqual([]);
});

test("a taken email is 409, a wrong password 401, a refresh token is not an access token", async () => {
  await signIn("ann@example.com");
  expect((await call("/auth/register", { body: { email: "ANN@example.com", password: "correct-horse" } })).status).toBe(409);
  expect((await call("/auth/login", { body: { email: "ann@example.com", password: "wrong-password" } })).status).toBe(401);
  const pair = await (await call("/auth/login", { body: { email: "ann@example.com", password: "correct-horse" } })).json() as { refreshToken: string };
  expect((await call("/auth/me", { token: pair.refreshToken })).status).toBe(401);
  expect((await call("/auth/refresh", { body: { refreshToken: pair.refreshToken } })).status).toBe(200);
});
```

Тест задач из рецепта CRUD теперь тоже входит — администратором — и
передаёт токен в каждом запросе. В `tasks.http.test.ts` замените запуск
приложения и добавьте токен в помощники:

```ts
// src/app/modules/tasks/test/tasks.http.test.ts — что изменилось
import type { TestApp } from "bazis/core/testing";
import { startPlanner } from "../../../test/testApp";

let app: TestApp;
let token = "";

beforeAll(async () => {
  app = await startPlanner();
  const login = await app.fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@planner.local", password: "dev-admin-password" }),
  });
  token = ((await login.json()) as { accessToken: string }).accessToken;
});

function post(path: string, body: unknown) {
  return app.fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

function get(path: string) {
  return app.fetch(path, { headers: { authorization: `Bearer ${token}` } });
}
```

Чтения `app.fetch("/tasks…")` в тестах замените на `get("/tasks…")`.

```text
$ bunx bazis test
 7 pass
 0 fail
    ✔  SUCCESS   all tests passed · 1.4 s
```

## Новые модули — сразу с защитой

Когда в проекте есть `src/app/modules/auth/tokenKinds.ts` и `jwtAuth.ts`,
`bazis g module <Имя> --full` ставит проверки сам:

```ts
// notes/http/Notes.controller.ts — сгенерировано
  @Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))   // чтение
  @Get()
  …
  @Authorize(requireTokenKind(TokenKind.Admin))                      // запись
  @Post()
```

Без этих файлов CLI предупреждает, что маршруты модуля открыты.

## Дальше

- [Второй модуль и связь между модулями](projects-module.md) — следующий шаг [учебного проекта](../introduction/tutorial.md)
- [JWT](../security/jwt.md) — ключи RS256, ротация, одноразовый refresh
- [Шаблоны авторизации](../security/authorization-patterns.md) — роли, `anyOf`, арендаторы, ключи API
- [Чек-лист перед продакшеном](../security/production-checklist.md#авторизация)
