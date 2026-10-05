# Osnova CLI

Версия паспорта: 1.9. Дата сверки: 2026-10-05. Тип: атомарный технический модуль.
Область: разбор команд, генерация проектов и модулей, регистрация в host, codegen,
запуск приложения и сборка (`osnv dev`, `osnv build`, `osnv build --bin`).
Точка входа: [main.ts](main.ts), функция `runCli(argv, runtime)`.
CLI выполняется отдельным процессом и не регистрируется в `AppModule`.

## Запуск и сборка

```sh
bunx osnv dev                         # codegen, затем src/index.ts из исходников (OSNV_ENV=development, если не задан)
bunx osnv dev --watch                 # то же; изменение в src/ перезапускает codegen и приложение
bunx osnv test [<аргументы bun test>]  # codegen, затем bun test
bunx osnv build                       # codegen и проверка типов (tsc --noEmit)
bunx osnv build --bin                 # + исполняемый файл bin/<имя из package.json>
bunx osnv build --bin --outfile dist/app
```

Реализация — [build.ts](build.ts). Точка входа берётся из `osnv.config.json`
(первый entrypoint цели по умолчанию), TypeScript — из `node_modules` проекта.
`dev` передаёт SIGINT/SIGTERM приложению и возвращает его код завершения.
`dev --watch` следит за `src/` рекурсивно (кроме `src/generated`, иначе codegen
перезапускал бы сам себя), склеивает события за 150 мс, останавливает
приложение, перезапускает codegen и стартует заново; при ошибке codegen ждёт
следующего изменения. `test` передаёт всё после `test` (или `test --`) в `bun test`.

`codegen` запускает генератор фреймворка напрямую, скрипт проекта не нужен:
сначала `node_modules/osnv`, затем исходник `src/osnova` (checkout фреймворка),
затем пакет самого CLI. Генератор пишет `src/generated/osnv/fingerprint.ts`:
список исходников цели, их SHA-256 и версию `osnv`. Сгенерированный `runtime.ts`
при старте из исходников сверяет их и громко предупреждает, если код или версия
фреймворка изменились после генерации (около 10 мс на 750 файлов). В бинарнике
исходников нет — проверка пропускается. В репозитории фреймворка `fingerprint.ts`
не коммитится: он меняется с каждой правкой исходников.
`build --bin` компилирует из временного каталога (`compileBinary`): Bun 1.4.0
оставляет `.bun-build` в рабочем каталоге, если его исполняемый файл read-only
или помечен `uchg`. Bun для дочерних процессов — `scripts/osnova-bun`, иначе
`OSNV_BUN_BIN`, иначе `bun` из PATH.

Команда `agent run` (клиент чат-API приложения) перенесена в приложение:
`bun run agent:run` и `src/app/modules/agent-chat/client/AgentClient.service.ts`.
Фреймворк не знает об адресах и cookie конкретного приложения.

## Ответственность и компоненты

CLI создаёт каркас по [MOD-ARCH-001](../../../docs/architecture/MODULE_ARCHITECTURE.md).
По обязательному правилу §8.1 все новые модули приложения и фреймворка, включая
составные корни и их атомарные части, создаются командами CLI. Автор дорабатывает
созданный каркас, заполняет паспорт и записывает фактическую команду создания.
Если нужного варианта нет или генератор ошибается, сначала дорабатывается CLI.
Ручное создание или копирование каркаса вместо CLI запрещено.
Предметные поля CRUD — учебные `name`/`email`; автор заменяет их и обновляет паспорт.
`full` остаётся атомарным модулем. `pack` содержит независимые пустые атомарные части.

**Переход Agent/Module:** по [AGENT-ARCH-001](../../../docs/architecture/AGENT_ARCHITECTURE.md)
агенты создаются отдельно от модулей. Текущий `--full` ещё генерирует
AnalystAgent внутри модуля и поле `@Module.agents`; это известное расхождение
с целевой архитектурой. Разделение генерации входит в первый этап доработки.
Отдельной команды генерации агента сейчас нет. Таблицы ниже описывают действующий
CLI; шаблон `--full` этим шагом не менялся. AgentsModule создан штатным `--empty`.

