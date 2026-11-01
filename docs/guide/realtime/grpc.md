# gRPC

gRPC — вызовы между сервисами по контракту из файла `.proto`: строгие
типы, двоичный формат, потоки в обе стороны. В bazis gRPC-контроллер
устроен как HTTP-контроллер: класс с методами, зависимости из DI,
DTO с `@Validator`, `@Authorize`. Сервер работает рядом с HTTP на своём
порту, без внешних библиотек.

Все примеры проверены на bazis 0.110.1.

## Контракт

```proto
// users/users.proto
syntax = "proto3";
package users.v1;

service UsersService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc CreateUser(CreateUserRequest) returns (User);
  rpc ListUsers(ListUsersRequest) returns (stream User);
  rpc ImportUsers(stream CreateUserRequest) returns (ImportReply);
}

message GetUserRequest { int32 id = 1; }
message CreateUserRequest { string name = 1; string email = 2; }
message ListUsersRequest { int32 limit = 1; }
message User { int32 id = 1; string name = 2; string email = 3; }
message ImportReply { int32 imported = 1; }
```

Описание сервиса загружается из файла, общий модуль отдают и серверу, и
клиентам:

```ts
// users/Users.rpc.ts
import { grpcService, loadGrpcPackage } from "bazis/core/grpc";
import usersProto from "./users.proto" with { type: "file" };

export const UsersRpc = grpcService(loadGrpcPackage(usersProto), "users.v1.UsersService");
```

`with { type: "file" }` встраивает `.proto` в собранный бинарник, а
TypeScript нужно объявление модуля:

```ts
// src/proto.d.ts
declare module "*.proto" {
  const filename: string;
  export default filename;
}
```

Поддерживается proto3: скаляры, вложенные сообщения, `enum`, `repeated`,
`map`, `oneof`, `optional`, импорт других файлов. Proto2 и расширения —
нет.

## Контроллер

```ts
// users/Users.module.ts
import { Module, singleton } from "bazis/core/di";
import { GrpcController, GrpcError, GrpcMethod, GrpcStatus, type GrpcContext } from "bazis/core/grpc";
import { Validator } from "bazis/library/validation";
import { UsersRpc } from "./Users.rpc";

export class GetUserRequest {
  @Validator({ required: true, integer: true, positive: true })
  id!: number;
}

export class CreateUserRequest {
  @Validator({ required: true, notEmpty: true, maxLength: 100 })
  name!: string;
  @Validator({ required: true, email: true })
  email!: string;
}

export class ListUsersRequest {
  @Validator({ integer: true, min: 1, max: 100 })
  limit = 10;
}

@GrpcController(UsersRpc)
export class UsersGrpcController {
  constructor(private readonly users: UsersService) {}

  @GrpcMethod("GetUser")
  getById(request: GetUserRequest) {
    const user = this.users.getById(request.id);
    if (!user) throw new GrpcError(GrpcStatus.NOT_FOUND, `User ${request.id} not found.`);
    return user;
  }

  @GrpcMethod("CreateUser")
  create(request: CreateUserRequest) {
    return this.users.create(request.name, request.email);
  }

  @GrpcMethod("ListUsers")
  async *list(request: ListUsersRequest) {          // поток ответов
    for (const user of this.users.getAll(request.limit)) yield user;
  }

  @GrpcMethod("ImportUsers")
  async importUsers(requests: AsyncIterable<CreateUserRequest>) {   // поток запросов
    let imported = 0;
    for await (const request of requests) { this.users.create(request.name, request.email); imported++; }
    return { imported };
  }
}

@Module({
  providers: [singleton(UsersService)],
  grpcControllers: [UsersGrpcController],
})
export class UsersModule {}
```

Сервер включает опция `grpc` в `runApp`, рядом с HTTP:

```ts
await runApp(AppModule, {
  http: { port: 3000 },
  grpc: { address: "0.0.0.0:50051" },
});
```

| Вид вызова | Аргументы метода | Что вернуть |
| --- | --- | --- |
| Обычный | запрос, контекст | ответ |
| Поток ответов (`returns (stream …)`) | запрос, контекст | `async *` — `yield` на каждый ответ |
| Поток запросов (`(stream …) returns`) | `AsyncIterable` запросов, контекст | ответ |
| Потоки в обе стороны | `AsyncIterable` запросов, контекст | `async *` |

