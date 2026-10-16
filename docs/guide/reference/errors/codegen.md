# Ошибки кодогенерации

`bazis codegen` проверяет код до запуска. Команды `dev`, `test` и `build`
запускают кодогенерацию сами. Ошибка печатается рамкой с местом в коде,
подсказкой и кодом, а команда выходит с кодом 1:

```text
  ╭─ 1/1 [DI] src/app/greeting/Greeter.service.ts:4 ─────────────────────────────╮
  │ ✖  constructor parameter 1 of "Greeter" has type "IClock", which is neither a │
  │    DI token (createToken) nor a class known to codegen. …                     │
  │                                                                               │
  │   4 │ export class Greeter { constructor(private readonly clock: IClock) {} } │
  │     │                                                            ^^^^^^      │
  │                                                                               │
  │ ➜  register the class in a module, declare a token with createToken, …       │
  │    code BAZIS_DI_DEPENDENCY_UNKNOWN                                           │
  ╰───────────────────────────────────────────────────────────────────────────────╯
```

С `BAZIS_CODEGEN_REPORT=<файл>` те же ошибки записываются в JSON-отчёт
([Кодогенерация](../../fundamentals/codegen.md)).

Тексты получены на bazis 0.100.7, кроме отмеченных «текст из исходников».

## Зависимости

### `BAZIS_DI_DEPENDENCY_UNKNOWN`

Тип параметра конструктора не говорит, что внедрять.

Интерфейс без токена:

```text
constructor parameter 1 of "Greeter" has type "IClock", which is neither a DI token (createToken) nor a class known to codegen. Register it, import it from the framework package, or bind the class with an explicit factory.
```

Примитив:

```text
constructor parameter 1 "prefix" of "Greeter" has type "string", which cannot be injected: DI resolves dependencies by class, contract or token, and a plain type does not say which value to inject. Declare a token with the same name as a type alias (export type Prefix = string; export const Prefix = createToken<Prefix>("Prefix")) and register a value, or pass the deps explicitly: scoped(Greeter, Greeter, [TOKEN] as const).
```

