# gRPC

Версия паспорта: 1.3. Дата: 2026-09-26. Тип: атомарный технический модуль.
Путь: `src/osnv/core/grpc`. Публичный вход: `osnv/core/grpc`.
Подключение: `grpcModule(options)` или `runApp(AppModule, { grpc: options })`.
Статус: реализовано без внешних библиотек; функциональные проверки и binary smoke пройдены.
Область: серверные контроллеры, клиентские RPC, protobuf-контракт, DI и lifecycle транспорта.

Каркас создан из корня фактической командой:

```sh
OSNV_BUN_BIN=/private/tmp/osnv-di-structure-20260919-5pq4e459/bun-1.4.0 \
  ./scripts/osnv-bun run osnv g module Grpc --empty --modules-root src/osnv/core --no-register
```

## Ответственность и компоненты

Одна функция — взаимодействие прикладных модулей по стандартному gRPC/HTTP2.
Решение владельца от 2026-09-20: сохранить API osnv, убрать внешние библиотеки
и библиотечные типы. HTTP/2/TLS выполняет встроенный `node:http2` в Bun;
gRPC framing, metadata, статусы, parser и protobuf codec принадлежат osnv.
Ни runtime, ни тестовые клиенты не импортируют внешние пакеты. В манифесте
фреймворка нет dependencies, в lockfile нет добавленных gRPC-пакетов и их
транзитивных зависимостей. Прежнее исключение проверки импортов удалено.
Существующие инструменты проекта TypeScript/@types/Bun не заменялись.
Предметные сервисы, ORM, данные, UI, AI и бизнес-валидация остаются у приложения.
Составные части, собственный DI и постоянное хранилище не используются.

| Компонент | Файл | Вход / ответственность / результат |
| --- | --- | --- |
| Декораторы | [decorators.ts](decorators.ts) | ServiceDefinition и имя RPC → метаданные; проверка соответствия контракту |
| Регистрация | [moduleControllers.ts](moduleControllers.ts) | grpcControllers → owner-bound scoped providers существующего DI |
| Композиция | [Grpc.module.ts](Grpc.module.ts) | imports, controllers, options → singleton HOSTED_SERVICE |
| Сервер | [GrpcServer.ts](GrpcServer.ts) | Конфигурация/регистрации → listener, маршруты, start/stop и лимит вызовов |
| Клиент | [GrpcClient.ts](GrpcClient.ts) | ServiceDefinition/address → четыре вида RPC, session reuse, лимиты и close/dispose |
| Клиентский вызов | [GrpcClientCall.ts](GrpcClientCall.ts) | Bounded framing, streaming, metadata/status, deadline и отмена |
| Клиентские контракты | [clientContracts.ts](clientContracts.ts) | Options, GrpcResponse и GrpcResponseStream без библиотечных типов |
| Регистрация клиента | [grpcClientProvider.ts](grpcClientProvider.ts) | Обычный singleton factory provider; DI владеет dispose |
| Вызов | [GrpcCall.ts](GrpcCall.ts) | Request/поток → ответ/статус; scope, отмена и backpressure |
| Привязка DTO | [GrpcRequest.binding.ts](GrpcRequest.binding.ts), [GrpcBinding.contract.ts](GrpcBinding.contract.ts) | Общий binder/validator; exact-class generated metadata; INVALID_ARGUMENT и ограниченные ошибки полей |
| Контракты | [contracts.ts](contracts.ts) | Options и контекст RPC |
| Ошибка | [GrpcError.ts](GrpcError.ts) | Публичный код, сообщение и trailers |
| Protobuf | [protobuf.ts](protobuf.ts) | Выбор ServiceDefinition из пакета |
| HTTP/2 stream | [GrpcTransport.ts](GrpcTransport.ts) | Framing, deadline, metadata, trailers, bounded message buffering |
| Протокольные типы | [serviceDefinition.ts](serviceDefinition.ts), [GrpcStatus.ts](GrpcStatus.ts) | Собственные codec-контракты, опции и стандартные коды |
| Metadata / TLS | [Metadata.ts](Metadata.ts), [ServerCredentials.ts](ServerCredentials.ts) | Собственные типы вместо библиотечных |
| Protobuf parser / codec | [ProtoParser.ts](ProtoParser.ts), [ProtoSchema.ts](ProtoSchema.ts), [ProtoCodec.ts](ProtoCodec.ts), [ProtoReader.ts](ProtoReader.ts) | Proto3 syntax, bounded schema graph, encode/decode |

