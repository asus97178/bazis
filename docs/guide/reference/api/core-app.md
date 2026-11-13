# `bazis/core/app`

Точка входа приложения. Список — по пакету 0.140.2.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `@App({ modules, infra, cache, config, http, grpc, websocket, language, messages, validator, ui, kernel, configure })` | Объявление приложения: его модули, инфраструктура и серверы. Обязательно только `modules`. С версии 0.138.0 | [Приложение](../../overview/application.md), [параметры](../configuration.md#app) |
| `runApp(Application)` | Запуск объявленного приложения: ядро, HTTP, gRPC, WebSocket, инфраструктура, плавная остановка. Принимает только класс с `@App` | [Приложение](../../overview/application.md) |
| `AppOptions`, `AppSettings`, `AppClass` | Типы: что принимает `@App`; то же без `modules`; класс с `@App` | [Параметры конфигурации](../configuration.md#app) |
| `AppLanguage`, `AppMessages` | Язык текстов ответов и свои тексты | [Русская локализация](../../recipes/russian.md) |

## UI-поверхности

Декларативные UI-профили для будущей отрисовки интерфейса по модулям.
Глава о них появится вместе с отрисовкой; до тех пор это
экспериментальная часть API.

`RunAppUiOptions`, `RunAppUiSurfaceOptions`, `RunAppUiAppInfo`,
`UiLabels`, `EN_UI_LABELS`, `RU_UI_LABELS`, `UiSurfaceDocumentProvider`,
`resolveUiProfileAuthoringV1`, `ResolveUiProfileAuthoringV1Options`,
`ResolveUiProfileAuthoringV1Result`, `UI_SURFACE_SESSION_V1_KIND`,
`UI_SURFACE_SESSION_V1_API_VERSION`, `UiSurfaceSessionV1`,
`UiSurfaceSessionUser`, `UiSurfaceOperationRole`, `UiSurfacePolicyInput`,
`UiSurfacePolicyPageInput`, `UiSurfacePolicyResourceInput`,
`UiSurfacePolicyDecision`, `UiSurfacePageDecision`,
`UiSurfaceResourceDecision`.
