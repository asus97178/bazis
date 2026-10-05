# Infra

Версия паспорта: 1.8. Дата: 2026-10-02. Статус: контракты и прежняя локальная физическая приёмка описаны ниже; изменение композиции проверяется отдельно без внешних сервисов.
Тип: существующая атомарная техническая ответственность — подключения и их lifecycle.
Каркас существовал до обязательной генерации через CLI; новые модули не создаются.
Точки подключения: `Infra(manifest)` / `infraModule(manifest)` в [Infra.ts](Infra.ts).
Область паспорта: манифест, lifecycle, токены, исправления отказов и настройки коннекторов.

## Ответственность и компоненты

Манифест объявляет логические имена и коннекторы. Infra связывает их с существующими
DI и kernel, владеет созданными клиентами и health-регистрациями. ORM-схемы,
миграции, предметные модели, HTTP-контроллеры и AI-tools здесь не используются.

| Компонент | Ответственность / вход |
| --- | --- |
| `Infra.ts` | `Readonly<Record<string, InfraConnector>>`; формирует global module metadata |
| `InfraConnector.ts` | Тип клиента, DI token, config, create/connect/dispose/health |
| `InfraLifecycle.ts` | Одна инстанция коннектора; создание, отмена, ровно одно dispose |
| `connectorIdentity.ts` | Внутренняя связь исходного коннектора с lifecycle и проверка неизменности; без политики фаз/токенов |
| `connectors/*` | Адаптация проверенного доменного конфига к соответствующему клиенту |
| `test/*` | Контракты, ошибки, отмена и ограничение ресурсов |

## DI и владение

Клиент публикуется singleton под `connector.token`; сырой клиент `externallyOwned`.
Внутренний singleton `InfraLifecycle` принадлежит DI и также публикуется под
`HOSTED_SERVICE`. Его `dispose` закрывает клиента, включая раннее разрешение до start.
Фабрики используют явные аргументы name/connector и внутренние токены, создаваемые
для каждой записи манифеста; это данные композиции, а не ручное дублирование class deps.
Внешние TS-экспорты находятся в [index.ts](index.ts); DI-экспорты — client token и
объявленные `connector.exports`. HTTP/AI-входы самим Infra не публикуются.

## Входы и lifecycle

Клиент определяется обязательным `token: InjectionToken<TClient>`.
Поля `config`, `phase`, `providers`, `exports` необязательны.
`config` — один ModuleConfig либо readonly-массив, default отсутствует.
`phase` — конечное целое, default -100; меньшая фаза стартует раньше.
Имена манифеста непустые; одинаковый client token у разных владельцев отклоняется.
Один и тот же подключённый модуль обходится DI однократно.

По указанию владельца от 2026-10-02 `kind` удалён из `InfraConnector` и
`LlmProviderAdapter`, встроенных коннекторов и прикладного SMS-коннектора.
Это изменение публичного TypeScript-контракта без переходного alias или optional
поля. Чтобы подключить свой клиент, достаточно реализовать операции контракта
и передать коннектор в манифест; регистрировать название типа не требуется.
Ключи манифеста произвольны, например `payment-delivery`; они используются в
диагностике и именах health checks. Для готовности БД ORM сравнивает сам токен
DATABASE_PROVIDER; другой токен с таким же отображаемым именем его не заменяет.

LLM-адаптеру достаточно `create(options)`; `connect`, `dispose`, `healthCheck`
остаются необязательными. Выбор реализации выполняется передачей самого адаптера.
Новых реестров типов, полей классификации и модулей не введено.
Сценарии пользовательских коннекторов, отказы ORM, результаты и бинарные проверки:
[отчёт изменения контракта](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-design-2026-10-02/INFRA_CONNECTOR_CONTRACT.md).