Состояние принадлежит одному серверу или одному RPC. Обход дерева и проверка
маршрутов выполняются при композиции. Выходной поток не создаёт неограниченную
очередь: следующий элемент запрашивается после write callback транспорта.
ORM/DI не дублируются. Собственная протокольная реализация — прямое требование
владельца; это не полный клон API стороннего gRPC SDK.

## Подключение по аналогии с HTTP

```ts
import { Module, scoped } from "osnv/core/di";
import { GrpcController, GrpcMethod, GrpcError, GrpcStatus, grpcService, loadGrpcPackage } from "osnv/core/grpc";
import { runApp } from "osnv/core/app";
import { Validator } from "osnv/library/validation";
import usersProto from "./users.proto" with { type: "file" };
import { UsersController } from "./UsersController";
import { UserService } from "./UserService";
import { IUserService } from "./IUserService";

const UsersRpc = grpcService(loadGrpcPackage(usersProto), "users.v1.UsersService");

export class GetUserRequest {
  @Validator({ required: true, integer: true, positive: true })
  id!: number;
}

@GrpcController(UsersRpc)
export class UsersGrpcController {
  constructor(private readonly users: IUserService) {}

  @GrpcMethod("GetUser")
  async getById(request: GetUserRequest) {
    const user = await this.users.getById(request.id);
    if (!user) throw new GrpcError(GrpcStatus.NOT_FOUND, "User not found.");
    return { id: user.id, name: user.name };
  }
}

@Module({
  providers: [scoped(IUserService, UserService)],
  controllers: [UsersController],
  grpcControllers: [UsersGrpcController],
  exports: [],
})
export class UsersModule {}

await runApp(UsersModule, {
  http: { port: 3000 },
  grpc: { address: "127.0.0.1:50051" },
});
```

Это схема интеграции с существующим контрактом IUserService, не готовый
публичный Users API репозитория. В существующем UsersModule добавляется поле
grpcControllers, а остальные ORM/background/UI-регистрации сохраняются.
Для примера users.proto содержит:

```proto
syntax = "proto3";
package users.v1;
service UsersService { rpc GetUser(GetUserRequest) returns (UserReply); }
message GetUserRequest { int32 id = 1; }
message UserReply { int32 id = 1; string name = 2; }
```

Существующие прикладные endpoints автоматически не публикуются.
TypeScript-импорт `.proto` требует ambient-модуля с default string, как в
[фикстуре](test/fixtures/proto.d.ts). Статический `with { type: "file" }` включает
контракт в бинарник. Зависимые proto imports требуют отдельно включённых
ресурсов/includeDirs в бинарной поставке; loader обходит доступные файлы импортов,
но не добавляет их автоматически в Bun bundle.
Можно передать готовый ServiceDefinition с генератора protobuf напрямую.

После добавления/изменения DTO выполняется `di:generate`: класс первого параметра
связывается с RPC без `@RequestModel()` и без повторения правил в контроллере.
DTO и контроллер для конвенции — именованные top-level exports проекта; поддержаны
type-only imports и aliases класса, inherited методы и nested DTO/массивы.
Без codegen можно явно написать `@GrpcMethod("GetUser", GetUserRequest)`.
Для client/bidi stream сигнатура — `input: AsyncIterable<GetUserRequest>`;
явный второй аргумент декоратора также указывает класс одного сообщения.

Контроллеры не дублируются в providers. Constructor DI связывает `di:generate`.
Регистрация принадлежит feature-модулю и видит его приватные providers; чужие
зависимости требуют обычных imports/exports. DI-экспорты gRPC-модуля: `[]`.
Сервер — singleton HOSTED_SERVICE с phase 10. GrpcServer доступен через TS-фасад:
port — порт после start и undefined до старта/после stop; activeCalls — число
handlers, включая ещё работающие после отмены. Scopes принадлежат RPC.