- Каждый метод сервиса из `.proto` должен быть в контроллере, иначе
  запуск остановится (`GrpcSetupError`, с версии 0.112.0 — одной строкой,
  раньше `TypeError` со стеком):
  `[bazis] configuration error: UsersGrpcController: RPC ImportUsers is missing @GrpcMethod().`
- Ошибки в самих декораторах — статический или приватный метод, пустое
  имя RPC, `requestModel` не класс — тоже останавливают запуск одной
  строкой, а не импорт файла (с версии 0.113.0).
- Один вызов — одна область DI: `scoped`-сервисы живут до конца вызова,
  в том числе потокового.
- Адрес по умолчанию — `127.0.0.1:50051`; чтобы сервер был виден с других
  машин, слушайте `0.0.0.0` или адрес сети.

## Проверка запроса

Первый параметр метода — класс DTO. Кодогенерация связывает его с методом,
как модель запроса в HTTP: сообщение превращается в экземпляр класса,
лишние поля отбрасываются, правила `@Validator` проверяются до вызова
метода. В потоке запросов проверяется каждое сообщение.

Нарушение — код `INVALID_ARGUMENT` (3), а подробности лежат в трейлере
`bazis-validation-errors-bin`:

```text
CreateUser { name: "", email: "nope" }  →  3 "Request validation failed."
bazis-validation-errors-bin: {"errors":[
  {"property":"name","message":"Field \"name\" must not be empty","code":"notEmpty"},
  {"property":"email","message":"Field \"email\" must be a valid email address","code":"email"}],
  "truncated":false}
```

Поля, которых нет в сообщении, получают значения из инициализаторов DTO:
`ListUsers {}` вернёт до 10 пользователей. Для `GetUser` пустой запрос
`{}` не пройдёт `required`, а `{ id: 0 }` — `positive`: ноль отсекают
правила значения, а не `required`.

## Ошибки

| Что случилось в методе | Клиент получает |
| --- | --- |
| `throw new GrpcError(GrpcStatus.NOT_FOUND, "User 99 not found.")` | `5 "User 99 not found."` |
| Нарушены правила DTO | `3 "Request validation failed."` и трейлер с полями |
| Любое другое исключение | `13 "Internal server error."` — без подробностей |

Неожиданное исключение сервер пишет в лог, с маскировкой секретов:

```text
error: gRPC handler failed {"path":"/users.v1.UsersService/CreateUser","error":{"name":"Error","message":"database password=*** refused", …}}
```

> [!NOTE]
> Запись ошибок gRPC в лог — с версии 0.98.32. Раньше клиент получал
> `INTERNAL`, а в логе было пусто.

## Авторизация

`@Authorize` и `@AllowAnonymous` работают на gRPC-контроллерах так же,
как на HTTP, и с **теми же** проверками: проверка получает контекст с
`header()`, `services` и `state`, а `bearerToken(ctx)` читает токен из
метаданных вызова.

```ts
import { AllowAnonymous, Authorize, bearerToken, UnauthorizedError, type AuthorizeCheck, type AuthorizeContext } from "bazis/core/http";

export const signedIn: AuthorizeCheck = async (ctx) => {
  const token = bearerToken(ctx);
  if (!token) throw new UnauthorizedError();
  const { payload } = await ctx.services.resolve(AuthTokens).issuer.verifyAccess(token);
  ctx.state.set("user", { id: String(payload.sub), role: String(payload.role) });
  return true;
};
export const currentUser = (ctx: AuthorizeContext) => ctx.state.get("user") as { id: string; role: string };
export const hasRole = (role: string): AuthorizeCheck => (ctx) => currentUser(ctx).role === role;

@GrpcController(UsersRpc)
@Authorize(signedIn)
export class UsersGrpcController {
  @GrpcMethod("GetUser")
  getById(request: GetUserRequest, context: GrpcContext) {
    console.log("GetUser by", currentUser(context).id);   // контекст — тот же, что видела проверка
    …
  }

  @GrpcMethod("CreateUser") @Authorize(hasRole("admin"))
  create(request: CreateUserRequest) { … }

  @GrpcMethod("ListUsers") @AllowAnonymous()
  async *list(request: ListUsersRequest) { … }
}
```