| Операция / поле | Тип, default | Проверка / результат |
| --- | --- | --- |
| `create(configs?)` | Необязательный ConfigRegistry, результат TClient | Создаёт неподключённого клиента из представления kernel; не должен оставлять ресурсы при собственном исключении |
| `connect(client, signal?)` | Клиент; необязательный AbortSignal | Promise<void> или void; отмена прекращает ожидание и запускает cleanup |
| `dispose(client)` | Созданный клиент | Promise<void> или void; обязан прекращать также незавершённый connect и запрещать открытие после закрытия |
| `healthCheck(client, signal?)` | Клиент; необязательный AbortSignal | boolean/Promise<boolean>; отсутствие метода означает отсутствие check |
| `InfraLifecycle(name, connector, client?, configs?)` | Имя, коннектор, готовый клиент и реестр необязательны | Сохраняет прежний вызов с тремя аргументами; без клиента создание ленивое |
| `getClient()` | Без аргументов | Создаёт клиент один раз; после dispose бросает InfraError |
| `start(signal?)` | Необязательный AbortSignal | Запускает connect; исключение/отмена освобождают созданный клиент |
| `stop()` / `dispose()` | Без аргументов | Одна общая операция освобождения; повтор не вызывает connector.dispose повторно |

Null для входов не поддерживается. Ошибки в конфиге/манифесте дают InfraError;
ошибка connect сохраняется, ошибка cleanup добавляется через AggregateError.
Автоматических повторов подключения нет. Тайм-ауты host сохраняются в kernel.
Передача AbortSignal и вызов dispose не доказывают нативную отмену запроса драйвером.

## Проверки и компромиссы

Выполнены D02/D03 и связанные регрессии из [плана](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config/WORK_PLAN.md).
Простой stateful lifecycle оставляет одного владельца ресурса. Настройки и граф
проверяются на холодном пути; новые сетевые вызовы и retries не добавляются.
Бинарное исполнение проверено контролируемой фикстурой; итоги в [отчёте](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config/RESULT.md).

## Конфигурация каждого kernel

По [MOD-ARCH-001 §5.4](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation)
`create(configs?: ConfigRegistry)` получает реестр конфигураций своего контейнера;
встроенные коннекторы получают представление через `configs.get(config)`.
Необязательный аргумент сохраняет прямые
standalone-вызовы. Lifecycle сохраняет идентичность исходного коннектора и
получает реестр своего контейнера четвёртым аргументом конструктора.
Два kernel могут разделять манифест, объявления и адаптеры, но не разрешённые
значения конфигурации. Проверяются также отложенные фабрики профилей LLM.

Реализовано и проверено для двух kernel с общим манифестом:
[отчёт об изоляции](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).
Эта проверка не подменяет приёмку остальных работ аудита Infra.
При отдельной проверке изоляции физические сервисы не запускались.
Позднее выполнена [локальная эксплуатационная приёмка](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/RESULT.md)
с PostgreSQL/Valkey и измерениями. Допуск новых платформ не заявляется.
Отклонений от архитектурной спецификации нет.

## Параметры коннекторов

`postgres(config, { token?, shutdownTimeoutMs? })`, `redisConnect(config, { token?, cache? })` и
`openSearchConnect(config, { token?, timeoutMs?, maxResponseBytes? })` сохраняют
свои default-токены. Явный InjectionToken нужен для второго экземпляра того же
клиента; тип токена соответствует клиенту. Поле null не поддерживается.
Распределённый Redis cache остаётся одним общим backend на приложение.
Второй backend, включая подключение в другом модуле, отклоняет Cache при сборке
модульного контейнера до создания клиентов. Параметр `cache.connection` задаёт
имя внутри единственного backend и не включает объединение backend.
Несколько raw Redis-клиентов с разными токенами разрешены.
По указанию владельца от 2026-10-02 у RedisDistributedCacheBackend удалены
совместимые no-op `start/stop`; он реализует только DistributedCacheStores.
Прежний объединённый тип и подключение backend через Cache options удалены.
Redis-коннектор остаётся владельцем соединения и health; его options сохранены.
`ormOsnvConnect` сохраняет общий DATABASE_PROVIDER и свою ORM-политику.

