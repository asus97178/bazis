# Служебные точки входа

Две точки входа нужны сгенерированному коду в `src/generated/bazis`;
приложение их не импортирует.

| Точка входа | Экспорты | Кто использует |
| --- | --- | --- |
| `bazis/core/generatedRuntime` | `loadBazisGeneratedRuntime`, `registerBazisGeneratedTargetDescriptor`, `warnIfGeneratedSourcesChanged`, тип `BazisGeneratedTargetDescriptor` и др. | `src/generated/bazis/runtime.ts`: регистрирует зависимости, привязки, модели запроса и OpenAPI при запуске |
| `bazis/core/http/OpenApi/generatedOpenApiRegistry` | `registerGeneratedOpenApiMetadata`, `registerGeneratedOpenApiSchemaModel`, `getGeneratedOpenApiMetadata`, `getGeneratedOpenApiSchemaName` | Сгенерированное описание OpenAPI |

Если запуск предупреждает `generated code is out of date`, запустите
`bunx bazis codegen` ([Кодогенерация](../../fundamentals/codegen.md)).