## Клиент: входной контракт

Дополнение от 2026-09-20: клиент — компоненты существующего атомарного модуля,
не новый модуль, DI или protobuf runtime. Внешние библиотеки не используются.

В вызывающем приложении загружается тот же `.proto`. Для UsersRpc из примера выше:

```ts
import { GrpcClient } from "osnv/core/grpc";

const client = new GrpcClient(UsersRpc, { address: "127.0.0.1:50051" });
try {
  const { data: user } = await client.unary<{ id: number }, { id: number; name: string }>(
    "GetUser", { id: 42 }, { timeoutMs: 2000 },
  );
  console.log(user.name);
} finally {
  client.close(); // В DI этот вызов делает контейнер.
}
```

В существующем feature-модуле клиент регистрируется рядом с потребляющим сервисом:

```ts
import { Module, scoped } from "osnv/core/di";
import { GrpcClient, grpcClientProvider } from "osnv/core/grpc";

export class UsersGateway {
  constructor(private readonly rpc: GrpcClient) {}
  async getUser(id: number) {
    const reply = await this.rpc.unary<{ id: number }, { id: number; name: string }>(
      "GetUser", { id },
    );
    return reply.data;
  }
}

@Module({
  providers: [
    grpcClientProvider(UsersRpc, { address: "users.internal:50051" }),
    scoped(UsersGateway),
  ],
  exports: [UsersGateway],
})
export class ConsumerModule {}
```

Constructor dependency связывает обычный codegen, ручной список deps не нужен.
Этот пример иллюстрирует регистрацию внутри своего feature-модуля, не создаёт
прикладной ConsumerModule в репозитории. `UsersRpc` и DTO берутся из общего
контракта приложения. Для вызова с другой машины сервер должен слушать доступный
интерфейс (не loopback), а клиент — использовать настоящий hostname/IP сервера.
За пределами доверенного локального соединения применяется https/TLS;
authorization передаётся через Metadata и проверяется прикладным обработчиком.

`new GrpcClient(service, options)` принимает тот же ServiceDefinition, что
контроллер. Методы выбираются по ключу, originalName или имени из RPC path;
неизвестный/неоднозначный метод и неверный режим вызова — TypeError до сети.

| Вызов | Вход | Результат |
| --- | --- | --- |
| unary<Request, Response> | method, request, options? | Promise<GrpcResponse<Response>> |
| serverStream<Request, Response> | method, request, options? | GrpcResponseStream<Response> |
| clientStream<Request, Response> | method, Iterable/AsyncIterable<Request>, options? | Promise<GrpcResponse<Response>> |
| bidi<Request, Response> | method, Iterable/AsyncIterable<Request>, options? | GrpcResponseStream<Response> |

GrpcResponse содержит data, metadata и trailers. GrpcResponseStream — одноразовый
AsyncIterable с metadata/trailers promises и cancel(). Поток нужно прочитать до
конца или отменить; ранний выход из for-await отменяет RPC. Успех подтверждается
только после полного чтения, проверки framing/cardinality и grpc-status=0.
Ненулевой статус — GrpcError, его metadata содержит trailers. Полученные до
ошибки элементы streaming-ответа не отбрасываются. Generic-типы — ответственность
вызывающего кода; wire-данные проверяет codec, TypeScript-клиенты не генерируются.

| GrpcClientOptions | Default | Правила |
| --- | --- | --- |
| address | Обязательно | host:port, http://host:port либо https://host:port; без credentials/path/query/fragment |
| tls | Нет | ca, cert, key: string/Buffer; servername: string; только https, проверка сертификата включена всегда |
| metadata | Пустая Metadata | Снимок; call metadata дополняет значения |
| timeoutMs | 30000 | Целое 1..2147483647; охватывает подключение, upload и чтение ответа |
| maxSendMessageLength / maxReceiveMessageLength | По 4 MiB | Целое 0..2147483647 байт, проверка длины до выделения receive-buffer |
| maxConcurrentCalls | 1024 | Положительное safe integer; переполнение RESOURCE_EXHAUSTED, без очереди |