С 2026-10-02 `InfraLifecycle` не импортирует ORM и не распознаёт DATABASE_PROVIDER,
фазы −110/−105 или schema admission. Infra хранит внутреннюю WeakMap-связь
«коннектор → lifecycle». Фабрики LLM и checkpoint protection отмечают исходные
объекты; Infra фиксирует их поля при создании и сверяет при чтении identity.
Копирование полей/символов или наследование не переносит identity. Внутренние
функции не экспортируются публичным фасадом. ORM самостоятельно интерпретирует
эти сведения в своём валидаторе, включая допустимые роли и фазы.
Готовность общего DB-слота проверяет ORM по идентичности токена DATABASE_PROVIDER
и фазе lifecycle −110. Пользовательская реализация того же контракта допустима
без строкового признака типа. Прежний внутренний ORM-marker из InfraLifecycle удалён.
Операции InfraConnector/InfraLifecycle, владение ресурсами и фазы сохраняются.
Проверки strict ORM по-прежнему требуют фазу 0 или позже для обычных прикладных
служб; удаление `kind` не разрешает запуск приложения до допуска схемы.

PostgresConfigShape дополнен необязательными `max`, `connectionTimeout`,
`idleTimeout`, `maxLifetime` и `tls`. Первые четыре поля передаются в Bun SQL;
тайм-ауты в секундах. max/connectionTimeout — положительные целые, idleTimeout/
maxLifetime допускают 0; верхняя техническая граница 2147483647. port — 1…65535.
Отсутствующие поля оставляют defaults драйвера. tls — disable, allow, prefer,
require, verify-ca или verify-full. Прикладные defaults и более узкие пределы
описаны в [db.config.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/config/db.config.ts).
Общий builder `postgresConnectionOptions` используется сырой SQL-фабрикой
и существующим ORM-мостом; дополнения ORM к timeouts/CA сохраняются.

У сырого `postgres(config, options)` есть `shutdownTimeoutMs?: number`:
default 1000 мс, целое 0…2147483647, null не допускается; 0 означает немедленное
закрытие. Это предельное ожидание незавершённых запросов в `SQL.close`, после
которого драйвер закрывает соединения. Оно должно укладываться в общий бюджет
остановки kernel; несколько sequential disposers делят этот бюджет. Потребители
сначала прекращают приём работы и завершают свои операции. После исчерпания
предела незавершённые операции могут получить ошибку соединения.
Ранее `close()` без предела зависал при потерянном ответе и отключённом idle timeout.
Настройка относится к raw PostgreSQL connector; ORM-политика закрытия не меняется.
Она не доказывает отмену выполняющегося SQL на сервере.

LLM router создаёт адаптеры при первом connect/complete/health, когда сам router
уже имеет владельца. Это позволяет дождаться asynchronous rollback, если
создание следующего адаптера падает. Сам `connector.create()` остаётся синхронным.
Повторный запуск после dispose не поддерживается. Нативную остановку драйверов
и достижимость endpoints подтверждает только отдельная физическая проверка.

## HTTP-клиенты после остановки

Сигнал Codex `run(input)` действует на всю подготовку, включая внутренние
проверки аккаунта и получение каталога моделей. Отмена завершает ожидание run и
освобождает `activeRuns`, не отправляя следующий подготовительный RPC. Если
соединение уже открывает другой caller, отменяется только ожидание run;
владелец открытия продолжает свою операцию. Отмена отправленного RPC сохраняет
существующее закрытие общего процесса. Публичный `models()` остаётся без
аргументов. Регрессии: [codex.preparation.test.ts](test/codex.preparation.test.ts).

`OpenSearchClient.dispose()` и `OpenAiCompatibleModelProvider.dispose()` —
идемпотентные операции без входных полей. Отменяют текущие fetch-запросы,
включая чтение response body, и запрещают дальнейшую отправку через этот объект.
Их вызывают существующие connector/adapter `dispose`. Новый kernel создаёт
новых клиентов. `OpenAiCompatibleModelProvider.ping(signal?)` получает
необязательный AbortSignal и передаёт его до транспорта и чтения тела.
Отмена health возвращает false, остальные запросы отклоняются.
Пользовательский fetch обязан соблюдать signal; принудительная остановка
произвольной реализации не обещается. Контролируемые сетевые сценарии и границы:
[эксплуатационная приёмка](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/PLAN.md).

