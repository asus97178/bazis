# Ошибки DI

Ошибки контейнера внедрения зависимостей. Все наследуют `DiError` из
`bazis/core/di`.

Большинство из них контейнер находит **при запуске**, до первого запроса.
Приложение печатает одну строку `[bazis] configuration error:` с текстом
ошибки и выходит с кодом 1:

```text
[bazis] configuration error: Service graph validation failed:
Missing dependency "Mailer" for "SignupService"
```

Тексты ниже получены на bazis 0.100.8, кроме отмеченных «текст из
исходников».

## Ошибки графа при запуске

### `ServiceValidationError`

Граф сервисов не сходится. В сообщении — список нарушений, по одному на
строку, под заголовком `Service graph validation failed:`.

#### Missing dependency

```text
Missing dependency "Mailer" for "SignupService"
```

- **Причина.** Конструктору `SignupService` нужен `Mailer`, но его не
  регистрирует ни один доступный модуль.
- **Что сделать.** Добавьте `Mailer` в `providers` модуля или импортируйте
  модуль, который его экспортирует.

Зависимости, которые внедряются по имени, — `ConfigView<T>`,
`IRepository<T>`, токен `createToken("…")` — приходят в том же списке, с
подсказкой:

```text
[bazis] configuration error: Service graph validation failed:
Missing dependency "Config:report" for "ReportService". The config defineConfig("report", …) is not declared
in the application: add it to `config` of the module that uses it, or to runApp({ config }).
Missing dependency "IRepository<Lead>" for "LeadsService". Repositories are registered by ormBazis for the
entities of its context: add Lead to the entities of an ormBazis module and keep registerRepositories on
(the default), or inject that module's DbContext instead.
Missing dependency "IClock" for "Scheduler".
```