GrpcCallOptions: metadata, timeoutMs (заменяет default), deadline (Date либо
конечный epoch-ms number; выбирается минимум с timeout), signal (AbortSignal).
Null, неизвестные опции и некорректные значения отклоняются. Отмена CANCELLED,
истечение срока DEADLINE_EXCEEDED; закрытие клиента отменяет активные вызовы.
close()/dispose() идемпотентны и окончательны, activeCalls показывает число RPC.

Один клиент лениво переиспользует HTTP/2 session. GOAWAY отделяет уходящую сессию:
новые RPC используют новую, начатые не повторяются. Автоматических retries нет,
поскольку ошибка сети не доказывает отсутствие удалённого побочного эффекта.
Streaming upload запрашивает следующий элемент после write callback;
download читается по запросу потребителя, без собственной неограниченной очереди.
После отмены iterator.return() вызывается best-effort, не задерживая завершение
на произвольном пользовательском iterator. Незавершаемый пользовательский код
принудительно остановить нельзя; он обязан учитывать собственную отмену.

`grpcClientProvider(service, options, token = GrpcClient)` возвращает обычный
singleton factory provider существующего DI. Каждый контейнер владеет своим
клиентом и вызывает dispose(); подключение не открывается при регистрации.
Для нескольких сервисов используются разные DI tokens и обычные imports/exports.
HTTP/2 push отключён, inbound header list объявлен 8192 байт и ограничен 128
парами. Эти транспортные ограничения не заменяют прикладную авторизацию.

## Входы и поля

### Привязка и валидация DTO (изменение 2026-09-26)

Реализовано в существующем атомарном модуле; проверки перечислены ниже.
Компоненты: decorators/contracts, GrpcServer/GrpcCall, GrpcRequestBinding,
штатный di:generate и runApp. Используется существующий HTTP modelBinder и
ModelValidator, а не новый движок. Общие generated request shapes обеспечивают
вложенные DTO/массивы. Привязка к точному классу контроллера публикуется через
существующий generated provider attachment channel, атомарно с остальным target.

| Вход | Default / null | Поведение |
| --- | --- | --- |
| Первый параметр @GrpcMethod: класс DTO | Нет привязки для interface/inline object | di:generate связывает класс с обработчиком; для AsyncIterable<DTO> связывается элемент потока; неоднозначная union/intersection с DTO — ошибка codegen |
| @GrpcMethod(name?, requestModel?) | Необязательный второй аргумент; null запрещён | Явный класс с конструктором без аргументов; приоритет над выводом codegen; старый вызов с именем сохранён |
| GrpcModuleOptions.validator | modelValidatorAdapter; null запрещён | Синхронный существующий ModelValidator; фиксируется сервером, не берётся из глобального HTTP bridge |
| RunAppOptions.validator | modelValidatorAdapter | Используется HTTP и gRPC, включая gRPC-only; grpc.validator позволяет явную замену только для gRPC |

DTO создаётся и проверяется до unary/server-streaming handler. Для входного
потока каждое потребляемое сообщение проверяется перед передачей handler.
Ошибка прерывает RPC даже если handler перехватил ошибку iterator. Не прочитанные
handler сообщения не дренируются; прежние побочные эффекты не откатываются.
Выходные DTO автоматически не проверяются. Async custom validators не включены:
действует тот же синхронный порт, что в HTTP.

Неизвестные поля удаляются; bigint сохраняется, Buffer/Uint8Array bytes копируются
в специальном внутреннем режиме binder (HTTP JSON-поведение не меняется).
Defaults protobuf применяются до DTO binding; затем используются initializer DTO
для отсутствующих полей. `required` проверяет undefined/null, но не запрещает
пустую строку или 0: при defaults:true нужны notEmpty/minLength и positive/min.
Для контроля presence используются optional protobuf-поля или defaults:false.
Nullable вложенных DTO фиксируется generated shape из типа; required и остальные
проверки значений задаются правилами валидатора, а не одним TS-типом.
Ошибки полей → INVALID_ARGUMENT (3), сообщение `Request validation failed.`;
trailer `osnv-validation-errors-bin` — UTF-8 JSON `{ errors, truncated }`,
элементы `property/message/code?`, максимум 4096 байт JSON. Длинные строки и список
обрезаются с `truncated: true`; значения входных полей автоматически не добавляются.
Прочие ошибки validator/DI остаются скрытым INTERNAL. Обработка ограничена одним
сообщением, без буферизации всего потока; прежние лимиты глубины/сложности binder
и размеров транспорта сохраняются. Нагрузочный SLA не заявляется.