Проектный OpenAPI codegen теперь учитывает унаследованные свойства DTO, включая
пустой RequestModel-подкласс импортированного входного контракта. Валидаторы берутся
из исходных деклараций базового класса. Без наследования сохраняется прежний
быстрый путь анализа members. Исправление находится в
[OpenAPI analyzer](../library/openapi/codegen.ts) и вызывается штатным
[di-generate](../core/scripts/di-generate.ts); результат обновляется только генератором.

Agent-схемы (R4, 2026-10-04) используют ту же функцию именования OpenAPI analyzer
для реальных объявлений входных/выходных DTO. Отбор схем сохраняет входы/выходы
Agent, Task, Tool и их ссылки; constructor → schema связи корневых и вложенных
class DTO дополняют существующий `GENERATED_OPENAPI_SCHEMA_MODELS`.
Одноимённый независимый интерфейс больше не приводит к потере схемы класса.
Неимпортируемый связанный class DTO отклоняется с
`OSNV_AGENT_SCHEMA_MODEL_UNIMPORTABLE` до записи generated-файлов.
Прежние ограничения Agent collector на неоднозначные class-имена и named exports
сохраняются. Публичные команды и входные DTO этого CLI не меняются.
Проверка [Agent standalone integration](../core/agent/test/agent.standalone.integration.test.ts)
выполняет настоящий codegen, типизацию, source и binary для копии пакета вне checkout.

DI-codegen (D3, 2026-10-02) хранит классы по точному объявлению TypeScript,
поэтому одноимённые сервисы разных файлов одного target допустимы. В generated
descriptor попадают уникальные import aliases на конкретные конструкторы;
поддерживаются export alias/default и переименование импортированных типов
зависимостей через re-export. Named-зависимости связывает существующий DI
в области видимости модуля. Два одноимённых видимых named-токена остаются явной
неоднозначностью, а приватные токены разных модулей не смешиваются.
Программа TypeScript и target pipeline остаются общими; runtime-компилятор
не добавляется. Экспортируемые классы-зависимости, включая Lazy, передаются
точными constructor-токенами: переименование при bundling не меняет identity.
Интерфейсы/IRepository остаются named; runtime принимает и прежние строковые
descriptors. Проверка: `di-class-identity.integration.test.ts` выполняет
генерацию, типизацию, DI и compiled-приложение из другого cwd.

DI-codegen также выводит зависимости унаследованного конструктора с подстановкой
generic-параметров и связывает их с конкретным наследником. Собственный constructor
и явно заданные deps сохраняют приоритет. Локальные неэкспортируемые helpers
пропускаются; private class в обычной DI-регистрации без собственной metadata
получает `OSNV_DI_CLASS_UNIMPORTABLE` до записи generated-файлов. Достаточно
экспортировать класс или его alias, чтобы продолжить обычную автоматическую
привязку. Подробности и проверка binary — в [паспорте DI](../core/di/MODULE.md).

| Компонент | Файл | Вход | Выход / эффект |
| --- | --- | --- | --- |
| `parseCliArgs` | [parseCli.ts](parseCli.ts) | `readonly string[]` | Команда, справка или ошибка; без I/O |
| `generateProject` | [generateProject.ts](generateProject.ts) | Имя, путь, локальный пакет фреймворка, dry-run | Отдельный стартовый проект или план файлов |
| `parseModuleName` | [naming.ts](naming.ts) | Строка имени | Имена каталогов, классов, маршрута и таблицы |
| `generateModule` / `generateModulePack` | [generateModule.ts](generateModule.ts) | Опции генерации | План файлов; запись, если не dry-run |
| `registerModuleInSource` | [moduleRegistration.ts](moduleRegistration.ts) | Исходник host, абсолютные пути, класс | TypeScript с импортом и регистрацией |
| Шаблоны | [templates/module.ts](templates/module.ts), [templates/pack.ts](templates/pack.ts), [templates/passport.ts](templates/passport.ts) | Нормализованное имя и профиль | Файлы и `MODULE.md` |
| `runCodegen` | [codegen.ts](codegen.ts) | cwd и target | Запуск проектного `di:generate`, код завершения |
| `runDev`, `runBuild`, `compileBinary` | [build.ts](build.ts) | cwd, `{ bin, outfile }`, функция codegen | Запуск приложения; проверка типов; исполняемый файл без `.bun-build` в проекте |

DI, ORM, HTTP, AI и background самого CLI не используются. Генерируемые модули
подключают существующие публичные ORM/DI API; зависимости конструкторов связывает codegen.

