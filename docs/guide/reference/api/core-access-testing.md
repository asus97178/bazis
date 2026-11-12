# `bazis/core/access/testing`

Тесты прав. Список — по пакету 0.140.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `StaticAccessPolicy` | Система прав из таблицы «человек → право → гранты»; человек — `subject` принципала | [Тесты](../../security/access.md#тесты) |
| `StaticAccessOptions` | Опции: `grants`, `otherwise` (что даёт право, которого нет в таблице; `"all"` — всё), `anonymous` (кто запрос без входа), `owners`, `principals` | там же |
| `allowAll(options?)` | Замена для `overrides`: система прав, где у всех есть все права. `anonymous`, `grants` — как выше. С версии 0.138.0 | [Права в тестах](../../fundamentals/testing.md#права-в-тестах) |
