# Agent Runtime — частичный паспорт

Версия: 9. Дата сверки: 2026-10-04. Статус: реализовано в описанной области;
проверки и ограничения — в [отчёте исправлений](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).
Тип: существующая атомарная функция ядра. Путь: `src/osnova/core/agent`.
Отдельного `*.module.ts` у этой подсистемы нет: подключение выполняется импортом
публичного Agent API и вкладами модулей приложения. Новый DI-модуль не создавался.
Каркас существовал до обязательной генерации через CLI; команда создания неизвестна.

Область паспорта: `AgentRuntime.invoke/invokeTask`, итог Tool при timeout/abort,
привязка DTO, JSON-вывод, сокращение контекста и наблюдение за текстом модели.
Session persistence и долговечное воспроизведение потока,
весь контракт registry и все hooks этим частичным паспортом не квалифицируются.
Дополнение этой версии — регистрация `@Module.tools` и каталог одного контейнера.

**Принятое направление:** [AGENT-ARCH-001](../../../../docs/architecture/AGENT_ARCHITECTURE.md)
отделяет агентов от модулей: агенту назначаются Tools, реализации которых
используют существующие сервисы и DI. В этой версии паспорта зафиксировано решение;
AgentRegistry.fromDefinition уже принимает определение как данные. Старый путь
через классы остаётся совместимым; полная миграция CLI/codegen и длительные
framework-сессии остаются отдельной работой.

## 1. Ответственность и структура

Подсистема исполняет цикл Agent → model → Tool и владеет его результатом,
контекстом и границей ошибок. Tool владеет своим предметным эффектом. Infra
владеет транспортом модели; приложение — approval policy, аудитом и хранилищами.
Это одна техническая функция; отдельные подмодули по слоям не создаются.

`AgentExecutionDriver` управляет фазами; `AgentToolExecutor` отвечает за исполнение
и scopes. Он сохраняет владение попыткой, timeout/settlement и переводом ошибок после
эффекта в outcome unknown; внутренние компоненты не принимают эти решения.
Публичные типы validator/audit по-прежнему доступны из AgentToolExecutor и index.
Чистые внутренние функции связывают DTO и проверяют поддерживаемую схему.
Используются существующие DI, HTTP model binder и форматы Boundary Schema.
ORM, новый контейнер, сторонний JSON Schema engine и новые зависимости не добавлены.

### Определение как данные

`AgentRegistry.fromDefinition(input: AgentDataDefinition, allowedTools?: readonly ToolDefinition[]): AgentRegistry`
создаёт независимый неизменяемый снимок для штатного AgentRuntime. Автору агента
не нужен Class/@Module. Внутренний DataAgentTarget сохраняет прежний публичный тип
AgentDefinition.target; он не создаётся DI и не исполняется.

| Поле | Тип / default | Ограничения |
| --- | --- | --- |
| name | обязательная string | латиница/цифры, точка/дефис/подчёркивание, 1–128 |
| instructions | обязательная string | 0–100000; пустая строка означает отсутствие инструкций |
| description | optional string | до 4000 |
| modelProfile | optional string | непустой идентификатор 1–128; модель выбирает infra |
| toolNames | optional string[], default [] | до 128, уникальные имена из allowedTools |
| allowedTools | второй аргумент, default [] | реальные ToolDefinition с уникальными именами |

null не принимается. Неизвестный/дублированный tool даёт AgentSetupError до вызова
модели. Host явно разрешает capabilities: имя не предоставляет доступ к глобальному
каталогу. Штатные owner-bound регистрации и hooks остаются обязательны для Tools.
Снимок фиксируется на один ход; изменение агента влияет на следующий.
Проверки: [agent.data-definition.test.ts](test/agent.data-definition.test.ts).

## 2. Компоненты

