# Применение архитектурных правил: Users и DataManager

Дата сверки Users: **2026-10-02**; DataManager: **2026-09-13**. Основание:
[MOD-ARCH-001](MODULE_ARCHITECTURE.md).

Это разбор структуры и объявленных контрактов, а не отчёт о запуске приложения
или полные паспорта всех операций. Примеры показывают атомарный модуль,
составной модуль и описание входных полей. Перед изменением функции нужно
сверить её актуальный паспорт и код по приведённым ссылкам.
Полные фрагменты TypeScript для Task и композиции DataManager находятся в
[приложении с примерами кода](MODULE_CODE_EXAMPLES.md).
Task и Guest в общей спецификации — примеры будущих простых функций: готовые
модули с такими именами в этой рабочей копии не обнаружены.

## 1. Users — атомарный модуль

Ответственность: данные пользователей, чтение списка/карточки и создание
пользователя. Точка подключения:
[Users.module.ts](../../src/app/modules/actor_modules/users/Users.module.ts).

### Состав и входы компонентов

| Компонент | Файл | Входы | Результат / регистрация |
| --- | --- | --- | --- |
| `UsersModule` | [Users.module.ts](../../src/app/modules/actor_modules/users/Users.module.ts) | Подключается классом; аргументов фабрики нет | ORM, provider, controller, UI и background в одном владельце |
| `User` | [User.ts](../../src/app/modules/actor_modules/users/User.ts) | `id`, `name`, `email`, `age`, `createdAt` | ORM-модель; ключ `id`, unique index на `email` |
| `UsersDbContext` | [UsersDbContext.ts](../../src/app/modules/actor_modules/users/UsersDbContext.ts) | ORM options через базовый контекст, общий provider | Набор `users = set(User)`; scoped |
| `IUserService` | [IUserService.ts](../../src/app/modules/actor_modules/users/IUserService.ts) | `getAll(query)`, `count()`, `getById(id)`, `create(dto)` | Интерфейс и одноимённый DI-токен; экспорт модуля |
| `UserService` | [UserService.ts](../../src/app/modules/actor_modules/users/UserService.ts) | Constructor: `UsersDbContext`; аргументы интерфейса | Scoped; чтение через ORM, проверка входа создания и явный `saveChanges()` |
| `UsersController` | [UsersController.ts](../../src/app/modules/actor_modules/users/UsersController.ts) | Constructor: `IUserService`; query/path/body | Scoped через `controllers`; list, getById, create |
| `CreateUserDto` | [CreateUserDto.ts](../../src/app/modules/actor_modules/users/CreateUserDto.ts) | `name`, `email`, `age` | Runtime-модель с `@Validator` |
| `UserListQuery` | [UserListQuery.ts](../../src/app/modules/actor_modules/users/UserListQuery.ts) | Sort/filter/page в формате `ListRequest` | Разрешённые поля, операторы и лимиты |
| `UserResponse`, `toUserResponse` | [UserResponse.ts](../../src/app/modules/actor_modules/users/UserResponse.ts) | ORM-модель `User` | Публикуемые `id`, `name`, `email`, `age`, `createdAt` |
| `UserStatsReporter` | [UserStatsReporter.ts](../../src/app/modules/actor_modules/users/UserStatsReporter.ts) | `ServiceProvider`, `Logger`; `tick(signal)` | Singleton; scope на итерацию, подсчёт пользователей, dispose |
| `UsersAdminUiProfile` | [UsersAdminUiProfile.ts](../../src/app/modules/actor_modules/users/ui/UsersAdminUiProfile.ts) | `surface: admin`, controller и response references | Декларация административного интерфейса |
| `UsersClientUiProfile` | [UsersClientUiProfile.ts](../../src/app/modules/actor_modules/users/ui/UsersClientUiProfile.ts) | `surface: client`, controller/response/list request, `readonly: true` | Декларация клиентского интерфейса |