| Имя | Что сделать |
| --- | --- |
| `Config:report` | Подключить конфиг: `config: reportConfig` в модуле или `runApp({ config })` ([Конфигурация](../../fundamentals/configuration.md)) |
| `IRepository<Lead>` | Добавить `Lead` в `entities` модуля с `ormBazis` ([Репозитории](../../database/repositories.md)) |
| `IClock` | Зарегистрировать токен: `scoped(IClock, SystemClock)` ([Провайдеры](../../overview/providers.md#интерфейс-и-токен)) |

> [!NOTE]
> С версии 0.105.1. Раньше запуск останавливался на первой такой
> зависимости, без имени сервиса:
> `No provider token found for named dependency "Config:report".`

#### Singleton depends on scoped

```text
Singleton "PriceCache" depends on scoped "OrdersRepository". A scoped service lives for one request or scope: make "PriceCache" scoped too, or inject ServiceProvider and resolve "OrdersRepository" in a scope you create (provider.createScope()).
```

- **Причина.** Долгоживущий сервис держал бы короткоживущий вечно: один
  `DbContext` на всё приложение, данные одного запроса в другом.
- **Что сделать.** Сделайте `PriceCache` `scoped`. Если это фоновая служба или
  хук — внедрите `ServiceProvider` и создавайте область на каждую единицу
  работы ([Жизненный цикл](../../fundamentals/lifecycle.md#scoped-сервисы-в-фоновой-службе)).
- Если сервис зарегистрирован под токеном, в сообщении будет имя токена:
  `singleton(LIFECYCLE_HOOK, WarmUp)` даст `Singleton "BazisLifecycleHook"`.

#### Cycle detected

```text
Cycle detected: InvoiceService -> OrderService -> InvoiceService
```

- **Причина.** Сервисы зависят друг от друга по кругу. Цикл печатается
  один раз, начиная с участника, первого по алфавиту (до 0.100.8 — по разу
  с каждого участника).
- **Что сделать.** Вынесите общую часть в третий сервис или разорвите цикл
  ленивой зависимостью
  ([Ленивые зависимости](../../fundamentals/dependency-injection.md#ленивые-зависимости)).

#### Class provider requires constructor deps

```text
[bazis] WARNING: generated code is out of date (application sources changed).
[bazis] New or changed controllers, routes and constructor dependencies are NOT active.
[bazis] Run: bunx bazis codegen   (bazis dev, bazis build and bazis test run it automatically)

[bazis] configuration error: Service graph validation failed:
Class provider "Mailer" requires at least 1 constructor deps, but only 0 declared. Constructor dependencies are wired by codegen: if the constructor was added or changed after the last run, run `bazis codegen` (bazis dev, bazis test and bazis build run it automatically); otherwise pass the deps explicitly.
```

- **Причина.** Конструктор изменили, а сгенерированный код остался старым.
  Так бывает при запуске `bun run src/index.ts` напрямую, без `bazis dev`.
- **Что сделать.** `bunx bazis codegen`. Команды `dev`, `test` и `build`
  запускают кодогенерацию сами.
- Класс ошибки внутри — `ClassDependenciesMismatchError`, при запуске она
  приходит в составе `ServiceValidationError`.

### `ModuleEncapsulationError`

Модуль берёт сервис, который ему не виден. Заголовок —
`Module encapsulation violated:`.

#### Not exported

```text
Module "ReportsModule": "ReportsService" depends on "UsersRepository", which module "UsersModule" provides but does not export. Add it to the exports of "UsersModule".
```

- **Что сделать.** Добавьте `UsersRepository` в `exports` модуля
  `UsersModule` — или не давайте его наружу, а экспортируйте сервис,
  который его использует.

#### Not imported

```text
Module "BillingModule": "BillingService" depends on "TariffsRepository", which module "TariffsModule" exports, but "BillingModule" does not list "TariffsModule" in its imports. Add "TariffsModule" to the imports of "BillingModule".
```

- **Что сделать.** Добавьте `TariffsModule` в `imports` модуля
  `BillingModule`. Импорт в корневом модуле не делает сервис видимым
  соседям ([Инкапсуляция](../../fundamentals/encapsulation.md)).

#### Module imports cycle

```text
Module imports cycle: module#4 -> module#5 -> module#4
```

- **Причина.** Модули импортируют друг друга. Модули-классы называются по
  имени класса, модули-объекты — `module#N`.
- **Что сделать.** Вынесите общие сервисы в третий модуль и импортируйте
  его в оба.

## Ошибки во время работы

### `ScopedServiceFromRootError`

```text
[bazis] configuration error: Cannot resolve scoped service "CartRepository" from root provider. A scoped service lives in a request or a scope: create one with provider.createScope(), resolve "CartRepository" from it and dispose the scope when done.
```

- **Причина.** Scoped-сервис запросили у корневого контейнера, вне области
  запроса. В примере — хук запуска вызвал `provider.resolve(CartRepository)`
  у внедрённого `ServiceProvider`.
- **Что сделать.** Создайте область и закройте её после работы:

  ```ts
  const scope = this.provider.createScope();
  try {
    await scope.resolve(CartRepository).count();
  } finally {
    await scope.dispose();
  }
  ```

### `ProviderNotFoundError`

```text
ProviderNotFoundError: Provider for token "Unregistered" was not found.
```

- **Причина.** `resolve(...)` вызван для токена, который никто не
  регистрировал. Зависимости конструкторов проверяются при запуске, поэтому
  эта ошибка — от ручного `resolve` в коде или тесте.
- **Что сделать.** Зарегистрируйте сервис или проверьте, тот ли токен
  передан.

### `AsyncResolutionRequiredError`

```text
AsyncResolutionRequiredError: Provider for token "DB" is asynchronous. Use resolveAsync(...) instead of resolve(...).
```

- **Причина.** Сервис из `singletonAsyncFactory` запрошен синхронно до того,
  как его создали. В приложении асинхронные фабрики выполняются при запуске
  и такой ошибки нет; она появляется в контейнере из `createTestContainer`,
  который не запускают.
- **Что сделать.** `await container.resolveAsync(DB)`.

### `ScopeDisposedError`

```text
ScopeDisposedError: Cannot use a disposed scope or container.
```

- **Причина.** Область уже закрыта (`dispose()`), а из неё снова берут
  сервис. Часто — сервис запомнили в поле singleton и используют после
  запроса.
- **Что сделать.** Берите сервисы из живой области; в фоновой службе —
  новая область на каждую единицу работы.

## Редкие ошибки

### `InvalidProviderError`

```text
[bazis] configuration error: Module "InvalidProviderModule": providers[0] is not a provider registration ({ provide: Clock }). Register it with singleton(Clock), scoped(Clock), transient(Clock), singletonValue(TOKEN, value) or singletonFactory(TOKEN, [deps], factory).
```

В `providers` модуля — объект вместо регистрации. Регистрируйте через
`singleton`, `scoped`, `transient`, `singletonValue`, `singletonFactory`.
До 0.100.8 здесь был `TypeError: undefined is not an object`.

Другой вариант той же ошибки — при регистрации вручную, текст из
исходников: `Provider for "Clock" has unknown shape: expected one of
useClass/useFactory/useValue.`

### `CircularDependencyError`

```text
Circular dependency detected: A -> B -> A
```

Текст из исходников. Цикл, найденный при создании сервиса, а не при
проверке графа, — например, через фабрику, которая сама вызывает
`resolve`. Что делать — как с [Cycle detected](#cycle-detected).

### `NamedDependencyNotFoundError`

```text
No provider token found for named dependency "IClock".
```

Текст из исходников. Зависимость по имени, которую никто не регистрирует,
при запуске приложения приходит в списке
[`ServiceValidationError`](#missing-dependency) с именем сервиса. Этот
класс — когда граф не проверялся: `createContainer(…)` без
`validateOnBuild` и сразу `resolve`. Что сделать — то же: зарегистрировать
токен или сделать контракт абстрактным классом
([Провайдеры](../../overview/providers.md#интерфейс-и-токен)).

### `AmbiguousNamedDependencyError`

```text
Multiple provider tokens share the debug name "IClock", named dependency resolution is ambiguous. Rename one of the tokens or declare deps explicitly.
```

Текст из исходников. Два токена с одним именем, и зависимость по имени не
знает, какой взять. Переименуйте один из токенов.

### `ModuleOwnedProviderConflictError`

```text
Module-owned provider registration conflict:
Module "AppModule": class "X" is both a module-owned contribution and another DI registration.
```

Текст из исходников. Класс, который модуль вносит в контейнер сам —
через собственный канал расширения (так делают пакеты фреймворка), —
зарегистрирован ещё и обычным способом. Оставьте одну регистрацию.

### `OptionsValidationError`

```text
Options validation failed:
…
```

Текст из исходников. Не прошли проверку параметры, зарегистрированные
через options-расширение DI. Настройки `defineConfig` проверяются раньше и
дают [`ConfigValidationError`](startup.md#configvalidationerror).

## Дальше

- [Ошибки кодогенерации](codegen.md)
- [Провайдеры](../../overview/providers.md)
- [Внедрение зависимостей](../../fundamentals/dependency-injection.md)