| Компонент | Файл | Назначение |
|---|---|---|
| Публичный фасад | [AgentRuntime.ts](AgentRuntime.ts) | Вызов Agent / Task |
| Исполнитель | [internal/AgentExecutionDriver.ts](internal/AgentExecutionDriver.ts) | Фазы, контракты и терминальный результат |
| Tool executor | [AgentToolExecutor.ts](AgentToolExecutor.ts) | Политики, вызов, timeout/abort, settlement и освобождение scope |
| DTO binding | [internal/AgentModelBinding.ts](internal/AgentModelBinding.ts) | Строгая привязка через существующий `bindModel`, проекция DTO в JSON |
| Контракты Tool | [internal/ToolContract.validator.ts](internal/ToolContract.validator.ts) | Привязка DTO, вызов переданного schema validator и диагностические code/message/details; не определяет исход эффекта |
| Проекция аудита | [internal/ToolAudit.projector.ts](internal/ToolAudit.projector.ts) | Снимок вызова/результата, маскирование и заморозка; не вызывает sink и не выбирает retry |
| JSON Schema | [internal/AgentJsonSchema.ts](internal/AgentJsonSchema.ts) | Проверка ограниченного набора правил; неизвестное правило — отказ |
| Контекст | [AgentContextBuilder.ts](AgentContextBuilder.ts) | Защита актуальных сообщений и применение трёх бюджетов |

## 3. Подключение и DI

TypeScript-вход — [index.ts](index.ts); новые внутренние функции через него не
экспортируются. В текущем API `@Module` приложения объявляет `agents`, `tools`, `prompts`,
`agentToolHooks` и обычные providers. Реализации Tools разрешаются в scope через
существующий DI; зависимости классов остаются в конструкторах. Списки `imports`
и `exports` принадлежат подключающему модулю. Фасад не вводит отдельные DI exports.
Порт модели — `AgentModelProvider`; выбор модели и транспорт — Infra.

`AgentRegistry` также принимает готовый `AgentCatalog`, а
`fromModules/fromGeneratedModules` — дополнительные объявления `extras`.
Это существующий задел для самостоятельной регистрации. Нынешние определения
всё ещё содержат ссылки на классы. Целевой переход не должен создавать второй
executor либо менять проверку DTO, исходов действий и hooks в зависимости от источника агента.

## 4. Данные, конфигурация и lifecycle

### Регистрация Tools и каталог контейнера

`@Module({ tools: [SomeTool] })` создаёт обычный scoped provider класса через
существующее расширение вкладов DI. Если тот же владелец уже объявил точный
`scoped(SomeTool)`, он используется без второй регистрации. Singleton, transient,
factory, keyed-only и дублированная регистрация отклоняются. Повторное объявление
имени или класса в tools, включая другого владельца, даёт AgentSetupError при
сборке. Конфликт с посторонним обычным provider даёт ModuleOwnedProviderConflictError.
Ни конструктор Tool, ни execute для проверки не вызываются.

`AgentRegistry.fromContainer(services: ServiceProvider): AgentRegistry` принимает
только framework DiContainer; обычный ServiceProvider отклоняется с AgentSetupError.
Возвращает неизменяемый каталог native Tools из фактических owner-bound вкладов,
без агентов и prompts. Повторный вызов для одного контейнера возвращает тот же
реестр; WeakMap не удерживает завершённый контейнер. Разные контейнеры изолированы.
Нет сканирования файлов, импорта AppModule или неявного включения обычных providers.

`fromDefinition` выбирает назначенные имена из `catalog.listTools()` и создаёт
отдельный снимок запуска. Реестр не отменяет проверку прав, approval и входов
в AgentToolExecutor. В приложении ToolsInitializer проверяет объявленные
generated input/output schemas перед HTTP; выходная схема остаётся необязательной.

Проверки: [agent.module-contributions.test.ts](test/agent.module-contributions.test.ts),
[каталог и HTTP](../../../app/modules/agents/tools/test/Tools.http.test.ts),
[запуск](../../../app/modules/agents/test/Run.service.test.ts).

В описанной области нет собственной БД, миграций, HTTP routes, UI или background
jobs. Переданные metadata/DTO не становятся конфигурацией процесса. Глобальный
HTTP validator не выбирается неявно: Agent использует свой переданный валидатор.

Начавшийся `write` / `external`, прерванный до завершения `execute`, получает
`TOOL_TIMEOUT_OUTCOME_UNKNOWN` либо `TOOL_ABORTED_OUTCOME_UNKNOWN`. Этот код
сохраняется при подключённых hooks; settlement получает `outcomeKnown: false`.
Runtime завершает вызов с `AGENT_TOOL_OUTCOME_UNKNOWN`, не отправляя следующий
запрос модели. Scope освобождается после фактического завершения Tool; поздний
эффект возможен, сам AbortSignal не является подтверждением его отмены.

