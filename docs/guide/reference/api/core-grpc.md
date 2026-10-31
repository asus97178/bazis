# `bazis/core/grpc`

gRPC: сервер на встроенном HTTP/2 Bun и клиент, без внешних пакетов.
Список — по пакету 0.126.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `loadGrpcPackage(filename, options?)` | Загрузка контрактов `.proto` без компилятора | [Контракт](../../realtime/grpc.md#контракт) |
| `grpcService(definition, serviceName)` | Сервис пакета по полному имени из protobuf | там же |
| `GrpcController(service)` | Класс-контроллер gRPC; подключается полем `grpcControllers` модуля | [Контроллер](../../realtime/grpc.md#контроллер) |
| `GrpcMethod(rpcName?, requestModel?)` | Метод сервиса: унарный или потоковый; модель запроса проверяется | там же |
| `GrpcError`, `GrpcStatus` | Ошибка с кодом gRPC и коды статусов | [Ошибки](../../realtime/grpc.md#ошибки) |
| `GrpcSetupError` | Ошибка описания gRPC-контроллера при запуске (RPC без `@GrpcMethod`, повтор); наследует `KernelError` | [Контроллер](../../realtime/grpc.md#контроллер) |
| `Metadata` | Метаданные вызова | [Контекст вызова](../../realtime/grpc.md#контекст-вызова) |
| `GrpcClient`, `grpcClientProvider` | Клиент; регистрация клиента в DI с ленивым подключением | [Клиент](../../realtime/grpc.md#клиент) |
| `ServerCredentials` | TLS сервера | [Безопасность и пределы](../../realtime/grpc.md#безопасность-и-пределы) |
| `grpcModule`, `GrpcServer`, `GRPC_REQUEST_BINDINGS` | Модуль и сервер; `runApp({ grpc })` создаёт их сам | — |

Типы: `GrpcContext`, `GrpcModuleOptions`, `GrpcCallOptions`,
`GrpcClientOptions`, `GrpcClientTlsOptions`, `GrpcResponse`,
`GrpcResponseStream`, `MetadataValue`, `MethodDefinition`,
`ServiceDefinition`, `PackageDefinition`, `ProtoLoaderOptions`,
`ServerOptions`, `ModelValidator`, `ModelValidationIssue`.

Ошибки и коды статусов — [Ошибки gRPC](../errors/realtime.md#grpc).
