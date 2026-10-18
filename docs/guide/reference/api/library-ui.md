# `bazis/library/ui`

Декларативные UI-профили: описание интерфейса над контроллерами модуля
(списки, формы, страницы, навигация), из которого будет отрисовываться
интерфейс. Глава о них появится вместе с отрисовкой; до тех пор это
экспериментальная часть API, её форма может меняться. Список — по пакету
0.104.1.

Значения: `UiProfile`, `defineUiProfile`, `uiOperation`, `uiEndpoint`,
`compileUiSurfaceV1`, `indexOpenApiV1`, `uiProfileAuthoringMetadataOf`,
`isUiProfileAuthoringClass`, `uiDiagnosticV1`, `uiDocumentRevision`,
`canonicalUiJson`, `normalizeUiJsonValue`, `normalizeUiJsonObject`,
`UI_PROFILE_V1_KIND`, `UI_PROFILE_V1_API_VERSION`,
`COMPILED_UI_SURFACE_V1_KIND`, `COMPILED_UI_SURFACE_V1_API_VERSION`.

Типы: профили `UiProfileV1`, `UiProfileSpecV1` и их части `Ui…ProfileV1`
(список, форма, детали, навигация, страницы, действия, поля), описание
`Ui…Authoring`, скомпилированная поверхность `CompiledUiSurfaceV1` и
`CompiledUi…V1`, индекс OpenAPI `UiOpenApi…V1`, схемы `UiSchema…V1`,
JSON `UiJsonValue`, `UiJsonObject`, `UiJsonPrimitive`.

Хостинг поверхностей — опция `runApp({ ui })` из
[`bazis/core/app`](core-app.md#ui-поверхности).

<details>
<summary>Все типы (90)</summary>

`AnyUiProfileAuthoringOptions`, `CompiledUiActionV1`, `CompiledUiCustomPageBaseV1`, `CompiledUiCustomPageV1`, `CompiledUiDashboardBlockV1`, `CompiledUiDashboardPageV1`, `CompiledUiDocumentPageV1`, `CompiledUiFeaturePageV1`, `CompiledUiNavigationItemV1`, `CompiledUiOperationRefV1`, `CompiledUiResourceOperationsV1`, `CompiledUiResourceV1`, `CompiledUiSettingsPageV1`, `CompiledUiSurfaceLinksV1`, `CompiledUiSurfaceMetadataV1`, `CompiledUiSurfaceSpecV1`, `CompiledUiSurfaceV1`, `CompileUiSurfaceV1Options`, `CompileUiSurfaceV1Result`, `UiActionIntentOverride`, `UiActionIntentV1`, `UiActionPlacementOverride`, `UiActionPlacementV1`, `UiActionProfileV1`, `UiAuthoringClass`, `UiControllerClass`, `UiControllerMethod`, `UiControllerMethodKey`, `UiControllerMethodReference`, `UiCustomPageAuthoring`, `UiCustomPageBaseAuthoring`, `UiCustomPageBaseProfileV1`, `UiCustomPageProfileV1`, `UiCustomPagesProfileAuthoringOptions`, `UiDashboardBlockAuthoring`, `UiDashboardBlockProfileV1`, `UiDashboardPageAuthoring`, `UiDashboardPageProfileV1`, `UiDataFieldKey`, `UiDeleteAuthoringOverride`, `UiDetailProfileV1`, `UiDetailSectionProfileV1`, `UiDiagnosticSeverityV1`, `UiDiagnosticV1`, `UiDocumentPageAuthoring`, `UiDocumentPageProfileV1`, `UiEndpointAuthoringOptions`, `UiEndpointReference`, `UiFeaturePageAuthoring`, `UiFeaturePageProfileV1`, `UiFieldProfileV1`, `UiFieldSelection`, `UiFormAuthoringOverride`, `UiFormFieldMap`, `UiFormFieldOverride`, `UiFormProfileV1`, `UiFormsProfileV1`, `UiJsonObject`, `UiJsonPrimitive`, `UiJsonValue`, `UiListAuthoringOverride`, `UiListFieldOverride`, `UiListProfileV1`, `UiNavigationProfileV1`, `UiOpenApiHttpMethodV1`, `UiOpenApiIndexResultV1`, `UiOpenApiIndexV1`, `UiOpenApiOperationV1`, `UiOperationRefV1`, `UiProfileAuthoringMetadata`, `UiProfileAuthoringOptions`, `UiProfileMetadataV1`, `UiProfileNavigationOverride`, `UiProfileOperations`, `UiProfileSpecV1`, `UiProfileV1`, `UiRequestClass`, `UiResourceOperationsProfileV1`, `UiResourceProfileV1`, `UiResponseReference`, `UiResponseValue`, `UiSchemaCategorizationV1`, `UiSchemaCategoryV1`, `UiSchemaControlV1`, `UiSchemaElementV1`, `UiSchemaLabelV1`, `UiSchemaLayoutV1`, `UiSettingsPageAuthoring`, `UiSettingsPageProfileV1`, `UiSortField`.

</details>