Ошибки timeout/отмены на пути исполнения сохраняют `error.details.phase`
независимо от того, первым сработал общий таймер или предел конкретной стадии.
До исполнения Tool в проверке входа, approval, attempt-аудите и разрешении
зависимостей фаза — `pre-execute`; в общем обработчике исполнения и отмене
ожидания retry берётся текущая фаза состояния. Коды, сообщения, deadlines и
сигнатуры не изменены. Дополнительное поле `sideEffect` этим правилом не обещается.
Регрессии с управляемыми часами находятся в
[agent.tool-executor.test.ts](test/agent.tool-executor.test.ts).

Завершённые операции сохраняют независимый ограниченный settlement и best-effort
observer. Отмена до запуска Tool не означает неизвестный эффект. Повторы после
`OUTCOME_UNKNOWN` запрещены. `idempotencyKey` передаётся инструменту и участвует
в retry policy; автоматического постоянного dedup-хранилища здесь нет.

## 5. Точки входа и поля изменяемой области

Существующие вызовы совместимы; в options добавлен необязательный onTextDelta.
Полные options — в исходниках фасада и executor;
таблица описывает поля, затронутые исправлениями.

| Вход | Тип / обязательность | Default и ограничения |
|---|---|---|
| `invoke(agentName, options)` / `invokeTask(agentName, taskName, input, options)` | Существующие методы | Agent/Task должны быть зарегистрированы |
| `input` | JSON либо экземпляр объявленного DTO | Для классов — конструктор без аргументов, whitelist и валидация |
| `output.mode` | `text`, `json`, `artifact`; внутри переданного output обязателен | Локальная структурная проверка относится к `json` |
| `output.schema` | Необязательная JSON Schema либо имя класса | Без schema проверяется JSON; класс разрешается по generated metadata |
| `schema.strict` | boolean; по умолчанию true | Передаётся адаптеру; false не отменяет локальную проверку схемы |
| `output.description` | Необязательная строка | Передаётся в provider `json_schema.description` |
| `toolExecution.timeoutMs` | Необязательное неотрицательное целое, мс | Override → Tool metadata → default 30000; 0 отключает таймер |
| `signal` | Необязательный AbortSignal | Отмена с сохранением знания об исходе эффекта |
| `onTextDelta` | optional synchronous `(event: {step:number, text:string}) => void` | Частичный текст одного шага модели; отсутствие сохраняет complete-only путь |
| `contextLimits.maxMessages/maxChars/maxTokens` | Необязательные положительные целые | Применяются в указанном порядке; защищённый минимум нельзя удалить |

Объявленные Agent/Task output-классы имеют приоритет над caller output; Agent
output проверяется до Task output. При отсутствии этих деклараций явный JSON
контракт проверяется и в `invoke`, и в `invokeTask`. Успех содержит разобранный
`result.output`; некорректный ответ — `failed / AGENT_OUTPUT_INVALID`. Для
неразрешённого явного класса — `AGENT_OUTPUT_SCHEMA_UNAVAILABLE`; LLM-адаптер
также отклоняет неразрешённый класс до fetch.

DTO: generated nested-model shapes восстанавливают экземпляры вложенных классов
и массивы. Инициализированные вложенные поля поддерживаются без shapes. Лишние
и запрещённые поля отклоняются. Классы рекурсивно проецируются в plain JSON без
вызова `toJSON`; unset optional-поля классов пропускаются, undefined в plain JSON
и массивах отклоняется. Циклы, глубина свыше 64 и более 100000 узлов проекции
отклоняются. Custom decorators, не выраженные generated schema, требуют
подключённого `taskSchemaValidator` / `schemaValidator`.

Публичный `describeTool(ToolDefinition): AgentToolContract` возвращает ту же
проекцию контракта, которую использует runtime: имя, описание, свойства эффекта
и generated input/output schemas. Раскрытие generated refs общее с драйвером.
Если схема класса недоступна, остаётся class contract; хост обязан отклонить его
до публикации во внешнем протоколе. Проекция не вызывает инструмент и не заменяет
проверку аргументов, прав или schemaValidator в AgentToolExecutor.

### Идентичность схем DTO и самостоятельный пакет (R4/K1, 2026-10-04)

Входы и выходы Tool, Agent и Task разрешают generated-схему по точному
конструктору через существующий OpenAPI registry. Та же связь применяется к
списку допустимых полей вложенных DTO. Независимый одноимённый интерфейс не
меняет контракт класса. Имена схем определяет общий OpenAPI analyzer;
Agent collector передаёт генератору реальные объявления классов. Codegen
сохраняет корневые и вложенные схемы и публикует constructor → schema связи
в существующем `GENERATED_OPENAPI_SCHEMA_MODELS`. Новый реестр не создаётся.