## Структурированный вывод LLM

`OpenAiCompatibleModelProvider.complete` передаёт `output.mode: "json"` с
`schema.kind: "json-schema"` как `response_format.type: "json_schema"` и поля
`json_schema.name`, `schema`, `strict`, необязательное `description`. Имя
нормализуется до разрешённых ASCII-символов и 64 символов. Без schema остаётся
`json_object`. Неразрешённый class-контракт отклоняется до fetch; Driver сначала
пытается разрешить его по generated metadata.

Локальная валидация Runtime действует независимо от `strict`. Схема передаётся
без автоматической замены обязательных полей или nullable-семантики. Конкретный
провайдер должен поддерживать Structured Outputs и переданный subset; отказ
провайдера возвращается ошибкой, скрытого перехода на JSON mode нет. В частности,
официальный OpenAI strict-режим требует object root, required для всех полей и
`additionalProperties: false`; схемы приложения должны соответствовать этим
ограничениям. [Протокол OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs).
Wire format проверен локальным fetch; реальные model endpoints не вызывались.
[Проверки исправлений](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).

## Поток текста модели

Для text output, в том числе с Tools, при наличии `context.onTextDelta` адаптер отправляет
`stream:true`, `stream_options.include_usage:true` и читает SSE. Callback получает
новые фрагменты `choices[0].delta.content`; complete возвращает собранный ответ
и usage. Структурированный JSON output сохраняет обработку полного ответа. Если совместимый
endpoint возвращает JSON вместо SSE, complete продолжает работать без частичных событий.
Дополнительных соединений, библиотек или модулей не создаётся.

Предел всей передачи — существующий `maxResponseBytes` (default 16 MiB); один
SSE frame ограничен min(maxResponseBytes, 1 MiB) символов. UTF-8 и CR/LF могут
пересекать сетевые chunks. Успех требует finish_reason и `[DONE]`; EOF, ошибка
провайдера или неразрешённый Tool delta дают ошибку, сохраняя таймер и signal
на всём чтении. Reader отменяется при выходе, включая отказ callback. Тела ошибок
не включаются в исключения. stop/length/content_filter передаются Runtime для
его обычной проверки исхода.

