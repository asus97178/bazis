# `bazis/library/validation`

Проверка данных: правила на полях классов, тексты ошибок. Работает в
привязке HTTP, gRPC, инструментах агентов и сама по себе. Список — по
пакету 0.125.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Validator(options)` | Декоратор правил поля: `required`, длины, `range`, `pattern`, `email`, `uuid`, `enumType`, `custom`… | [Правила](../../overview/validation.md#правила) |
| `Validator.validate(instance)`, `Validator.validateAsync(instance)` | Проверить объект вне привязки — в сервисе, скрипте | [Проверка данных](../../overview/validation.md) |
| `Validator.setDefaultMessages`, `Validator.resetDefaultMessages` | Свои шаблоны текстов для всего процесса | [Свои тексты](../../overview/validation.md#свои-тексты-и-русский-язык) |
| `Validator.ruleSet(fields)` | Правила данными, без класса: возвращает `RuleSet` с `validate`, `validateAsync`, `fields` | [Правила как данные](../../overview/validation.md#правила-как-данные-validatorruleset) |
| `ValidationResult`, `ValidationError` | Результат: все ошибки сразу; ошибка поля: `property`, `value`, `message`, `code`, `params` | — |
| `ValidationCodes` | Коды правил: `required`, `minLength`, `type`… | — |
| `MessageRegistry`, `EN_VALIDATION_MESSAGES`, `RU_VALIDATION_MESSAGES` | Реестр шаблонов и каталоги текстов | [Русская локализация](../../recipes/russian.md) |
| `modelValidatorAdapter` | Мост библиотеки к HTTP-привязке; подключает `runApp` | — |

Типы: `RuleSet`, `FieldRules`, `ValidatorOptions`, `ValidationCode`, `ValidationTypeHint`,
`CustomValidator`, `CustomOutcome`, `MessageParams`.

Коды ошибок проверки — в главе [Проверка данных](../../overview/validation.md#правила).