- **Что сделать.** Сделайте контракт абстрактным классом — он и будет
  токеном. Для значения (строки, числа, объекта настроек) объявите токен
  с тем же именем, что у типа, и зарегистрируйте значение
  ([Провайдеры](../../overview/providers.md#интерфейс-и-токен)).

### `BAZIS_DI_CONFIG_UNKNOWN`

```text
constructor parameter 1 of "Mailer" has type "ConfigView<MailConfig>", but no defineConfig<MailConfig>(...) declaration was found. Declare the configuration with an explicit type argument, for example defineConfig<MailConfig>("name", { default: {...} }).
```

- **Причина.** `ConfigView<MailConfig>` ищет объявление
  `defineConfig<MailConfig>(...)` по типу. Его нет, или тип не указан явно
  (`defineConfig("mail", …)` без `<MailConfig>`).
- **Что сделать.** Объявите настройки с явным типом
  ([Конфигурация](../../fundamentals/configuration.md#объявление)).

### `BAZIS_DI_CONFIG_AMBIGUOUS`

```text
constructor parameter 1 of "Mailer" has type "ConfigView<MailConfig>", which matches several declarations: "mailA", "mailB". Give each declaration its own type, or pass the token explicitly: scoped(Service, Service, [config.token]).
```

- **Что сделать.** У каждого `defineConfig` — свой интерфейс. Если
  настройки действительно одинаковые, передайте токен явно:
  `scoped(Mailer, Mailer, [mailA.token])`.

### `BAZIS_DI_CONSTRUCTOR_UNRESOLVED`

```text
inherited constructor dependency "Base" has no known DI token.
cannot infer inherited constructor parameter "x" for "Child". The parameter needs a runtime DI …
```

Текст из исходников. Класс не объявляет свой конструктор, а
унаследованный от базового класса берёт параметр, для которого
кодогенерация не нашла токен — например, базовый класс из пакета без
сгенерированных зависимостей. Объявите конструктор в самом классе и
передайте параметры в `super(...)`.

### `BAZIS_DI_CLASS_UNIMPORTABLE`

```text
DI class "Hidden" must be exported (an export alias is sufficient) so constructor dependencies can bind to its exact identity.
```

Текст из исходников. Сгенерированному коду нужно импортировать класс,
чтобы привязать его зависимости. Экспортируйте класс. Класс без
зависимостей конструктора экспортировать не обязательно — проверено.

## HTTP

### `BAZIS_HTTP_BINDING_UNRESOLVED`

```text
controller "TagsController.list" (/…/src/app/tags/Tags.controller.ts): cannot infer bindings (parameter "filter" has no type annotation usable for conventions). Use supported parameter types; read headers or raw bodies through HttpContext, and inject services in the constructor.
```

- **Причина.** По типу параметра метода не понять, откуда брать
  значение: например, объединение `string | number`.
- **Что сделать.** Простые типы — из пути и строки запроса, класс с
  `@RequestModel()` — тело, `HttpContext` — всё остальное. Сервисы —
  в конструктор
  ([Контроллеры](../../overview/controllers.md#аргументы-методов)).

> [!NOTE]
> Путь в сообщении — абсолютный. Класс без `@RequestModel()` в параметре (например, `Map`) — не ошибка, а
> предупреждение: `body model "Map" was not found in scanned sources. Add
> @RequestModel() to the class.`

## ORM

### `BAZIS_ORM_PREDICATE_LOGIC`

```text
src/app/modules/tasks/services/Tasks.service.ts:31:21: ORM conditions cannot use JavaScript truthiness: JavaScript keeps only one side of && and ||. Use .and(), .or(), .not(): (p) => p.views.gt(70).and(p.authorId.eq(2)).
```

- **Причина.** В условии `where` стоит `&&` или `||`. JavaScript вычислит
  его сам и отдаст ORM только одну половину условия — запрос молча вернул
  бы не те строки.
- **Что сделать.** `.and()`, `.or()`, `.not()`:
  `where((t) => t.ownerId.eq(me.id).and(t.done.eq(false)))`
  ([Запросы](../../database/queries.md)).

## Агенты

### `BAZIS_TOOL_SCHEMA_MODEL_UNIMPORTABLE`

```text
Tool schema CreateTaskInput must be a named exported top-level class (src/app/assistant/tools.ts).
```

Текст из исходников. Схема входа инструмента агента должна быть
экспортированным классом верхнего уровня, а не классом внутри функции или
выражением ([Инструменты](../../ai/tools.md)).

## Проект и цели

### `BAZIS_CODEGEN_SOURCE_UNASSIGNED`

Предупреждение, а не ошибка:

```text
[WARN]  src/app/scenarios/di/runtime.ts is not imported from the entrypoint — skipped · import its module in the host module, or remove the file
```

Файл не импортируется из точки входа ни одной цели. Его классы
кодогенерация не видит: модуль из такого файла не подключён к
приложению. Импортируйте модуль в корневой или удалите файл.

### `BAZIS_CODEGEN_CONFIG_INVALID`

```text
✖  version=1, defaultTarget and targets are required
   code BAZIS_CODEGEN_CONFIG_INVALID
```

`bazis.config.json` не читается или в нём нет обязательных полей.
Правильная форма — в главе [Кодогенерация](../../fundamentals/codegen.md).

### `BAZIS_CODEGEN_ENTRY_NOT_IN_PROGRAM`

```text
✖  production:src/missing.ts
   code BAZIS_CODEGEN_ENTRY_NOT_IN_PROGRAM
```

Точки входа цели нет в проекте TypeScript: файла не существует или его
исключает `tsconfig.json`. Формат: `<цель>:<путь>`.

### `BAZIS_CODEGEN_TARGET_UNKNOWN`

```text
✖  Unknown codegen target: nope
```

`bazis codegen --target nope` — такой цели нет в `bazis.config.json`.
Цели: имена из `targets` и `all`.

### `BAZIS_TYPESCRIPT_API_MISSING`

```text
BAZIS_TYPESCRIPT_API_MISSING: TypeScript 7 has no compiler API, and bazis codegen needs one. Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6
```

Текст из исходников. В проекте TypeScript 7, у которого нет API
компилятора для кодогенерации. Выполните команду из сообщения.

### Внутренние коды

`BAZIS_CODEGEN_GENERATED_TARGET_INVALID`,
`BAZIS_CODEGEN_CONTROLLER_SOURCE_MISSING`,
`BAZIS_CODEGEN_DYNAMIC_EDGE_UNRESOLVED` говорят о повреждённом каталоге
`src/generated` или о внутренней ошибке кодогенерации. Удалите
`src/generated` и запустите `bazis codegen` снова; если ошибка осталась —
это ошибка bazis.

## Дальше

- [Ошибки DI](di.md)
- [Кодогенерация](../../fundamentals/codegen.md)
- [Команды CLI](../../cli/commands.md#bazis-codegen)