Для прежних вручную зарегистрированных metadata без такой связи сохраняется
поиск по имени класса. Если точная связь есть, но её схема отсутствует, чужая
схема с коротким именем не используется. Как прежде, отсутствующая схема
попадает в class contract, а host обязан отклонить его до внешней публикации.
Связанные class DTO должны быть named exported top-level классами; иначе
codegen возвращает `OSNV_AGENT_SCHEMA_MODEL_UNIMPORTABLE` до записи результатов.
Прежнее отклонение двух одноимённых class-деклараций самим Agent collector
сохраняется; это изменение не обещает поддержку ранее запрещённой композиции.

AgentRuntime использует относительный импорт Boundary Schema внутри пакета.
Проверки [agent.schema-identity.test.ts](test/agent.schema-identity.test.ts) и
[agent.standalone.integration.test.ts](test/agent.standalone.integration.test.ts)
покрывают точный выбор, отсутствие fallback к чужой схеме, Agent/Task input/output,
Tool и вложенные DTO. Интеграционная проверка создаёт независимую копию пакета,
проверяет Agent API без `tsconfig.paths`, затем настоящий codegen с локальными
путями только в скопированный пакет; исполняет исходники и два бинарника вне
checkout. Это не квалификация npm-публикации, LLM, session persistence или
полного запуска приложения с внешней инфраструктурой.

JSON Schema subset: типы и их объединения, nullable, properties/required,
additionalProperties (boolean/schema), items, размеры строк/массивов/объектов,
числовые границы, enum/const, anyOf/oneOf/allOf, uniqueItems, pattern и форматы
email/uri/uuid/date/time/date-time/decimal/int64-string. Поддерживается
`contentMediaType: application/json`. Annotation-поля перечислены в валидаторе.
Неизвестные keywords/formats, некорректные правила и превышение лимитов обхода
дают отказ, включая правила необязательных полей. Это не полный JSON Schema
draft: внешние `$ref`, `not`, `if/then/else`, `multipleOf` и т. п. не поддерживаются.
Generated ссылки раскрывает существующий resolver; пользовательские схемы
передаются провайдеру без ослабления ограничений.

`AgentModelProviderContext.onTextDelta?: (text:string) => void` — необязательный
порт наблюдения. Провайдер может его не поддерживать; complete всё равно возвращает
единственный канонический AgentModelResponse. Runtime добавляет номер шага (с 1)
и перестаёт принимать текст после settlement, abort или timeout. Callback синхронный,
не должен блокировать или возвращать фоновые задачи; его исключение прерывает
соблюдающий контракт provider и даёт failed. Текст предварительный: не прошёл
финальную валидацию, не означает разрешение Tool или успешное исполнение.
Callback не включается в checkpoint и не воспроизводится после resume.
Конкретный Infra-адаптер сейчас передаёт только текстовые ответы без Tools.
Проверки потока и совместимости: [отчёт](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/client-chat-streaming-2026-09-20.md).

## 6. Проверки и граница готовности

Сценарии и воспроизводимые команды: [отчёт](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).
Тесты проверяют ошибки, поздние эффекты, scopes, DTO, wire format и приоритеты
контрактов. Source/binary-пробы выполняют только синтетические операции.

Обрезка со штатными целочисленными оценками использует накопленные суммы и
однонаправленный курсор, O(n) времени и O(n) памяти. Для совместимости с дробными
и слишком большими пользовательскими token estimates сохраняется прежний
пересчёт суммы слева направо; этот редкий fallback может быть O(n²). Он предотвращает
лишнее удаление и ошибки из-за округления/Infinity. Доступные лимиты не менялись.
Старое и новое поведение отдельно сравнены на 500 историях; измерения — в отчёте.

Приложение/CLI собираются в Bun binary; контрольные Agent-пробы запускаются вне
checkout. Полный запуск приложения с PostgreSQL и проверка реального LLM в область
этих исправлений не входят. Codegen-артефакты не редактировались.
Эти результаты относятся к исправлениям аудита. Отделение агентов от модулей
пока принято как архитектурное решение и отдельными проверками реализации не подтверждено.