## Команды и входные поля

```sh
bunx osnv --help
bunx osnv new MyApp --dry-run
bunx osnv new MyApp
bunx osnv g module Task --dry-run
bunx osnv g m Guest --no-codegen
bunx osnv g module Mailer --empty --no-register
bunx osnv g module Catalog --full --no-codegen
bunx osnv g pack DataManager --parts tables,fields,validators,records --dry-run
bunx osnv codegen --target production
```

В этом репозитории команды Bun выполняются через `scripts/osnova-bun` с
квалифицированным `OSNV_BUN_BIN` (`./scripts/osnova-bun run osnv …`).
Скомпилированный CLI: `bin/osnv`. В созданном проекте скрипты `dev`, `build`,
`build:bin`, `codegen` — обёртки над `osnv dev|build|build --bin|codegen`.

| Поле | Тип / источник | Обязательность / default | Проверка / поведение |
| --- | --- | --- | --- |
| command | positional string | Обязательно | `g` / `generate`, `codegen` |
| `new <Name>` | positional string | Для нового проекта | Создаёт независимую папку с kebab-case именем; правила имени как у модулей |
| `--path` | path string | Только `new`, default `./<kebab-name>` | Точный путь нового каталога; родитель должен существовать, существующий каталог не перезаписывается |
| `--framework` | path string | Только `new`, default `./src/osnova` или пакет рядом с исходным CLI | Локальный пакет `osnova` с CLI и codegen; по умолчанию копируется в `vendor/osnv` |
| `--link-framework` | flag | Только `new`, false | Вместо копии сохранить относительную `file:`-ссылку на внешний checkout; требует его при переносе |
| generator | positional string | Для `g` | `module` / `m`; `pack` / `p` / `module-pack` |
| name | positional string | Для `g` | Латинская буква, затем буквы/цифры; части через одиночный дефис |
| `--parts` | CSV string | Только pack, обязательно | Не менее 2 непустых разных частей, имена как у модуля |
| `--modules-root` | path string, cwd | `src/app/modules` | Непустое значение; разрешён абсолютный путь |
| `--app-module` | path string, cwd | `{modules-root}/App.module.ts` | Импорт вычисляется относительно этого файла |
| `--empty` | flag | false | Только module: точка подключения и паспорт |
| `--minimal` | flag | true | Только module: CRUD и паспорт |
| `--full` | flag | false | Только module: CRUD/list/cache/auth/background/AI; старый алиас `--enterprise`. `@Authorize` генерируется, если в проекте есть `src/app/modules/auth/{tokenKinds,jwtAuth}.ts`; иначе маршруты публичные и CLI предупреждает. Для запуска host нужен кэш (`runApp({ cache: memory() })`) и provider БД |
| `--no-register` | flag | false | Пропустить host и автоматический codegen |
| `--no-codegen` | flag | false | Создать и подключить, не запускать codegen |
| `--target` | string | Проектный default | Имя из `osnv.config.json` или `all`; для codegen или генерации с регистрацией |
| `--dry-run` | flag | false | Прочитать и проверить план, не писать и не запускать codegen |
| `--force` | flag | false | Разрешить перезапись файлов каркаса, включая паспорт; чужие файлы не удаляются |
| `-h`, `--help` | flag | false | Справка в любой позиции; без записи и codegen |

CLI не принимает null. Пропущенные значения флагов, неизвестные опции, лишние
позиционные аргументы и конфликтующие профили отклоняются до записи.
`--target` несовместим с `--no-codegen` и `--no-register`.
Имя target следует проектному codegen: строчная латинская буква, затем строчные
буквы, цифры и дефисы. `all` выбирает все настроенные targets.

`new` принимает только `--path`, `--framework`, `--link-framework`, `--dry-run` и `--help`. Он не
запускает установку пакетов, codegen или приложение. Создаёт `package.json`,
`tsconfig.json`, `osnv.config.json`, `.gitignore`, `AGENTS.md`, локальную
архитектурную памятку, `README.md`,
`src/index.ts` и корневой `App.module.ts`. Корень приложения — композиция с
`imports: []`, без предметного модуля. Вход HTTP слушает loopback на порту
`PORT` (по умолчанию 3000) и включает `/health`. Генерация модулей остаётся
командой `bunx osnv g module ...` в новом проекте; для первой функции
без готовой БД подходит `--empty`. DI-экспорты корня: `[]`; TypeScript-вход —
`src/index.ts`; опубликованный HTTP-вход — `/health`.

