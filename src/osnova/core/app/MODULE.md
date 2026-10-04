# Композиция приложения

Версия паспорта: 1.1. Дата: 2026-09-26. Тип: существующий технический модуль композиции.
Путь: `src/osnova/core/app`. Точка входа: [runApp.ts](runApp.ts).
Область: добавление `RunAppOptions.grpc`; остальные HTTP/UI/infra опции описаны
в исходных контрактах. Модуль существовал до обязательной CLI-генерации.

runApp собирает feature root, инфраструктуру и явно включённые серверные
транспорты в одном kernel. Добавлен optional `grpc?: GrpcModuleOptions`.
Поля, defaults, ошибки и ограничения — в [паспорте gRPC](../grpc/MODULE.md).
С 2026-09-20 gRPC использует собственные контракты/кодеки Osnova и встроенный
HTTP/2 без внешних библиотек; форма RunAppOptions.grpc сохранена. Типы и
специфичные passthrough-опции стороннего SDK удалены по решению владельца.
undefined не запускает gRPC; `{}` включает listener 127.0.0.1:50051 и контроллеры
feature root; null не допускается.

При одновременных http и grpc серверы используют один контейнер и разные request
scopes. grpc.imports расширяют опубликованное gRPC-дерево; http.imports сохраняют
назначение. Владение providers, конфигурацией kernel и imports/exports сохраняется.

`RunAppOptions.validator` задаёт существующий синхронный ModelValidator для
HTTP и gRPC; по умолчанию modelValidatorAdapter. gRPC-only также получает этот
адаптер. Необязательный `grpc.validator` заменяет его только для gRPC (null
запрещён). Каждый сервер фиксирует свой валидатор при создании: более поздний
HTTP useModelValidator не переключает работающий gRPC. Для DTO нужна привязка
по классу параметра через di:generate либо явный второй аргумент @GrpcMethod.
Ошибки DTO отображаются в INVALID_ARGUMENT с ограниченными ошибками полей,
а не в HTTP 400; детали и streaming-семантика — в паспорте gRPC.

```ts
await runApp(AppModule, {
  http: { port: 3000 },
  grpc: { address: "127.0.0.1:50051" },
});
```

Компоненты изменения: RunAppOptions и композиция перед Osnova.run.
Собственных новых providers/ORM/UI/AI-обработчиков нет. DI-экспорты и lifecycle
принадлежат существующему kernel и транспортам. TS-фасад @osnova также
экспортирует gRPC-декораторы и контракты. Результат runApp остаётся Promise number
по существующему контракту Osnova.run; ошибки startup не считаются успехом.

Проверки HTTP + gRPC, приватного constructor DI и самостоятельного бинарника:
[grpc.codegen-binary.test.ts](../grpc/test/grpc.codegen-binary.test.ts).
Обычные проверки: [runApp.config.test.ts](test/runApp.config.test.ts).
База до изменения: полный TypeScript check PASS. Итоги фиксируются в паспорте
gRPC; изменение не квалифицирует внешнюю инфраструктуру приложения.