В `ormOsnova` указаны `context: UsersDbContext`, `entities: [User]`,
`ensureCreated: true`; provider внутри функции не создаётся. Это текущее
объявление, а не рекомендация включать создание схемы для любого нового модуля.
`providers` содержит `scoped(IUserService, UserService)`,
`exports` — `[IUserService]`. Экспорт предназначен импортирующим модулям;
контроллер этого же владельца получает сервис через собственную регистрацию.

У фона `intervalMs: 10_000`, `runImmediately: false`. Его вход — сигнал отмены
и зависимости, пользовательского payload нет. Такой фон не является основанием
выделять отдельный предметный подмодуль.

### Публичные операции

HTTP-пути ниже включают `prefix: "api"` из
[src/index.ts](../../src/index.ts). Префикс относится к host-композиции.

| Вход | Поля | Доступ в контроллере | Объявленный результат |
| --- | --- | --- | --- |
| `GET /api/users` | `UserListQuery` | Admin или Client | `ListDocument<UserResponse>` |
| `GET /api/users/:id(int)` | `id: number`, path | Admin или Client | `Ok(UserResponse)` либо `NotFound` |
| `POST /api/users` | `CreateUserDto`, body | Admin | `Created` с response и location `/api/users/<id>` |
| `IUserService.getAll(query)` | `ListQuery`, аргумент метода | Определяет вызывающий адаптер | `Promise<PageResult<UserResponse>>`: `{ items, total }` |
| `IUserService.count()` | Входных полей нет | Определяет вызывающий адаптер | `Promise<number>` |
| `IUserService.getById(id)` | `id: number`, аргумент метода | Определяет вызывающий адаптер | `Promise<UserResponse \| null>` |
| `IUserService.create(dto)` | `CreateUserDto`, аргумент метода | Определяет вызывающий адаптер | `Promise<UserResponse>` |

HTTP-права не переносятся автоматически на прямой DI-вызов сервиса.
Контроллерное создание использует привязку request-модели. Прямой
`UserService.create()` нормализует известные поля и вызывает тот же Validator
через `UserInputError.check()` до записи. Контроллер формирует HTTP-документ
списка и ссылки из `PageResult`, поэтому сервис не зависит от HTTP-представления.
Подробный контракт и проверки — в [паспорте Users](../../src/app/modules/actor_modules/users/MODULE.md).

### Поля создания пользователя

Ниже объявленный TS/DTO-контракт, с defaults из сервиса. `null` не входит
в TS-типы полей; поведение невалидного HTTP-ввода требует проверки runtime-пути,
а не выводится из одного вопросительного знака в TypeScript.

| Поле | Тип | Источник | Обязательность | Default | Объявленные проверки | Пример |
| --- | --- | --- | --- | --- | --- | --- |
| `name` | `string` | body / аргумент `dto` | `required: true` | Нет | Trim в сервисе, длина 2–50, непробельный символ | `Анна` |
| `email` | `string` | body / аргумент `dto` | `required: true` | Нет | Trim/lowercase в сервисе, длина 3–120, pattern адреса с @ и доменом | `anna@example.test` |
| `age` | `number` | body / аргумент `dto` | Необязательно | `dto.age ?? 0` в `UserService.create` | Целое 0–150 | `28` |

Формат email задан `pattern` в DTO, а не выводится из имени поля.
Уникальность задана ORM-индексом; конкретный публичный ответ на
нарушение уникальности этой сверкой не квалифицирован.

`id` и `createdAt` не являются входами создания. Они есть в ORM-модели и response.
Общий [modelBinder.ts](../../src/osnova/core/http/Binding/modelBinder.ts) копирует
только объявленные поля модели, удаляет неизвестные и запускает подключённый
validator. Данный разбор не подменяет проверку полного HTTP-пути.

### Поля списка и ответа

В `UserListQuery`: default page size **20**, max page size **100**.
Это декларации query-возможностей, а не обязательные поля тела запроса.