По умолчанию новый проект получает снимок пакета в `vendor/osnv` и зависимость
`file:./vendor/osnv`. Переносится весь проект, включая vendor; исходный checkout
больше не нужен. В снимок входят index.ts, package.json, core, library, cli,
LICENSE и README.md; node_modules, тесты, скрытые файлы и compile scratch исключены.
Симлинк внутри копируемых исходников — явная ошибка до публикации проекта.
Снимок не обновляется автоматически. Режим `--link-framework` сохраняет прежнюю
связь с живым checkout для совместной разработки. С 0.96.1 пакет называется
`osnv` и готовится к публикации в npm: проект импортирует фреймворк по имени
пакета (`osnv/core/di`), поэтому сгенерированный `tsconfig.json` не содержит
алиасов `@/*` и `@osnova/*`. Скомпилированному CLI вне checkout нужно
передать `--framework`. Исходный пакет не меняется. `dry-run` возвращает число
файлов снимка, но ничего не записывает; CLI не печатает сотни путей vendor.

Профили module: `empty` — 2 файла; `minimal` — 10; `full` — 14, включая паспорт.
В `full` Tool регистрируется один раз в `tools`; scoped provider создаёт
модульное расширение Agent API. Повторной записи в `providers` нет.
Пакет с N частями — 2 + 2N файлов. CRUD использует RequestModel и email-validator;
оба CRUD-профиля создают getAll(query): PageResult с пагинацией (HTTP: 20 по
умолчанию, максимум 100). Контроллер собирает JSON:API; summary возвращает общее
count и максимум 20 имён в порядке id. Сервис получает DbContext через codegen
и вызывает db.saveChanges() для всех изменений контекста. IRepository API не
менял семантику. У `full` кэш сбрасывается после успешной записи. HTTP Location и ссылки списка
берут фактический префикс host. Startup-флаги ORM не задаются: host обеспечивает
готовность схемы. `--full` проверяет наличие auth helpers до записи, относительные
импорты учитывают выбранный каталог и реальные пути за симлинками.

## Результаты, эффекты и ошибки

Генераторы возвращают `moduleDir`, `files`, `registered`, `dryRun`, `changes`
(`path`, `action: create | update`) и `warnings`. Пути файлов в отчёте относительны cwd.
В dry-run `registered` отражает план; в обычном запуске — итоговую регистрацию.
Папка пакета: `{kebab-name}_modules`, часть: `{kebab-part}_module`.
Имена по модулю, как его ввели (`g module Stats`). Имя файла — имя класса,
у которого роль вынесена в суффикс: `StatsController` → `http/Stats.controller.ts`,
`StatsListQuery` → `http/contracts/StatsList.query.ts`, `StatsSummaryTool` →
`ai/tools/StatsSummary.tool.ts`. Полный состав: `Stats.module.ts`,
`model/Stats.model.ts`, `model/Stats.dbContext.ts`, `services/IStats.service.ts`,
`services/Stats.service.ts`, `http/Stats.controller.ts`,
`http/contracts/Stats.requests.ts`, `Stats.responses.ts`, `StatsList.query.ts`;
в `--full` ещё `background/Stats.reporter.ts`, `ai/agents/StatsAnalyst.agent.ts`,
`ai/tools/StatsSummary.tool.ts`, `ai/contracts/Stats.brief.ts`. Классы ролей:
`StatsModule`, `StatsController`, `IStatsService`/`StatsService`, `StatsDbContext`,
`StatsListQuery`, `StatsReporter`, `StatsSummaryTool`, `StatsAnalystAgent`.
Единственное число остаётся у записи и её DTO: `class Stat`, `CreateStatRequest`,
`StatResponse`; маршрут `/stats`. До 0.96.1 имена строились от сущности
(`StatController.ts`, `StatService`). Части пакета, совпадающие в единственном
числе (`records,record`), отклоняются. Это ограниченные правила английских имён,
не универсальный словарь.

