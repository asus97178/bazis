# Обновление между версиями

Что поменять в коде при переходе на новую версию. Здесь — только
ломающие изменения, от новых к старым; исправления и новое — в
[CHANGELOG](https://github.com/asus97178/bazis/blob/main/CHANGELOG.md).

Переходите через несколько версий — пройдите по всем разделам между
вашей версией и новой.

## 0.132.0

- **Документ процесса — `bazis.workflow/v2`, сохранить можно только его.**
  Опубликованные версии и черновики переносятся сами (ниже). Документ в коде
  замените или оберните: `document: upgradeDocument(старый)`.
  | Было | Стало |
  | --- | --- |
  | `input: { fields: [{ code, type, … }] }` | `variables: [{ name, type, direction: "in", … }]` |
  | Поле формы `{ code: "ok", … }` | `{ name: "ok", … }` |
  | `{ path, op, value }` | `{ op, args: [{ path }, value] }` |
  | `{ all: […] }`, `{ any: […] }`, `{ not: c }` | `{ op: "and", args: […] }`, `{ op: "or", … }`, `{ op: "not", args: [c] }` |

  Заодно документ стал строже: `$input.x` без такой переменной `in`, `$vars.x`
  без объявления или `saveTo` — ошибка, а `name` и `saveTo` — по
  `^[a-z][A-Za-z0-9_]{0,39}$`. Опубликованное продолжает работать, а вот черновик
  с такой ошибкой не опубликуется.
- **Новые хранилища.** Таблицы теперь `bazis_wf2_def_*`, `bazis_wf2_run_*`,
  `bazis_wf2_task_*`. При первом старте каталог переносится сам: процессы, версии
  с их датами, черновики; название уходит в язык `workflow.language`.
  **Экземпляры и задачи не переносятся** — завершите живые на старом выпуске.
  Старые таблицы фреймворк не трогает. Проверьте каталог и удалите их руками, иначе
  процесс, удалённый из пустого каталога, вернётся при следующем старте:
  ```sql
  DROP TABLE "bazis_wf_task_items", "bazis_wf_run_history", "bazis_wf_run_jobs", "bazis_wf_run_subscriptions", "bazis_wf_run_tokens", "bazis_wf_run_instances", "bazis_wf_def_versions", "bazis_wf_def_processes";
  DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key IN ('bazis.workflow.definitions', 'bazis.workflow.runtime', 'bazis.workflow.tasks');
  ```
- **`title` и `description` процесса и `title` задачи — `LocalizedText`**, строка или
  объект «язык → текст». Для показа в ответах HTTP есть `titleText`, в коде —
  `textOf(title, language)`.
- **В `bazis/library/workflow`:** `FormField.code` → `name`, `FormFieldType` →
  `FieldType`, `formFieldCodes` → `formFieldNames`, `evaluateCondition` →
  `evaluateExpression` с `isTruthy`; типов `Condition` и `ConditionOp` больше нет.
- **`workflowRuntimeConfig` → `workflowConfig`.**
- **Свои реализации контрактов.** `IWorkflowDefinitions` получил `folderOf`,
  `validate` и `palette`; контекст `WorkflowInputValidator` — `language` и `actor`.
- **Настройка, которой нет в этой версии (`settings.runAs` и другие), — ошибка
  документа**, а не молчаливо пропущенное значение.

## 0.131.0

- **Списки `/workflow/processes`, `/workflow/instances`, `/workflow/tasks` — в
  стиле JSON:API.** Старые параметры теперь молча игнорируются, замените их:
  | Было | Стало |
  | --- | --- |
  | `?limit=20&offset=40` | `?page[size]=20&page[number]=3` |
  | `?search=x`, `?archived=true` | `?filter[search]=x`, `?filter[archived]=true` |
  | `?partition=`, `?processKey=`, `?businessKey=`, `?startedById=`, `?status=` | `?filter[partition]=` и так далее |
  | `/workflow/tasks?status=open,claimed` | `?filter[status][in]=open,claimed` |

  В `meta` к `total` добавились `page`, `size`, `pageCount`, рядом появились
  `links`. Методы сервисов по-прежнему принимают `limit` и `offset`.
- **`FormIssue.code` — строка:** свой `WorkflowInputValidator` может вернуть
  свой код. Код, перебирающий коды через `switch` с проверкой на полноту, теперь
  должен обработать и неизвестные.
- **`AgentToolContract` и `ToolMetadata` получили обязательное поле `dryRun`.**
  Литерал `ToolMetadata` в коде — допишите `dryRun: "unsupported"`;
  `agentToolContract()` подставляет его сам.
- **`saveDraft` возвращает ещё и `draftUpdatedAt`.** Своя реализация
  `IWorkflowDefinitions` должна его вернуть.

## 0.130.0

- **Порта `WorkflowAccess` больше нет: права процессов — общий слой
  [`bazis/core/access`](../security/access.md).** Удалены `WorkflowAccess`,
  `DenyWorkflowAccess`, `WorkflowAction`, `WorkflowAccessTarget`.
  - Без своей системы прав — объявите роли: `@Module({ roles: defineRoles({ … }) })`.
    Проверка входа кладёт принципала в `ctx.state` под `PRINCIPAL_STATE_KEY`
    (`subject` и `findFirst` для claim `role`).
  - Со своей системой — вместо класса с `actor`, `can`, `assignees` напишите
    `AccessPolicy`: `subject`, `grants`, `ownerIds`, `principals`. Регистрация:
    `singleton(AccessPolicy, AppAccessPolicy)`.
  - Имена прав получили префикс: `instances.read` → `workflow.instances.read`.
  - `actor` запросов теперь всегда `{ kind: "user", id }`, где `id` — первый
    из `ownerIds`.
- **`IWorkflowTasks.list`: `assignees` → `addressees`.** Вместо плоского списка —
  адресаты по разделам, `[{ scope, principals }]`: их отдаёт
  `AccessPolicy.principals`, а разделы с задачами — новый `tasks.partitions()`.
- **Право проверяется до разбора запроса.** Маршрут без права отвечает `403` и на
  неверное тело, и на неизвестный id: раньше тело и экземпляр проверялись
  первыми.

## 0.129.0

- **В `providers` модуля — только согласованные формы.** Codegen
  (`bazis dev`, `bazis test`, `bazis build`) отклоняет всё остальное с
  ошибкой `BAZIS_DI_PROVIDER_FORM`. Разрешены:
  `scoped/singleton/transient(IService, Service)` или класс сам по себе,
  `singletonValue(TOKEN, value)`, `singletonAsyncFactory(TOKEN, [deps], async factory)`
  и `...withEventSubscribers(Class)`. Что поменять:

  | Было | Стало |
  | --- | --- |
  | `scoped(Service, Service, [A, B])` | `scoped(Service)` — зависимости из конструктора |
  | `singletonFactory(TOKEN, [deps], factory)`, `DI.singleton(DI.factoryProvider(...))` | Класс с конструктором: `singleton(TOKEN, Implementation)` |
  | `DI.singleton(DI.factoryProviderWithResolver(...))` | Класс; контейнер — параметр `ServiceProvider` в конструкторе |
  | `DI.singleton(DI.valueProvider(TOKEN, value))` | `singletonValue(TOKEN, value)` |
  | `DI.singleton(DI.classProvider(IService, Service))` | `singleton(IService, Service)` |
  | `DI.keyedSingleton(...)` + `keyedDependency(...)` | Свой контракт на каждую реализацию: `singleton(ISmsSender, SmsSender)` |
  | `controllers: [DI.bindDeps(Controller, ...)]` | `controllers: [Controller]` |

  Параметр простого типа (`prefix: string`) — токен с тем же именем, что у
  типа: `export type Prefix = string; export const Prefix = createToken<Prefix>("Prefix")`.
  Настройки в конструкторе — `ConfigView<Type>` с `defineConfig<Type>(...)`.
  `overrides` в тестах не проверяются.
- **gRPC-клиент — класс с `@GrpcClient`.** `grpcClientProvider` удалён, класс
  клиента переименован в `GrpcClientBase`:

  ```ts
  @GrpcClient(UsersRpc, { config: usersRpcConfig })   // address, timeoutMs
  export class UsersClient extends GrpcClientBase {}

  @Module({ grpcClients: [UsersClient], providers: [scoped(UsersApi)] })
  ```

  Сервис просит `UsersClient` вместо `GrpcClient`; второму сервису — свой класс
  вместо третьего аргумента-токена. Без DI — `new GrpcClientBase(service, options)`.
- **HTTP-клиент — класс с `@HttpClient`.** `httpClientModule` удалён, класс
  клиента переименован в `HttpClientBase`:

  ```ts
  @HttpClient({ config: weatherConfig })   // baseUrl, timeoutMs, maxResponseBytes
  export class WeatherClient extends HttpClientBase {}

  @Module({ httpClients: [WeatherClient], providers: [scoped(WeatherService)] })
  ```

  Именованные клиенты `HttpClientFactory.createClient("name")` в DI — теперь
  отдельные классы. Без DI — `new HttpClientBase({ … })`.
- **`IWorkflowDefinitions.publishCode`.** Своя реализация каталога процессов
  должна реализовать `publishCode(entries)`: фреймворк публикует им процессы
  из кода при старте.
- **`WorkflowInputValidator`** регистрируется модулем процессов
  (`DefaultWorkflowInputValidator`); своя проверка — регистрацией
  `singleton(WorkflowInputValidator, AppInputValidator)` в своём модуле.

## 0.128.0

- **`ProcessSummary.module`.** Своя реализация `IWorkflowDefinitions`
  должна возвращать в `list` и `get` поле `module`: модуль, который описал
  процесс в коде, или `null`.
- **Пропущенное расписание срабатывает один раз.** Если воркер не работал
  несколько запусков подряд, раньше процесс запускался за каждый пропуск;
  теперь — один раз, а следующий запуск планируется от текущего времени.

## 0.126.0

- **Чистка истории бизнес-процессов.** В 0.124.0–0.125.0 записи истории
  экземпляра без шага (`started`, `completed`, `cancelled`) получали
  случайный `tokenId` вместо `null`. Код менять не нужно, таблицы те же;
  старые записи исправит один запрос:

  ```sql
  UPDATE "bazis_wf_run_history" h SET "tokenId" = NULL
  WHERE "tokenId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "bazis_wf_run_tokens" t WHERE t.id::text = h."tokenId");
  ```

## 0.123.0

- **`@Tool` требует `callers`.** Добавьте `callers: ["agent"]` инструментам
  агентов; инструментам, которые вызывает свой код через `ToolRunner`, — его
  id (`["workflow"]`). Без `callers` приложение не запустится и назовёт
  инструмент. Теги на доступ больше не влияют: если вы отбирали инструменты
  для процессов тегом `workflow`, перенесите его в `callers`.
- **Настройки инструментов — в `TOOL_EXECUTION_OPTIONS`.** Перенесите
  содержимое `AGENT_RUNTIME_OPTIONS.toolExecutorOptions` в отдельное
  значение `TOOL_EXECUTION_OPTIONS`; `TOOL_RUNNER_OPTIONS` тоже заменяется
  им ([Агенты](../ai/agents.md#настройки-аудит-и-подтверждение)).
- **`ToolRunner` регистрирует фреймворк.** Уберите
  `...toolRunnerProviders` из `providers` и вызывайте
  `runner.as("workflow").run(...)`; для `write` и `external` передавайте
  `actor` ([Вызов без модели](../ai/tools.md#вызов-без-модели)).
- **Папка `tools/`.** `bazis g module --full` кладёт инструмент в
  `tools/`, а не в `ai/tools/`. Старые модули переносить не обязательно, но
  новое правило — `tools/` в модуле-владельце.
- Исполнитель без агента требует `caller`: код ошибки
  `TOOL_AGENT_REQUIRED` заменён на `TOOL_CALLER_REQUIRED`.

## 0.120.0

- **У `rateLimit` нет `trustProxy` и `proxyHeader`.** Перенесите список
  прокси в настройку сервера: `http: { trustedProxies: ["127.0.0.1"] }`
  ([За nginx](../deployment/production.md#за-nginx)). `rateLimit` сам
  берёт `ctx.clientIp`. Было `trustProxy: 2` (CDN и nginx) — укажите
  адреса обоих: `["127.0.0.1", "<подсеть CDN>"]`.

## 0.118.0

- **Значения секретов маскируются везде.** Если тест или код сравнивает
  текст лога или ошибки, в котором есть значение `secret()` длиной от 10
  символов, там теперь `***`. Сравнивайте с `***` или берите в тесте
  значение короче 10 символов.

## 0.117.0

- **Поле `decimal` динамической модели — точный `numeric`, значение —
  строка.** Раньше это был `double precision` и число. Существующую
  таблицу `ensureCreated` теперь остановит (`column type differs`):
  переведите столбец один раз — `ALTER TABLE "leads" ALTER COLUMN
  "amount" TYPE numeric USING "amount"::numeric;` — и передавайте
  значения строками (`"19.90"`).
- **Столбец `numeric` в базе читается как `decimal`, а не как `real`.**
  Свойство `real` поверх такого столбца — теперь расхождение типа:
  объявите его `@Column({ type: "decimal" })`.

## 0.116.0

- **Тип параметра маршрута должен совпадать с ограничением.** `bazis
  codegen` останавливается на `@Get(":id(int)") byId(id: string)`:
  объявите `id: number`. Для `(bool)` — `boolean`, для `(uuid)` и
  `(alpha)` — `string`. Раньше параметр, объявленный строкой, получал
  число — проверьте код, который на это полагался.

## 0.114.0

- **`ignoreQueryFilters()` снимает условия и со связей из `include`.**
  Запрос с `ignoreQueryFilters().include(...)` теперь возвращает и
  мягко удалённых детей, и детей, скрытых их `@QueryFilter`, в том числе
  фильтром по организации. Если связям условия нужны, не вызывайте
  `ignoreQueryFilters()` или загрузите связи отдельным запросом
  ([Фильтры запросов и мягкое удаление](../database/filters.md#связи)).

## 0.113.0

- **`llmRouter(...)` и `defineConfig(...)` не бросают исключение при
  вызове.** Ошибку объявления сообщает запуск одной строкой
  `[bazis] configuration error`. Тест, который ждал исключение от самого
  вызова, теперь ждёт его от `createContainer(...)` (для `llmRouter`) или
  от `ensureValid()` (для `defineConfig`). То же для `@Infra(...)`,
  `infraModule(...)`, `configEnum(...)`, `@GrpcController(...)` и
  `@GrpcMethod(...)`.

## 0.112.0

- **`secret("")` останавливает запуск.** Обязательный секрет пишется
  `secret()`, а для разработки — непустое значение: `secret("dev-key")`.

## 0.111.0

- **Сервис с `@Cacheable` или `@CacheableRedis` без `cache: memory()`
  останавливает запуск.** Добавьте `cache: memory()` в `runApp`. Раньше
  такие декораторы ничего не делали, так что после добавления кэш начнёт
  работать по-настоящему — проверьте сроки и ключи.

## 0.110.0

- **`@AllowAnonymous()` и `@Authorize(...)` на одном методе или классе
  останавливают запуск.** Оставьте одно: `@Authorize(...)`, если маршрут
  должен быть защищён, или `@AllowAnonymous()`, если открыт. Проверьте,
  какой из вариантов действовал раньше: при `@AllowAnonymous()` над
  `@Authorize(...)` маршрут был открыт. Класс с `@Authorize` и метод с
  `@AllowAnonymous()` (и наоборот) работают как прежде.

## 0.109.0

- **Токенов `HTTP_CLIENT` и `HTTP_CLIENT_FACTORY` нет.** Берите клиенты по
  типу: `constructor(private readonly http: HttpClient)`,
  `constructor(clients: HttpClientFactory)`.
- **`createTestContainer` собирается через ядро.** Опции — `overrides` и
  `configure(builder)`; низкоуровневые опции `createContainer` (например,
  `validateScopes`) больше не принимаются. Тесты с одними `overrides`
  ничего не меняют.
- Тесты, которые сравнивали текст `Missing dependency "…" for "…".` с
  точкой в конце, нужно обновить: точка теперь стоит только перед
  подсказкой.

## 0.108.0

- `HttpModuleOptions.localize` и `errorHandler({ localize })` заменены на
  `languages`. Их ставит `runApp` из `language` и `messages`: приложения на
  `runApp` ничего не меняют.
- Новое: `runApp({ http: { authorize } })` — [закрыто по
  умолчанию](../overview/authorization.md#закрыто-по-умолчанию);
  `language: { default, supported }` — [язык по
  Accept-Language](../recipes/russian.md#язык-по-accept-language).

## 0.107.0

- **Запуск и остановка пишутся в журнал и в production**: `bazis started` с
  адресом в `listening` и `bazis stopped`. Если журнал разбирает скрипт,
  проверьте, что новые строки ему не мешают; отключить —
  `kernel: { startupReport: false }`.
- Новое: `bazis build --bin --platform linux-x64` —
  [Linux-файл с Mac](../deployment/platforms.md#linux-файл-с-mac).

## 0.106.0

- **`ServiceProvider` в scoped-сервисе — область запроса.** `resolve`
  отдаёт сервисы того же запроса, `dispose()` отказывает. Singleton,
  фоновые службы и хуки по-прежнему получают корневой контейнер. Если
  scoped-сервис брал `ServiceProvider`, чтобы выйти в корень (например,
  разрешить scoped-сервис в отдельной области), вызывайте
  `this.services.createScope()` — он работает как раньше
  ([Контейнер вручную](../fundamentals/dependency-injection.md#контейнер-вручную)).

## 0.105.3

Ломающих изменений нет. `runApp({ language: "ru" })` теперь переводит и
тексты `CodexError`: вызов `CodexError.useMessages(RU_CODEX_MESSAGES)` при
старте можно убрать. Тесты, которые сравнивали текст
`Singleton "BazisLifecycleHook" …`, нужно обновить: теперь в нём и класс,
`"WarmUp (as BazisLifecycleHook)"`.

## 0.105.2

Ломающих изменений нет. CLI теперь останавливается на Bun старше 1.4.0 —
в том числе когда `bunx bazis` или `bun run` запускает его старым `bun`
из `PATH`. Обновите его: `bun upgrade`
([Старый Bun в PATH](../introduction/why-bun.md#старый-bun-в-path)).

## 0.105.1

Ломающих изменений нет. Зависимость по имени, которую никто не
регистрирует, теперь приходит в списке `Service graph validation failed:`
как `Missing dependency "…" for "<сервис>"`. Тесты, которые сравнивали
текст `No provider token found for named dependency`, нужно обновить.

## 0.105.0

Ломающих изменений нет. Новое — повтор транзакции целиком:
`transactionScope(work, { retry: true })`
([Повтор при взаимной блокировке](../database/transactions.md#повтор-при-взаимной-блокировке)).

## 0.104.1

- **Конвертер не получает `null`.** `null` в поле с `@HasConversion`
  записывается как NULL, конвертер не вызывается. Свой конвертер, который
  превращал `null` в значение (например, в `""`), должен объявить
  `convertsNulls: true`
  ([`null` и конвертеры](../database/entities.md#null-и-конвертеры)).
- `ValueConverters.json()` пишет NULL вместо строки `"null"`; старые
  строки `"null"` читаются как `null`.

## 0.104.0

- **Условие или сортировка по зашифрованному столбцу — ошибка.** Раньше
  `where((c) => c.phone.eq(phone))` по столбцу с
  `ValueConverters.encrypted` молча возвращал `[]`, теперь бросает
  `OrmError`. Ищите по отдельному столбцу с HMAC значения
  ([Шифрование столбца](../database/entities.md#шифрование-столбца)).
- **Ключ и уникальный индекс** на зашифрованном столбце не дают собрать
  модель (`ModelBuildError`): одинаковые значения хранятся по-разному,
  такие ограничения не работали.
- Ключ шифрования в приложении берите из настроек:
  `encryptedWith(cryptoConfig, "phoneKey")` вместо
  `ValueConverters.encrypted(cryptoConfig.get("phoneKey").reveal())` —
  так работают ключи из файлов секретов.

## 0.103.0

- **Клиент Codex — по типу `ICodex`.** Токен `CODEX_APP_SERVER` удалён:

  ```ts
  // было
  singletonFactory(Assistant, [CODEX_APP_SERVER] as const, (codex) => new Assistant(codex))
  // стало
  export class Assistant { constructor(private readonly codex: ICodex) {} }
  ```

## 0.102.0

- **Все ошибки привязки — одним `400`.** Нет обязательного параметра или
  он не того типа — больше не отдельный ответ, а элемент `details`:

  ```text
  GET /books   было:  {"error":"Missing required query parameter \"q\""}
               стало: {"error":"Validation failed","details":[{"property":"q","code":"required",…}]}
  ```

  Клиенты, которые читали `error` в этих случаях, читают `details`
  (`property`, `code`). Тесты, которые сравнивали текст, нужно обновить.
- Ключи сообщений `missingParameter` и `invalidParameter` удалены: свои
  тексты — через `required` и `type` в `runApp({ messages })`.

## 0.100.7

- **Свой валидатор моделей.** У порта `ModelValidator` вместо
  `typeMismatchMessage` и `failureTitle` — один необязательный метод
  `message(code, params)`. Касается только своего валидатора в
  `runApp({ validator })`.
- **Русские тексты проверки** изменились: `Поле "title": минимальная длина —
  2` вместо `должно содержать не менее 2 символов`. Тесты, которые сравнивают
  русский текст, нужно обновить. `MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES)`
  в `index.ts` можно заменить на `runApp({ language: "ru" })`
  ([Русская локализация](../recipes/russian.md)).

## 0.100.4

- **Адаптер WebSocket — функция от сервисов:**

  ```ts
  // было
  websocket: { adapter: new RedisWebSocketAdapter(redis) }
  // стало
  websocket: { adapter: (services) => new RedisWebSocketAdapter(services.resolve(IRedis)) }
  ```

  Готовый экземпляр адаптера отклоняется при запуске с подсказкой
  ([Несколько экземпляров](../recipes/multiple-instances.md)).

## 0.100.0

- **Вывод CLI** — экраны вместо строк `[bazis] …`. Скрипты, которые
  разбирали вывод, должны смотреть на код выхода.
- **Подключения `@Infra` стартуют параллельно**, несколько сбоев сразу —
  `StartupFailuresError`. Код, который ловил первый сбой, получит общий.
- **Ошибки нескольких настроек** — одна `ConfigValidationError` с `issues`,
  а не `AggregateError`.
- **LLM-коннектор проверяет провайдера при запуске.** Если провайдер
  недоступен при старте по природе — `checkOnStart: false`
  ([Проверка при старте](../ai/llm-connectors.md#проверка-при-старте)).
- **Файл, который не импортирует ни одна цель**, — предупреждение
  кодогенерации, а не ошибка.

## 0.99.6

- **Клиенты инфраструктуры — по типу.** `IPostgres`, `IRedis`,
  `IOpenSearch` вместо токенов `POSTGRES`, `REDIS`, `OPENSEARCH`:

  ```ts
  constructor(private readonly sql: IPostgres, private readonly redis: IRedis) {}
  ```

## 0.99.0

Агенты стали данными.

- Убраны `@Agent`, `@Task`, `@Prompt`, `agentOutput()`, поля `agents` и
  `prompts` у `@Module`, классы входа и выхода агента, вызов агента по
  имени (`invoke`, `invokeTask`).
- Агент — `AgentDataDefinition`: `name`, `instructions`, `toolNames`. Его
  можно хранить в базе ([Агенты в базе](../ai/agents.md#агенты-в-базе)).
  Инструменты остаются кодом.
- `AgentRuntime` создаёт DI: сервис получает его по типу. Настройки
  рантайма — токен `AGENT_RUNTIME_OPTIONS`.
- `instructions` — системное сообщение как есть.
- Код ошибки кодогенерации — `BAZIS_TOOL_SCHEMA_MODEL_UNIMPORTABLE`
  (был `BAZIS_AGENT_SCHEMA_MODEL_UNIMPORTABLE`).

## 0.98.34

- **Кэш-методы `scoped`-сервиса** требуют явный `key`, а `transient`-сервис
  кэш-декораторы не принимает: иначе — `CacheDeclarationError` при
  запуске.
- Убраны `cachedScoped` и `cachedSingleton`: регистрируйте обычными
  `scoped` и `singleton`.

## 0.98.33

- Убран `backgroundModule({ services })`: фоновые службы объявляет их
  модуль — `@Module({ background: [Worker] })`.

## 0.98.32

- Проверки `@Authorize` получают `AuthorizeContext` (`header`,
  `services`, `state`), а не `HttpContext`. Обычные проверки работают
  как раньше. Вспомогательные функции, которым проверка передаёт свой
  контекст, типизируйте как `AuthorizeContext`.
- Убрана опция `controllers` у `httpModule` и `grpcModule`: контроллеры
  объявляет модуль (`controllers`, `grpcControllers`).

## 0.98.31

- Шлюз WebSocket объявляет его модуль, как контроллер:
  `@Module({ gateways: [ChatGateway] })`. Опция `gateways` у
  `websocketModule` убрана; `runApp({ websocket })` — только общие
  настройки.

## 0.97.0

- **`@Authorize` на методе добавляет проверки** к проверкам контроллера, а
  не заменяет их. Метод с другими правами, чем у контроллера, вынесите в
  отдельный контроллер. `@AllowAnonymous()` по-прежнему снимает все
  проверки.

## Раньше

Изменения до 0.97 — в
[CHANGELOG](https://github.com/asus97178/bazis/blob/main/CHANGELOG.md).

## Дальше

- [Версии и выпуски](versions.md)
- [Справочник ошибок](errors/README.md)