| Поле | Сортировка | Операторы фильтра |
| --- | --- | --- |
| `name` | Да | `eq`, `contains`, `startsWith` |
| `email` | Нет | `eq` |
| `age` | Да | `eq`, `gte`, `lte`, `in` |
| `createdAt` | Да | Не объявлены |

Пример: `?sort=-createdAt&page[number]=2&page[size]=20`.
В `UserResponse`: `id: number`, `name: string`, `email: string`, `age: number`,
`createdAt: Date` (в HTTP JSON — строка ISO). Модель `User` задаёт initializers `id = 0`, `name = ""`,
`email = ""`, `age = 0`, `createdAt = new Date(0)`; `createdAt` отмечен ORM-типом
`createdAt`. Initializers сущности не заменяют контракт HTTP-запроса.

**Архитектурный вывод:** ORM, сервис, контроллер, DTO, UI и фон вместе образуют
одну функцию. Для аналогичных Task или Guest используется такая же атомарная
граница с необходимым для задачи набором компонентов.

## 2. DataManager — составной модуль

Корень [DataManager.module.ts](../../src/app/modules/datamanager_modules/DataManager.module.ts)
импортирует Auth и четыре атомарные части, имеет `exports: []` и не содержит
своих providers, controllers, ORM или background.
Auth — внешняя зависимость пакета, а не пятая ответственность DataManager.

### Части, регистрации и входы

| Атомарный модуль | Ответственность / ORM | Основные входы | Providers и публичный DI-контракт |
| --- | --- | --- | --- |
| [Tables](../../src/app/modules/datamanager_modules/tables_module/DataManagerTables.module.ts) | Каталог таблиц, метаданные и динамические модели; `TablesDbContext`, `[DmTable]` | `TablesController`; definition и имя таблицы | Singleton: MetadataDbContextFactory, CatalogService, MetadataStore, MetadataMutation, DynamicDbOptions, DynamicModelRegistry, TableService; scoped TableQueryService. Exports: CatalogService, MetadataStore, MetadataMutation, DynamicDbOptions, DynamicModelRegistry, TableService |
| [Fields](../../src/app/modules/datamanager_modules/fields_module/DataManagerFields.module.ts) | Поля и индексы; `FieldsDbContext`, `[DmField, DmIndex]` | `FieldsController`; table, field/index definition | Singleton FieldService, scoped FieldQueryService; exports `[FieldService]` |
| [Validators](../../src/app/modules/datamanager_modules/validators_module/DataManagerValidators.module.ts) | Сохраняемые правила; `ValidationDbContext`, `[DmValidator]` | `ValidatorsController`; table и набор rules | Singleton ValidatorDbContextFactory, ValidatorStore, ValidatorService; exports `[ValidatorService]` |
| [Records](../../src/app/modules/datamanager_modules/records_module/DataManagerRecords.module.ts) | Записи динамических таблиц; `DynamicDbContext` | `DataController`; table, id, list query, динамическая запись | Scoped DynamicDbContext, RecordManager; exports `[]` |

У Tables и Fields: `validateOnSave: false`, `migrateOnStart: true`,
`registerRepositories: true`. У Validators: `migrateOnStart: true`,
`registerRepositories: false`. Records не объявляет `ormOsnova`: его динамический
контекст — отдельная scoped-регистрация. Эти различия показывают, почему не
нужно навязывать всем атомарным модулям одинаковые поля.

```text
Tables       → нет imports других частей
Validators   → Tables
Fields       → Tables, Validators
Records      → Tables, Validators
```

Например, constructor `TableService` получает `DATABASE_PROVIDER`,
`DynamicModelRegistry`, `CatalogService`, `MetadataStore`, `MetadataMutation`;
`RecordManager` — `DynamicDbContext`, `DynamicModelRegistry`, `ValidatorService`.
Точная проводка находится в декларациях модулей и
[RecordManager.ts](../../src/app/modules/datamanager_modules/records_module/services/RecordManager.ts).

### HTTP-входы четырёх частей

Все четыре контроллера объявляют доступ для `TokenKind.Admin`. Префикс `/api`
добавляет host; `table`, `field`, `name`, `id` в путях — строковые параметры,
а фактический тип ключа записи определяется динамической схемой.

