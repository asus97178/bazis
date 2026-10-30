# `bazis/library/boundary`

Безопасная граница данных: разбор JSON с пределами, каноничный JSON и его
хеш, схемы проверки значений, диагностики. На ней построены сессии
агентов, гарантированная доставка WebSocket и кодогенерация. Приложению
обычно не нужна. Список — по пакету 0.123.0.

| Экспорт | Что это |
| --- | --- |
| `decodeBoundedJsonV1`, `normalizeBoundedJsonV1`, `BOUNDARY_JSON_LIMITS_V1`, `boundaryJsonLimitsV1`, `isBoundaryJsonObject` | JSON из недоверенного источника с пределами глубины, размера и числа узлов |
| `canonicalBoundaryJsonV1`, `canonicalBoundaryJsonBytesV1`, `canonicalJsonHashV1` | Каноничный JSON (RFC 8785) и хеш от него |
| `decodeBoundarySchemaV1`, `validateBoundaryValueV1`, `boundarySchemaHashV1`, `BOUNDARY_SCHEMA_V1_DOMAIN`, `BOUNDARY_SCHEMA_MAX_DEPTH_V1`, `BOUNDARY_SCHEMA_MAX_NODES_V1`, `BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1` | Схема значения и проверка по ней |
| `bazisDiagnosticV1`, `finalizeBazisDiagnosticsV1`, `BAZIS_DIAGNOSTIC_LIMIT_V1` | Диагностики в общем формате |
| `appendJsonPointerV1`, `escapeJsonPointerSegmentV1` | JSON Pointer для путей в диагностиках |
| `BoundaryCanonicalizationErrorV1` | Значение нельзя привести к каноничному JSON |

Типы: `BoundaryJsonValue`, `BoundaryJsonObject`, `BoundaryJsonArray`,
`BoundaryJsonPrimitive`, `BoundaryJsonLimitsV1`,
`BoundaryJsonLimitOverridesV1`, схемы `BoundarySchemaV1` и
`Boundary…SchemaV1` по видам значений, `BoundaryStringFormatV1`,
`BoundarySchemaTypeV1`, `BoundarySchemaCommonV1`, диагностики
`BazisDiagnosticV1`, `BazisDiagnosticsV1`, `BazisDiagnosticRepairV1`,
`BazisDiagnosticSeverityV1`, `BazisDiagnosticSourceV1`,
`BazisDiagnosticStageV1`, параметры и результаты функций
`Decode…`, `Normalize…`, `ValidateBoundaryValueV1…`.

<details>
<summary>Все типы (32)</summary>

`BazisDiagnosticRepairV1`, `BazisDiagnosticSeverityV1`, `BazisDiagnosticSourceV1`, `BazisDiagnosticStageV1`, `BazisDiagnosticsV1`, `BazisDiagnosticV1`, `BoundaryArraySchemaV1`, `BoundaryBooleanSchemaV1`, `BoundaryIntegerSchemaV1`, `BoundaryJsonArray`, `BoundaryJsonLimitOverridesV1`, `BoundaryJsonLimitsV1`, `BoundaryJsonObject`, `BoundaryJsonPrimitive`, `BoundaryJsonValue`, `BoundaryNullSchemaV1`, `BoundaryNumberSchemaV1`, `BoundaryObjectSchemaV1`, `BoundaryScalarSchemaV1`, `BoundarySchemaCommonV1`, `BoundarySchemaTypeV1`, `BoundarySchemaV1`, `BoundaryStringFormatV1`, `BoundaryStringSchemaV1`, `DecodeBoundarySchemaV1Options`, `DecodeBoundarySchemaV1Result`, `DecodeBoundedJsonV1Options`, `DecodeBoundedJsonV1Result`, `NormalizeBoundedJsonV1Options`, `NormalizeBoundedJsonV1Result`, `ValidateBoundaryValueV1Options`, `ValidateBoundaryValueV1Result`.

</details>