Правила email/minLength/positive описываются через существующий @Validator в
runtime-классе. `.proto` определяет wire-формат, его произвольные field options
не выполняют эти правила. Для автоматической привязки нужен актуальный codegen;
в standalone без codegen передаётся requestModel явно (для сложных nested DTO
нужны generated shapes либо инициализированные вложенные экземпляры).

Null не входит в контракт перечисленных полей. Неизвестные поля верхних options
не создают новых возможностей. Неизвестные serverOptions и ProtoLoaderOptions
отклоняются. Библиотечные типы и непрозрачный passthrough чужих настроек удалены.

| Вход | Тип / источник | Обязательность / default | Правила / результат |
| --- | --- | --- | --- |
| @Module.grpcControllers | readonly Class[] | [] | Классы с @GrpcController; scoped на весь RPC; повторы в одном массиве устраняются |
| @GrpcController(service) | ServiceDefinition | Обязательно | Непустая карта: path `/package.Service/Method`, requestStream/responseStream, protobuf codecs; снимок |
| @GrpcMethod(name?, requestModel?) | Строка, необязательный класс DTO | Имя TS-метода, DTO из codegen | Public instance method; ключ, originalName или имя RPC из path; неизвестные/неоднозначные имена запрещены; явный DTO имеет приоритет |
| grpcService(definition, serviceName) | PackageDefinition, полное имя | Оба обязательны | ServiceDefinition либо TypeError, если имя не указывает на сервис |
| loadGrpcPackage(filename, options?) | string или readonly string[], ProtoLoaderOptions | filename обязателен | Собственный proto3 loader, поля опций ниже |
| imports | readonly OsnvModuleRef[] | [] | Публикует только выбранное дерево, модули дедуплицируются |
| controllers | readonly Class[] | [] | Альтернатива feature-регистрации; владелец — транспортный модуль |
| validator | ModelValidator | modelValidatorAdapter | Синхронная проверка привязанного DTO; собственный экземпляр каждого сервера |
| address | config string | 127.0.0.1:50051 | host:port или [IPv6]:port; порт 0 выбирает свободный; unix-сокеты/DNS resolver schemes не поддержаны |
| credentials | ServerCredentials | createInsecure() | Plaintext по умолчанию; createSsl(...) для TLS/mTLS |
| serverOptions | Собственный ServerOptions | Приём/ответ по 4 MiB; 1024 HTTP/2 streams на сессию | Только grpc.max_receive_message_length, grpc.max_send_message_length (целое 0..2147483647 байт), grpc.max_concurrent_streams (целое 1..4294967295) |
| maxConcurrentCalls | Положительное safe integer | 1024 | Переполнение → RESOURCE_EXHAUSTED до создания scope |
| shutdownTimeoutMs | Целое 1..2147483647, мс | 5000 | Grace period; истечение → forceShutdown и ошибка stop |
| phase | Safe integer | 10 | Инфраструктура запускается раньше, останавливается позже |

ProtoLoaderOptions: keepCase, defaults, arrays, objects, oneofs — необязательные
boolean, по умолчанию false. Поля snake_case по умолчанию преобразуются в
camelCase. defaults заполняет отсутствующие обычные скаляры; optional/oneof
сохраняют presence. arrays/objects добавляют пустые repeated/maps.
longs принимает BigInt (default), String либо Number; BigInt/String сохраняют
точность 64 бит, Number может её потерять. enums — Number (default) либо String;
bytes — Buffer (default), String (base64) либо Array. includeDirs — массив
непустых путей для импортов. Неизвестные options — ошибка загрузки.

Поддержан явно описанный proto3-профиль: scalar types, message/enum, вложенные
типы, repeated (packed/unpacked), map, oneof, optional, service/rpc и файловые
imports/public imports. Вызовы могут передавать готовые ServiceDefinition и
собственные codecs, не используя loader. Proto2/editions/extensions/groups,
weak imports и встроенный каталог well-known .proto не реализованы.
Google-типы требуют предоставленных proto3-файлов; специальное JSON-преобразование
Timestamp/Any не добавлено. Message/enum reflection descriptors стороннего SDK
не являются контрактом osnv.