| Часть | Метод и путь | Входные поля / контракт |
| --- | --- | --- |
| Tables | `GET /api/schema/tables` | `TableListQuery`: page/sort/filter; default size 50, max 200 |
| Tables | `GET /api/schema/tables/:table` | `table` |
| Tables | `POST /api/schema/tables` | `CreateDynamicTableRequest` |
| Tables | `DELETE /api/schema/tables/:table` | `table`; архивирование |
| Fields | `GET /api/schema/tables/:table/fields` | `table`, `FieldListQuery`; default size 50, max 200 |
| Fields | `POST /api/schema/tables/:table/fields` | `table`, `DynamicFieldRequest` |
| Fields | `DELETE /api/schema/tables/:table/fields/:field` | `table`, `field`; архивирование |
| Fields | `DELETE /api/schema/tables/:table/fields/:field/purge` | `table`, `field`; физическое удаление |
| Fields | `POST /api/schema/tables/:table/indexes` | `table`, `DynamicIndexRequest` |
| Fields | `DELETE /api/schema/tables/:table/indexes/:name` | `table`, `name` |
| Validators | `GET /api/schema/tables/:table/validators` | `table` |
| Validators | `PUT /api/schema/tables/:table/validators` | `table`, `ReplaceValidatorsRequest` |
| Records | `GET /api/data/:table` | `table`, параметры `parseListQuery` |
| Records | `GET /api/data/:table/:id` | `table`, `id` |
| Records | `POST /api/data/:table` | `table`, JSON-объект записи |
| Records | `PUT /api/data/:table/:id` | `table`, `id`, JSON-объект изменения |
| Records | `DELETE /api/data/:table/:id` | `table`, `id` |

Источники маршрутов и преобразования ошибок:
[TablesController](../../src/app/modules/datamanager_modules/tables_module/http/TablesController.ts),
[FieldsController](../../src/app/modules/datamanager_modules/fields_module/http/FieldsController.ts),
[ValidatorsController](../../src/app/modules/datamanager_modules/validators_module/http/ValidatorsController.ts),
[DataController](../../src/app/modules/datamanager_modules/records_module/http/DataController.ts).

### Поля определения таблицы, поля и индекса

Источник: [CreateDynamicTableRequest](../../src/app/modules/datamanager_modules/tables_module/http/contracts/CreateDynamicTableRequest.ts).
Все поля этого блока приходят из body. Ниже показаны типы, initializers и
объявленные validators; полная runtime-семантика отсутствия/null не квалифицирована.

| Поле | Тип | Объявленная обязательность / initializer | Проверки DTO |
| --- | --- | --- | --- |
| `name` | `string` | required; `""` | notEmpty, maxLength 128 |
| `schema` | `string?` | Необязательно; `undefined` | maxLength 128 |
| `tableName` | `string?` | Необязательно; `undefined` | maxLength 128 |
| `fields` | `DynamicFieldRequest[]` | required; `[]` | nested |
| `indexes` | `DynamicIndexRequest[]?` | Необязательно; `[]` | nested |
| `softDeleteProperty` | `string?` | Необязательно; `undefined` | maxLength 128 |

У элементов `fields[]` и отдельного `POST .../fields` один контракт:
[DynamicFieldRequest](../../src/app/modules/datamanager_modules/fields_module/http/contracts/DynamicFieldRequest.ts).

| Поле | Тип / initializer | Объявленные ограничения |
| --- | --- | --- |
| `name` | `string`, `""` | required, notEmpty, maxLength 128 |
| `columnName` | `string?`, `undefined` | maxLength 128 |
| `type` | enum, `"string"` | required; string, int, bigint, decimal, bool, datetime, uuid, json, foreignKey |
| `isKey`, `required`, `unique`, `indexed` | Каждое `boolean?`, `undefined` | type boolean |
| `convention` | enum?, `undefined` | uuid, createdAt, updatedAt |
| `uuidVersion` | enum?, `undefined` | v4, v7 |
| `target`, `navigationName`, `inverseNavigationName` | Каждое `string?`, `undefined` | notEmpty, maxLength 128 |

