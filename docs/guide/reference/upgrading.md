# Обновление между версиями

Что поменять в коде при переходе на новую версию. Здесь — только
ломающие изменения, от новых к старым; исправления и новое — в
[CHANGELOG](https://github.com/asus97178/bazis/blob/main/CHANGELOG.md).

Переходите через несколько версий — пройдите по всем разделам между
вашей версией и новой.

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
