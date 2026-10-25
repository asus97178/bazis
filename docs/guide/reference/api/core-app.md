# `bazis/core/app`

Точка входа приложения. Список — по пакету 0.120.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `runApp(AppModule, options)` | Запуск приложения: ядро, HTTP, gRPC, WebSocket, инфраструктура, плавная остановка | [Приложение](../../overview/application.md), [параметры](../configuration.md#runapp) |
| `RunAppOptions` | Тип опций `runApp` | [Параметры конфигурации](../configuration.md#runapp) |
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