У элементов `indexes[]` и отдельного `POST .../indexes`:
[DynamicIndexRequest](../../src/app/modules/datamanager_modules/fields_module/http/contracts/DynamicIndexRequest.ts).

| Поле | Тип / initializer | Объявленные ограничения |
| --- | --- | --- |
| `name` | `string?`, `undefined` | maxLength 128 |
| `columns` | `string[]`, `[]` | required |
| `unique` | `boolean?`, `undefined` | type boolean |

Дополнительно [TableService.ts](../../src/app/modules/datamanager_modules/tables_module/services/TableService.ts)
проверяет идентификаторы, наличие колонок у индекса, обязательные `target` и
`navigationName` у foreignKey и недопустимость foreign-key metadata у скалярного
поля. Поэтому описание входа учитывает и DTO, и сервисные инварианты.

### Валидаторы и динамические записи

В [ValidatorContracts.ts](../../src/app/modules/datamanager_modules/validators_module/http/contracts/ValidatorContracts.ts)
`ReplaceValidatorsRequest.rules` — required/nested массив с initializer `[]`.
Каждый элемент содержит:

- `field: string = ""` — required, notEmpty, maxLength 128;
- `rule` — required enum с initializer `required`: required, notEmpty,
  minLength, maxLength, pattern, email, url, uuid, min, max, integer, positive, in;
- `param?: unknown = undefined` — параметр выбранного правила; допустимый вид
  проверяется в реализации правил, а не выводится из `unknown`;
- `message?: string = undefined` — необязательное сообщение, maxLength 500.

Список записей использует свой
[parseListQuery](../../src/app/modules/datamanager_modules/records_module/http/queryParser.ts),
а не формат list-запросов Users:

| Query-поле | Формат / default |
| --- | --- |
| `filter` | Повторяемое `field:operator[:value]`; отсутствует → `filters: []` |
| `sort` | Поля через запятую, `-` для descending; отсутствует → `sort: []` |
| `limit` | Положительное целое; default 50, значение выше 200 ограничивается до 200 |
| `offset` | Неотрицательное целое; default 0 |
| `fields` | Повторяемые списки через запятую; отсутствие/пустота → `undefined` |
| `include` | Повторяемые списки через запятую; в сервис передаётся как `includes` |
| `withTotal` | Только `"1"`/`"true"` дают true; иначе false |

`DataRecord` технически объявлен как `Record<string, unknown>`, но это
динамический контракт: поля определяются опубликованной схемой таблицы,
`RecordManager` проверяет поля и преобразования, `ValidatorService` — правила.
Тело HTTP-запроса должно быть обычным JSON-объектом, не массивом или `null`.
В паспорте операции нужно ссылаться на источник динамической схемы и описывать
разрешённые изменения, а не оставлять бесконтрольный `object`.

**Архитектурный вывод:** четыре части разделены по функциям, имеют разные входы,
владельцев данных и регистрацию. Технические `http/`, `model/`, `services/`
остаются внутри каждой части; самостоятельными модулями-слоями они не становятся.

## 3. Что подтверждает эта сверка

Подтверждены чтением исходников: состав деклараций, поля DTO, маршруты,
объявленные validators и зависимости. В репозитории есть
[проверки композиции DataManager](../../src/app/modules/datamanager_modules/test/datamanager.module.test.ts):
корень, граф, владельцы ORM, list-контракты и сбор контроллеров/UI.
Наличие файла тестов не означает их успешный запуск.

В рамках подготовки документов приложение, миграции и тесты с БД не запускались.
Проверка реального HTTP, DI/codegen и работы с БД остаётся отдельной проверкой
соответствующей реализации. Для нового модуля применяется полный
[шаблон паспорта](MODULE_SPEC_TEMPLATE.md), а не сокращённые таблицы этого разбора.