Существующая папка без `--force` — ошибка. Host проверяется до записи файлов.
Регистрация поддерживает объект `@Module` с литеральным массивом `imports`
(либо добавляет отсутствующее поле); динамические метаданные требуют ручного
подключения. Комментарии не считаются регистрацией. Повторное подключение не
дублирует импорт. При отсутствии host выводится предупреждение, файлы создаются,
автоматический codegen пропускается. Регистрация в host не доказывает его
достижимость из выбранного target; её проверяет проектный codegen.

Каждый файл записывается через временный файл и rename. При ошибке записи
выполненные изменения откатываются; это не транзакция для параллельных читателей.
Codegen запускается после записи; его ошибка сохраняет каркас для исправления
и возвращает ненулевой код. Общая успешная команда возвращает 0, ошибка CLI — 1,
ошибка codegen — код дочернего процесса. Повторы автоматом не выполняются.

`new` готовит содержимое во временной папке рядом с итоговым каталогом и
публикует её переименованием после проверки; при ошибке временные файлы
удаляются. Существующий итоговый путь — ошибка без изменения файлов. Проектный
codegen исключает исходники установленного фреймворка вне корня приложения и
не записывает framework-shim-файлы в проект без локального `src/osnova`.

## Проверки

Регрессии находятся в [test](test). Проверки запускаются в временных каталогах;
живое приложение, PostgreSQL и LLM для проверки CLI не нужны.
Историческая проверка генератора: исходная база 15 PASS / 0 FAIL, затем 93 PASS / 0 FAIL,
361 assertions в 6 файлах. Команда (после настройки OSNV_BUN_BIN):

```sh
./scripts/osnova-bun test --isolate ./src/osnova/cli/test
```

Проверены разбор CLI, отсутствие эффектов help/dry-run, регистрация TypeScript,
откат записи, сохранение чужих файлов при force, структура и ссылки паспортов,
типы всех генерируемых профилей против текущего API, кэш и HTTP-префикс.
[Интеграционная проверка](test/codegen.integration.test.ts) запускает настоящий
codegen в копии фреймворка и проверяет DbContext DI, HTTP и AI metadata.
Также собран и проверен отдельный бинарник CLI во временном каталоге.
TypeScript-проверка CLI и его тестов с публичными декларациями фреймворка — PASS.
При текущей интеграции Agents: общий `build` — PASS; отдельный CLI binary build
и `bin/osnova --help` — PASS. Реальная интеграция CLI/codegen — 1/1 PASS,
full-scan codegen — 10/10 PASS. Для full-scan понадобился test timeout 30000 ms:
один процесс генерации превысил исходный лимит 5000 ms; исходный отказ не считается
успехом. Унаследованные DTO и существующий Product UiProfile также проверены.
Полные команды и свидетельства — в [отчёте Agents](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agents-module-2026-09-20.md).

### Доработка удобства API, 2026-10-03

Проверка затронутых CLI/ORM/HTTP/DI и сервисов приложения: 247 уникальных тестов
в 29 файлах. Общий прогон: 244 PASS, 3 тайм-аута на сильно загруженном хосте;
отдельный повтор этих трёх тестов с тем же лимитом 30000 ms: 3 PASS / 0 FAIL.
TypeScript всего проекта и codegen production/test — PASS. Для двух full-scan
тестов, запускающих компилятор, установлен явный лимит 30000 ms вместо 5000 ms;
проверяемые условия сохранены. Стандартная команда test исключает browser specs.

[standalone-runtime.integration.test.ts](test/standalone-runtime.integration.test.ts)
собирает CLI, создаёт проект со снимком vendor, переносит его, генерирует модуль,
проверяет типы и запускает исходник и собранное приложение из другого cwd — PASS.
Основной бинарник приложения также собран; config check из внешнего каталога:
52 settings, PASS, без создания клиентов. Проверены loopback HTTP-конвенции.
Физические PostgreSQL, LLM и production-нагрузка в этот прогон не входят.

Регрессии ограничений выборки и сохранения кэша:
[templates.test.ts](test/templates.test.ts). Привязка контекста и маршрутов:
[codegen.integration.test.ts](test/codegen.integration.test.ts). Ошибки генерации:
[codegen-dx.integration.test.ts](../core/scripts/test/codegen-dx.integration.test.ts).
Команды выполнялись через квалифицированный scripts/osnova-bun; для compiler-
интеграций используется test --isolate --timeout 30000 с точными путями ./src/… .