Router разрешает fallback только до первого непустого видимого текста. После
частичного ответа ошибка завершает вызов: второй профиль не дописывает новый ответ
к первому. Поздние callbacks завершённой попытки игнорируются. Этот поток не
является журналом для replay. Фрагменты `delta.tool_calls` собираются до finish_reason
и `[DONE]`: максимум 16 индексов, уникальные ID, последовательные индексы,
ограниченные имя и аргументы. Частичный или противоречивый вызов не передаётся executor.
Модельные аргументы дополнительно проверяются обычным Tool executor перед выполнением.
Совместимость Ollama: [официальный протокол](https://docs.ollama.com/api/openai-compatibility).
Проверки потока: [source, binary и браузер](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/client-chat-streaming-2026-09-20.md).

## Codex App Server

[codexAppServerConnect(config)](connectors/codex.ts) — дополнительный коннектор
существующей Infra, без отдельного модуля и параллельного lifecycle. Возвращает
InfraConnector<CodexClient>, token CODEX_APP_SERVER, phase=0. Клиент создаётся
без эффектов из ConfigRegistry своего kernel. connect запускает stdio-процесс,
initialize/initialized и проверку эффективной политики; dispose закрывает процесс
и завершает все ожидания. health проверяет доступность процесса, отдельно от входа
в аккаунт. При enabled=false процесс и каталоги не создаются, health=true.

Компоненты [connectors/codex](connectors/codex): CodexAppServerClient владеет
подключением/авторизацией и ограничением параллелизма; CodexAppServer — bounded
JSON-RPC; CodexTurn — одним ходом и отменой; CodexPolicy — изоляцией процесса;
contracts.ts — TypeScript API. HTTP/ORM/UI остаются в приложении. DI публикует
только узкий CodexClient; произвольный RPC и процесс наружу не выдаются.
Codex — полный внешний исполнитель, не реализация raw AgentModelProvider.

| Config / вход | Правило |
|---|---|
| enabled:boolean | Обязателен; default приложения false |
| binary:string | Доверенный путь/имя CLI; непустой, до 4096, без NUL; default приложения codex |
| stateDirectory:string | Выделенный постоянный каталог; та же проверка; default ./var/codex |
| status() | configured, connected, account(email/planType) или null, login или null, loginError, activeRuns |
| login(method) | browser/device, null запрещён; managed ChatGPT login, до 10 минут |
| cancelLogin() / logout() | Отмена входа / удаление авторизации через официальный RPC; ошибка BUSY при активных ходах |
| models() | До 100 моделей, id/name/isDefault, supportedReasoningEfforts, defaultReasoningEffort; кэш 30 секунд, очищается при изменении аккаунта |
| run(input) | model?: string 1–121, ASCII буквы/цифры/._-; отсутствие выбирает default каталога, явное имя без замены |
| reasoningEffort | optional string 1–32, `[a-z][a-z0-9_-]*`, null/пустая строка запрещены; отсутствие выбирает default выбранной модели; пример high |
| instructions | string, до 32000, может быть пустой; null запрещён |
| messages | До 41 сообщения user/assistant, text до 32000; последнее user 1–8000; история целыми парами сокращается до 48000 символов вместе с инструкциями и JSON |
| signal / onTextDelta | Обязательный AbortSignal / sync callback новых фрагментов; результат Promise<string> |
| tools | Необязательный массив до 32 {name, description, inputSchema}; имена уникальны, `[A-Za-z_][A-Za-z0-9_-]{0,63}`, описание до 4000, весь список до 128000 символов JSON |
| onToolCall | При tools обязателен async callback ({id, name, arguments}, signal) → {success:boolean, text:string}; без произвольного RPC |

CodexModel.supportedReasoningEfforts содержит до 32 пар `{reasoningEffort:string,
description:string до 1024}`; уровни берутся из model/list, общий фиксированный
enum для всех моделей не предполагается. defaultReasoningEffort:string|null
принадлежит списку, null допустим для пустого списка. Неверный каталог — PROTOCOL_ERROR.
Модель и effort проверяются до создания thread; неподдерживаемый effort даёт
REASONING_UNAVAILABLE без генерации. Выбранный уровень передаётся в turn/start.effort.

Не более 8 одновременных ходов, 120 секунд на ход, 32000 символов ответа.
Ограничение maxOutputTokens локального LLM сюда не переносится. У каждого хода
новый ephemeral thread. История передаётся явно размеченным JSON-контекстом:
это позволяет приложению оставаться единственным владельцем истории, исключает
скрытое продолжение отменённых ходов и дополнительную таблицу согласования двух
историй. Native resume, журнал токенов и межпроцессное управление общим аккаунтом
не заявляются; выделенный stateDirectory принадлежит одной инстанции приложения.

Отмена: turn/interrupt, затем подтверждение turn/completed; один RPC ACK не
считается остановкой. Нет terminal за 3 секунды после ACK — процесс останавливается,
его другие ходы получают ошибку. RPC timeout/отмена до получения turn id также
закрывает процесс, исключая потерянный запуск. Нет автоматических повторов
turn/start или перехода на API key/другую модель. После смерти процесса новый
самостоятельный запрос может открыть новый процесс; старая операция не повторяется.
Ephemeral thread освобождается через thread/unsubscribe после каждого хода.

Протокол: 1 MiB на кадр, 2 MiB на очередь записи, 64 pending RPC, 32 подписки;
RPC 15 секунд, login/start 30, interrupt/unsubscribe 3. Ранние события до ответа
turn/start ограничены 128 событиями / 128000 символами. Stderr дренируется без
сохранения; тела provider errors, credentials, инструкции и prompts не логируются.
CodexError публикует фиксированный code/message без исходного тела ошибки.

CLI — внешняя зависимость, в bun binary не встраивается. Проверен установленный
codex-cli 0.154.0-alpha.6.2; --strict-config отклоняет несовместимые параметры.
При старте дополнительно проверяется эффективная политика. Отдельные home,
workspace и пользовательский home процесса имеют 0700; auth store=file.
Личные ~/.codex и ~/.agents, ключи OpenAI/БД и прочий env приложения не наследуются.
Стандартный каталог исключён из git. CLI управляет refresh/сохранением аккаунта;
приложение не читает и не копирует auth.json.

Shell, browser/computer, apps/plugins/MCP, hooks, память, host skill discovery,
subagents и web search отключены, sandbox=read-only, approval=never. При явной
передаче tools допускаются только osnv dynamicTools. Остальные запросы к клиенту
отклоняются; неожиданные tool items прекращают ход. Это не разрешение native tools Codex.

`skip_host_skill_discovery` не отключает встроенные system skills. При открытии
соединения CodexPolicy читает `skills/list` с единственным cwd изолированного
workspace и `forceReload:true`, затем отключает все включённые навыки через
`skills/config/write({path, enabled:false})`. Настройки записывает Codex в свой
изолированный CODEX_HOME; личная конфигурация пользователя не изменяется.
Допускаются до 128 записей с уникальными абсолютными path до 4096 символов
без NUL и boolean enabled; ровно одна группа указанного cwd, без ошибок discovery.
Общее время отключения — до 15 секунд, отдельный RPC — до 5 секунд.
После записи обязательно проверяются `effectiveEnabled:false` и повторный каталог.
Перед каждым `thread/start` каталог проверяется заново, включая новые и повторно
включённые навыки. Некорректный ответ, ошибка чтения или включённый навык запрещают
новый ход до отправки текста модели. Автоматического повторения генерации нет.
Текущий контракт не назначает skills агентам: разрешены только переданные tools.
Developer instructions явно задают отсутствие skills; упоминания возможностей
в старой истории не считаются их текущим назначением. Текст старых сообщений
не переписывается. Это дополнительная инструкция, а не замена проверки каталога.

DynamicTools — экспериментальный протокол App Server. `thread/start` получает
function specs со сгенерированными схемами; `item/tool/call` маршрутизируется по
threadId и turnId. Допустимы только назначенное имя, namespace=null и новый callId;
до 16 вызовов на ход, последовательно. Повторные, чужие и неизвестные вызовы
отклоняются до callback. Входящие RPC ограничены 32 запросами на процесс.
Сообщение об успешном завершении при незавершённом tool request даёт ошибку
протокола, включая запрос, callback которого ещё не начал выполняться.
Callback отменяется по lifetime signal; ожидание ограничено даже для обработчика,
который игнорирует сигнал. Фактическую отмену его эффекта обязан обеспечивать
прикладной executor: завершение ожидания само по себе её не доказывает.
Результат возвращается как inputText с success. Infra не знает предметные сервисы:
Agents передаёт callback в штатный AgentToolExecutor, где действуют DTO, допуск,
scope, timeout и hooks. Добавление операций записи требует отдельной политики допуска.

Проверки: [codex.test.ts](test/codex.test.ts), физический прогон — [отчёт](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/codex-chatgpt-2026-09-20.md) (скрипты пробы удалены в 0.96.1, остались в истории git).
Изоляция навыков: проверка настоящего CLI без аккаунта
— [результаты от 2026-09-21](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/codex-skills-2026-09-21.md).
PASS: реальный CLI handshake/policy/account-read без входа; mock subprocess
streaming, отмена/смерть/ошибки/изоляция; собранный binary + отдельная PostgreSQL БД
и реальные WebSocket. Реальная генерация ChatGPT требует входа владельца и до
его завершения не считается проверенной. Источники протокола:
[OpenAI App Server](https://learn.chatgpt.com/docs/app-server),
[конфигурация](https://learn.chatgpt.com/docs/config-file/config-reference).