| Вызов | Ответ |
| --- | --- |
| Без токена, с испорченным или истёкшим | `16 "Unauthenticated."` |
| `CreateUser` с токеном пользователя | `7 "Permission denied."` |
| `CreateUser` с токеном администратора | Пользователь создан |
| `ListUsers` без токена | Поток пользователей |

| Проверка | Код gRPC |
| --- | --- |
| Вернула `false` или бросила `ForbiddenError` | `PERMISSION_DENIED` (7) |
| Бросила `UnauthorizedError` или `JwtError` | `UNAUTHENTICATED` (16) |
| Бросила `GrpcError` | Его код |
| Бросила другую ошибку | `INTERNAL` (13), ошибка в логе |

Проверки выполняются до чтения запроса и до создания контроллера, так что
отклонённый вызов не тратит ресурсы на разбор сообщения. `anyOf` работает
так же, как в HTTP ([Шаблоны авторизации](../security/authorization-patterns.md#или-anyof)).

> [!NOTE]
> `@Authorize` для gRPC — с версии 0.98.32. В той же версии проверка
> получает `AuthorizeContext` вместо `HttpContext`; помощник вроде
> `currentUser(ctx)`, которому проверка передаёт свой контекст, тоже
> принимает `AuthorizeContext`.

## Контекст вызова

Второй аргумент метода — `GrpcContext`:

| Поле | Что это |
| --- | --- |
| `metadata` | Входящие метаданные (`metadata.get("x-request-id")`) |
| `header(name)` | Текстовое значение метаданных — то же, что видят проверки |
| `services`, `state` | Область DI вызова и общее с проверками состояние |
| `signal` | Отмена: клиент отключился или истёк срок вызова |
| `deadline` | Когда истекает срок (мс), `Infinity` без срока |
| `peer`, `path` | Адрес клиента и полное имя метода |
| `sendMetadata(metadata)` | Отправить начальные метаданные ответа |

Срок вызова задаёт клиент. Когда он истекает, клиент сразу получает
`DEADLINE_EXCEEDED`, а метод — сработавший `signal`. Остановить код
метода принудительно нельзя: долгую работу передавайте `signal`
дальше — в `fetch`, запросы к базе, `Bun.sleep`.

```text
клиент: SlowReport с timeoutMs: 300  →  4 "Deadline exceeded." через 303 мс
сервер: SlowReport finished after 1501 ms, aborted: true
```

## Клиент

`GrpcClientBase` вызывает любой gRPC-сервис по тому же описанию:

```ts
import { GrpcClientBase, Metadata } from "bazis/core/grpc";

const client = new GrpcClientBase(UsersRpc, { address: "users.internal:50051", timeoutMs: 2000 });
const metadata = new Metadata();
metadata.set("authorization", `Bearer ${token}`);

const { data: user } = await client.unary<{ id: number }, User>("GetUser", { id: 1 }, { metadata });

for await (const user of client.serverStream<{ limit: number }, User>("ListUsers", { limit: 10 })) { … }

await client.clientStream("ImportUsers", [{ name: "C", email: "c@example.com" }, { name: "D", email: "d@example.com" }]);
// { imported: 2 }

client.close();
```

| Метод | Для вызова |
| --- | --- |
| `unary(method, request, options?)` | Обычного; ответ — `{ data, metadata, trailers }` |
| `serverStream(method, request, options?)` | С потоком ответов — читать `for await` |
| `clientStream(method, requests, options?)` | С потоком запросов: массив или `AsyncIterable` |
| `bidi(method, requests, options?)` | С потоками в обе стороны |

- Отказ сервера — `GrpcError` с `code` и `message`; трейлеры, если сервер
  их прислал, — в `error.metadata` (поле необязательное: `error.metadata?.get(…)`).
- `timeoutMs` (по умолчанию 30 с) ограничивает весь вызов; в опциях
  вызова — `timeoutMs`, `deadline`, `signal`, `metadata`.
- Повторов нет: сетевая ошибка не доказывает, что сервер ничего не
  сделал.
- Неизвестный метод — ошибка до сети:
  `TypeError: Unknown or ambiguous gRPC method: DeleteUser.`
- Адрес `https://…` и опция `tls` включают TLS (сертификат сервера
  проверяется всегда).

### Клиент в DI

В приложении клиента объявляют так же, как контроллер: класс с декоратором
`@GrpcClient` и поле модуля `grpcClients`. Адрес и тайм-аут — в настройках:

```ts
// reports/config/UsersRpc.config.ts
import { defineConfig } from "bazis/core/kernel";

export interface UsersRpcConfig {
  address: string;
  timeoutMs: number;
}

export const usersRpcConfig = defineConfig<UsersRpcConfig>("usersRpc", {
  default: { address: "users.internal:50051", timeoutMs: 2000 },
});
```

```ts
// reports/clients/UsersClient.ts
import { GrpcClient, GrpcClientBase } from "bazis/core/grpc";

@GrpcClient(UsersRpc, { config: usersRpcConfig })
export class UsersClient extends GrpcClientBase {}
```

```ts
// reports/UsersApi.ts
import { Metadata } from "bazis/core/grpc";

export class UsersApi {
  constructor(private readonly users: UsersClient) {}

  async getById(id: number, authorization: string | undefined) {
    const metadata = new Metadata();
    if (authorization) metadata.set("authorization", authorization);   // от имени пользователя
    return (await this.users.unary<{ id: number }, User>("GetUser", { id }, { metadata })).data;
  }
}
```

```ts
@Module({
  grpcClients: [UsersClient],
  providers: [scoped(UsersApi)],
  controllers: [ReportsController],
})
export class ReportsModule {}
```

- `address` и `timeoutMs` берутся из настроек клиента:
  `BAZIS_USERSRPC__ADDRESS=…` меняет адрес без правки кода. Настройки модуль
  объявляет сам.
- Остальное (`tls`, `metadata`, пределы сообщений) — прямо в декораторе:
  `@GrpcClient(UsersRpc, { config: usersRpcConfig, maxConcurrentCalls: 50 })`.
- Клиент один на приложение; контейнер закроет его при остановке.
- Второму сервису — свой класс: `OrdersClient extends GrpcClientBase` с
  `@GrpcClient(OrdersRpc, …)`.

### Отказ сервиса в HTTP-запросе

Если вызов из HTTP-контроллера не удался, клиент HTTP получает не `500`,
а ответ «внешний сервис подвёл», как у [HTTP-клиента](../http/http-client.md#ошибки):

| Клиент получил | HTTP-ответ |
| --- | --- |
| `DEADLINE_EXCEEDED` | `504 {"error":"Gateway Timeout"}` |
| Любой другой код, сервис недоступен | `502 {"error":"Bad Gateway"}` |

Когда код ответа что-то значит для вашего API, поймайте `GrpcError` в
сервисе:

```ts
try {
  return await this.users.getById(id, authorization);
} catch (error) {
  if (error instanceof GrpcError && error.code === GrpcStatus.NOT_FOUND) throw new NotFoundError();
  throw error;
}
```

> [!NOTE]
> `502`/`504` для ошибок gRPC-клиента — с версии 0.98.32; раньше был `500`.

## Безопасность и пределы

- По умолчанию сервер работает без TLS. Между машинами включайте TLS:
  `grpc: { credentials: ServerCredentials.createSsl(caCert, [{ private_key, cert_chain }], requireClientCert) }`
  — в том числе взаимный (mTLS).
- Сообщение больше 4 МиБ — `RESOURCE_EXHAUSTED`; предел меняет
  `serverOptions: { "grpc.max_receive_message_length": … }`.
- Больше 1024 одновременных вызовов — `RESOURCE_EXHAUSTED`
  (`maxConcurrentCalls`).
- Сжатие сообщений не поддерживается: такой вызов получит `UNIMPLEMENTED`.
- Рефлексии и `grpc.health.v1` нет: о здоровье приложения сообщает HTTP
  `/health`.

## Дальше

- [Авторизация](../overview/authorization.md)
- [Шаблоны авторизации](../security/authorization-patterns.md)
- [HTTP-клиент](../http/http-client.md)
- [Модели запросов и валидация](../overview/validation.md)