Codec игнорирует неизвестные object-поля при encode и пропускает неизвестные
protobuf-поля с wire type 0/1/2/5 при decode; groups (3/4) отклоняет.
Некорректные UTF-8, varints, длины, wire types и integer ranges отклоняются.
Безопасные integer inputs — number, bigint, десятичная строка; неточный number
для 64 бит отклоняется. Глубина messages/imports ограничена 64, число schema-файлов
256, один schema-файл 4 MiB, весь schema graph 16 MiB; codec message — до 64 MiB.
Транспортные лимиты по умолчанию строже (4 MiB).

Все методы protobuf-сервиса должны иметь один @GrpcMethod. Повтор маршрута между
опубликованными контроллерами, отсутствующий метод и двойная регистрация через
providers/grpcControllers завершают сборку ошибкой. Метаданные наследуются с
copy-on-write, переопределение метода не меняет базовый класс.

| Вид RPC | Аргументы метода | Возвращаемое значение |
| --- | --- | --- |
| Unary | request, context | response или Promise response |
| Server streaming | request, context | AsyncIterable response |
| Client streaming | AsyncIterable request, context | response или Promise response |
| Bidirectional | AsyncIterable request, context | AsyncIterable response |

Поля wire-сообщений и defaults определяют `.proto` и codec. При привязке класса
DTO общий binder создаёт экземпляр, удаляет неизвестные поля и проверяет
@Validator. Interface/inline object без явной привязки сохраняет прежний raw
protobuf-путь, без автоматической DTO-валидации. HTTP routes/@Authorize не
применяются. Доступ и дополнительные предметные инварианты остаются у приложения.

GrpcContext передаётся вторым аргументом: metadata — входная Metadata;
signal — AbortSignal отмены; deadline — Date/number (сейчас epoch ms), Infinity без deadline;
peer — адрес транспорта; path — полный RPC path; sendMetadata(Metadata) —
первоначальные headers. Metadata не доказывает авторизованную identity.
Собственная Metadata предоставляет set/add/get/remove/getMap/clone/merge.
Текстовые значения — printable ASCII, ключи -bin требуют Buffer и кодируются
base64 при передаче; вход принимает padded/unpadded и повторяющиеся binary headers.
Прикладная metadata не переопределяет управляющие HTTP/2/gRPC-заголовки.

GrpcError(code, message, metadata?): code — целый status 1..16, message — публичная
строка, metadata — необязательные trailers. OK/невалидные коды запрещены.
Обычные исключения, ошибки DI/disposal и неверный streaming return → INTERNAL
с сообщением `Internal server error.` без внутренних деталей.

## Lifecycle и ограничения

start открывает listener. stop прекращает новые вызовы и ждёт транспорт/handlers.
Сигнал отмены startup не оставляет поздно открытый порт. Повторные start во время
запуска и stop присоединяются к работе; перезапуск остановленного экземпляра
запрещён. Ошибка bind не считается стартом.

Scope освобождается после handler/generator и до обычного финального ответа/статуса,
включая ошибки. При deadline/cancel ответ может закончиться раньше handler,
но scope удерживается до его завершения. Входной iterator сохраняет duplex после конца чтения.
Отмена будит ожидающее чтение/запись и передаётся handler через signal. Произвольный
код принудительно не прерывается: handler должен учитывать signal. Его scope/slot
удерживаются до завершения; timeout остановки сообщает ошибку, а не чистый drain.
При аварийном завершении всего kernel общий dispose контейнера остаётся
финальным владельцем ресурсов; продолжение неотменяемого handler не гарантируется.

Транспорт использует стандартный gRPC envelope (flag + uint32 BE length),
HTTP/2 POST и grpc-status/grpc-message trailers; поддержаны все четыре RPC-режима.
Передача — identity: compression отклоняется с UNIMPLEMENTED. Неизвестный метод —
UNIMPLEMENTED, неверный content-type — HTTP 415, повреждённый payload — INTERNAL,
превышение лимита — RESOURCE_EXHAUSTED, остановка — UNAVAILABLE.
Серверный grpc-timeout поддерживает H/M/S/m/u/n и отменяет signal без клиентского
таймера. RST_STREAM/разрыв соединения также отменяет RPC.

