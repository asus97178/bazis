# `bazis/library/openapi`

Документ OpenAPI и страница `/docs`. HTTP-сервер собирает документ сам из
сгенерированного кода ([OpenAPI](../../http/openapi.md)); эти функции —
для своей сборки или своей страницы. Список — по пакету 0.110.1.

| Экспорт | Что это |
| --- | --- |
| `buildOpenApiDocument(input)` | Документ OpenAPI из операций и схем |
| `serveOpenApiDocs`, `renderOpenApiHtml`, `openApiDocsHeaders` | Отдача `/docs` и `/docs/openapi.json` |
| `projectOpenApiByOperationIds` | Документ, урезанный до выбранных операций |

Типы: `OpenApiSchema`, `OpenApiParameter`, `OpenApiParameterLocation`,
`OpenApiCatalogOperation`, `OpenApiDocsOptions`, `OpenApiDocumentBuildInput`,
`GeneratedOpenApiMetadata`, `GeneratedOpenApiOperationMetadata`,
`PreparedOpenApiDocs`.