Транспорт не добавляет повторы и транзакции; deadline не откатывает предметные
эффекты. Reflection, grpc.health.v1, серверные interceptors, автоматический
retry/load balancing не добавлены. Клиентская регистрация использует существующий
DI через grpcClientProvider, не отдельную систему контейнеров.
Собственный ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate)
передаёт TLS/mTLS встроенному HTTP/2. Клиент дополнительно проверен с независимым
HTTP/2 TLS-сервером: доверенный сертификат, неверный hostname, недоверенный CA,
обязательный клиентский сертификат. Локальные сертификаты теста генерирует
системный openssl; это не runtime-зависимость и не внешний gRPC/protobuf SDK.
Отдельная квалификация производственных сертификатов/политик не заявляется.

Wire-правила: [gRPC HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md),
[protobuf encoding](https://protobuf.dev/programming-guides/encoding/).
Если grpc-status отсутствует, клиент использует стандартное
[HTTP → gRPC отображение](https://grpc.github.io/grpc/core/md_doc_http-grpc-status-mapping.html).
Собственная реализация не заявляет прохождение полного upstream conformance suite.

## Проверки

Среда: квалифицированный Bun 1.4.0, macOS arm64; loopback без БД/контейнеров.
Тестовый HTTP/2 peer и Echo protobuf codec независимы от production codec:
внешние gRPC/protobuf SDK не используются даже для проверок.
[Интеграционные тесты](test/grpc.integration.test.ts): четыре режима, metadata,
приватный DI, scope/dispose, ошибки, deadline/cancel, лимиты и shutdown timeout.
[Wire tests](test/grpc.wire.test.ts): фрагментация, повреждённые сообщения,
лимиты, headers/trailers, серверный deadline без клиентского таймера, остановка.
[Protobuf tests](test/protobuf.test.ts): эталонные байты, все scalar families,
вложенные/repeated/map/oneof, imports, неизвестные поля и негативные сценарии.
[Клиентские тесты](test/grpc.client.test.ts): четыре режима, aliases, metadata,
ошибки и частичные ответы, 256 KiB message через HTTP/2 flow-control window,
отмена/deadline, лимиты, некооперативный producer, DI/изоляция/dispose.
[Client wire](test/grpc.client-wire.test.ts): фиксированные protobuf bytes,
fragmentation, invalid/missing status, HTTP mapping, GOAWAY без retries,
full duplex, backpressure и ранний отказ во время upload. RST_STREAM проверен
сырыми HTTP/2 frames через TCP peer, независимо от серверного close() Bun.
[TLS/mTLS](test/grpc.client-tls.test.ts): trust/hostname/client-certificate проверки.
[DTO validation](test/grpc.validation.test.ts): отказ до активации unary handler,
все потоковые режимы и неподавляемая ошибка iterator, изоляция валидаторов,
nested DTO/массивы, bytes/bigint, bounded metadata и отрицательные настройки.
[DTO codegen](test/grpc.codegen.test.ts): type aliases, inherited методы,
одноимённые DTO разных файлов, отказ на неоднозначной union и неэкспортируемом
неявном DTO до записи generated output.
[Codegen/binary](test/grpc.codegen-binary.test.ts): отдельная копия фреймворка,
настоящий генератор, private controller DI и constructor DI собственного клиента,
четыре клиентских режима, HTTP + gRPC, бинарник без исходников и внешнего `.proto`.
После runApp проверяется автоматический dispose клиента.
Проверка 2026-09-26 дополнительно доказывает generated DTO binding, вложенную
валидацию, четыре режима RPC, общий RunAppOptions.validator и grpc.validator
override в бинарнике без исходников, node_modules и внешнего .proto.
Generated-файлы вручную не редактируются.

```sh
OSNV_BUN_BIN=<qualified-absolute-path> ./scripts/osnv-bun test --isolate --timeout 60000 ./src/osnv/core/grpc/test
./scripts/osnv-bun run di:generate --target all
./scripts/osnv-bun x --no-install tsc --noEmit
./scripts/osnv-bun run build:bin:app
```

Результаты изменения на 2026-09-26, Bun 1.4.0 с SHA/revision из toolchain/bun.json:

| Проверка | Результат |
| --- | --- |
| Весь gRPC, включая новые DTO/codegen и binary smoke | 54 PASS / 0 FAIL |
| gRPC + HTTP + app + DI + generated runtime + validation + request/codegen/import-boundary | 493 PASS / 1 FAIL, 2387 assertions, 52 files |
| di:generate --target all | PASS, production/test, 21 output |
| Полный tsc --noEmit | PASS |
| build:bin:app | PASS, 666 modules; живое приложение с БД не запускалось |
| Независимый бинарник без source/node_modules/.proto | PASS: все четыре RPC, nested DTO/arrays, bytes/bigint; HTTP+gRPC, gRPC-only, custom validator и grpc override |
| Внешние зависимости в gRPC runtime/types/tests | PASS, новых зависимостей нет |

Единственный текущий FAIL — прежний `src/osnv/cli/moduleRegistration.ts` в
проверке codegen-only списка импортов TypeScript; он не менялся. Первоначальный
общий запуск дополнительно прервался по стандартному 5-секундному таймауту
существующего full-scan codegen-теста; повтор с `--timeout 60000` прошёл.
Лог итогового запуска: `/private/tmp/osnv-grpc-validation-final-20260926.log`.
Для формальных команд использован квалифицированный runtime
`/private/tmp/osnv-grpc-validation-runtime.OxLFok/bun`; временный путь не является
частью конфигурации/контракта и может быть очищен.

Исторические результаты на 2026-09-20 (не подтверждение изменения 2026-09-26):

| Проверка | Результат |
| --- | --- |
| gRPC: 14 integration + 6 wire + 7 protobuf + 8 client + 9 client-wire + TLS + codegen/binary | 46 PASS / 0 FAIL, 297 assertions, 7 files |
| DI/HTTP/app/public DX/gRPC + import boundary, точные каталоги ./src | 421 PASS / 1 FAIL, 2103 assertions, 44 files |
| Запрет внешних runtime dependencies и gRPC imports (включая типы/тесты) | PASS, без исключений для gRPC |
| di:generate --target all | PASS, production и test, 21 output |
| Полный tsc --noEmit | PASS |
| build:bin:app | PASS, bin/osnv-app, 614 modules |
| Изолированный бинарник после удаления исходников, node_modules и .proto | PASS: HTTP + gRPC и отдельно gRPC-only; собственный клиент через DI |

Единственный FAIL общей import-boundary проверки — существующий импорт
TypeScript в `src/osnv/cli/moduleRegistration.ts`, отсутствующий в её списке
codegen-only исключений. Этот CLI-файл в данной задаче не менялся; ограничение
не скрыто и не исправлялось расширением области gRPC. Новый транспорт проходит
проверки разрешённых зависимостей и отсутствия compiler API в runtime-графе.
Полное приложение с реальными БД/infra не запускалось; контролируемый binary
smoke использует настоящий runApp, DI, HTTP/gRPC и protobuf фикстуры.

Лог исторического запуска: `/private/tmp/osnv-grpc-client-regressions-20260920.log`
(временный, может быть очищен). Результаты прежней реализации с внешними пакетами
не являются доказательством этой версии.
При указании каталогов Bun test используется префикс `./`, чтобы фильтр
выбирал каталог, а не любое совпадение подстроки пути.

Нагрузочные SLA, другие ОС, производственные сертификаты/политики и
production-развёртывание не проверены. TLS-квалификация здесь относится к клиенту
и независимому TLS peer, не к полной инфраструктуре приложения.
Новый порт живого приложения включается только явной опцией grpc.
Авторизованное изменение: убраны библиотечные типы и passthrough-опции по прямому
решению владельца; API контроллеров, DI и runApp сохранён. Кодек не обещает
полную совместимость со всеми диалектами protobuf и всеми возможностями SDK.
Остальные архитектурные правила сохранены.
