# Команды CLI

CLI `bazis` устанавливается вместе с пакетом. Команды запускаются из
корня проекта:

```sh
bunx bazis <команда> [опции]
```

В `package.json` нового проекта уже есть скрипты: `bun run dev`,
`bun run test`, `bun run build`, `bun run build:bin`, `bun run codegen`.

Все примеры проверены на bazis 0.100.2.

| Команда | Что делает |
| --- | --- |
| `bazis new <Имя>` | Создаёт проект |
| `bazis g module <Имя>` | Создаёт атомарный модуль и подключает его |
| `bazis g pack <Имя> --parts a,b` | Создаёт составной модуль из независимых частей |
| `bazis codegen` | Обновляет сгенерированный код в `src/generated/bazis` |
| `bazis dev [--watch]` | Кодогенерация, затем запуск приложения из исходников |
| `bazis test [аргументы]` | Кодогенерация, затем `bun test` |
| `bazis build [--bin]` | Кодогенерация и проверка типов; с `--bin` — исполняемый файл |

`g` можно писать как `generate`, `module` — как `m`, `pack` — как `p`.
Справка — `bazis --help`; `--help` в любом месте команды только печатает
справку и ничего не меняет. Версия пакета — `bazis --version` (или `-v`).

Перед каждой командой CLI проверяет версию Bun: на Bun старше 1.4.0 команда
не выполняется ([Старый Bun в PATH](../introduction/why-bun.md#старый-bun-в-path)).

## Вывод

Каждая команда печатает экран: логотип с названием команды, проект и
версии, затем шаги со счётчиками и временем, в конце — баннер **SUCCESS**
или **FAILED**:

```text
  █▀▀▄ ▄▀▀▄ ▀▀▀█ ▀█▀ █▀▀▀    [BUILD]  shop 0.1.0
  █▀▀▄ █▀▀█ ▄▀▀  ░█░ ▀▀▀█    bazis 0.100.2 · bun 1.4.0
  ▀▀▀  ▀  ▀ ▀▀▀▀ ▀▀▀ ▀▀▀▀    target typecheck

  ── BUILD ───────────────────────────────────────────────────────────────
  [OK  ]  codegen         17 files · 3 deps · 1 controller · 2 request models  685 ms
    └─ src/generated/bazis/ bindings · deps · fingerprint · httpListModels · …
  [OK  ]  typecheck       no type errors                                 2.4 s

  ════════════════════════════════════════════════════════════════════════
    ✔  SUCCESS   build is ready · 3.2 s
  ════════════════════════════════════════════════════════════════════════
```

В терминале экран цветной, с анимацией долгих шагов и кликабельными
ссылками. Если вывод идёт не в терминал — в файл, в CI, в конвейер, — та
же структура печатается простым текстом, без цвета и анимации. Цвет
управляется как в других утилитах: `NO_COLOR=1` выключает его,
`FORCE_COLOR=1` включает и без терминала.

### Язык

Вывод — на английском или русском. Язык выбирается по первому
заданному источнику:

1. флаг `--lang ru` (или `--lang=ru`) в любом месте команды;
2. переменная `BAZIS_LANG`;
3. поле `"language"` в `bazis.config.json` — `bazis new` записывает туда
   язык системы;
4. язык системы (`LC_ALL`, `LC_MESSAGES`, `LANG`);
5. английский.

Переводятся заголовки, статусы и подсказки. Имена из кода, пути,
переменные окружения и текст ошибок драйверов остаются как есть:

```text
  ── ИНФРАСТРУКТУРА ──────────────────────────────────────────── 1 проблема
  [ОШИБКА  ]  подключения     1 из 1 не подключились
    └─ [СБОЙ    ]  db       PostgreSQL   cannot connect to PostgreSQL at 127.0.0.1:56999 …

  ════════════════════════════════════════════════════════════════════════
    ✖  ПРОВАЛ   инфраструктура недоступна · 1 из 1 подключения
  ════════════════════════════════════════════════════════════════════════
```

Тот же язык получает запущенное приложение: `bazis dev` передаёт его
через `BAZIS_LANG`.

## `bazis new`

```sh
bunx bazis new Shop             # проект в ./shop
bunx bazis new Shop --path apps/shop
bunx bazis new Shop --dry-run   # показать файлы, ничего не записывать
```

```text
  ── PROJECT ─────────────────────────────────────────────────────── shop
  [OK  ]  files           11 files
    ├─ + package.json
    ├─ + tsconfig.json
    ├─ + bazis.config.json
    …
    └─ + README.md

  ◆  bazis ^0.100.2 from npm

    ✔  SUCCESS   project Shop is created

  │ 1  cd shop
  │ 2  bun install                     install dependencies
  │ 3  bunx bazis dev                  start in development mode
  │ 4  http://127.0.0.1:3000/health    open in the browser
```

| Опция | Что делает |
| --- | --- |
| `--path <каталог>` | Каталог проекта; по умолчанию `./<имя>` |
| `--framework <каталог>` | Взять bazis из локальной копии вместо npm |
| `--vendor` | Скопировать пакет в `vendor/bazis` вместо зависимости из npm |
| `--link-framework` | Зависимость `file:` на локальную копию |
| `--dry-run` | Только показать план |

Подробнее о структуре проекта — в главе [Установка](../introduction/installation.md).

## `bazis g module`

Атомарный модуль — одна самостоятельная функция со своими данными,
сервисами и обработчиками. Команда создаёт файлы, подключает модуль в
`App.module.ts` и запускает кодогенерацию:

```sh
bunx bazis g module Tasks --empty     # модуль и MODULE.md
bunx bazis g module Orders            # пример CRUD (--minimal, по умолчанию)
bunx bazis g module Orders --full     # CRUD, список, кэш, доступ, фоновая задача, инструмент агента
```

```text
  ── FILES ──────────────────────────────────────────── src/app/modules/orders
  [OK  ]  files           11 changes
    ├─ + src/app/modules/orders/Orders.module.ts
    ├─ + src/app/modules/orders/model/Orders.model.ts
    …
    ├─ + src/app/modules/orders/MODULE.md
    └─ ~ src/app/modules/App.module.ts

  ↗  connected in src/app/modules/App.module.ts
  ◆  this module uses a database: connect one with @Infra({ db: ormBazisConnect(dbConfig) })

  ── BUILD ───────────────────────────────────────────────────────────────
  [OK  ]  codegen         12 files · 3 deps · 1 controller · 2 request models · 1 list  596 ms

    ✔  SUCCESS   module Orders is generated
```

`+` — новый файл, `~` — изменённый. Строка `◆` говорит, что нужно
модулю для запуска: примерам `--minimal` и `--full` нужна база данных
([подключение](../database/postgresql.md)), примеру `--full` — ещё и кэш
(`runApp(AppModule, { cache: memory() })`).

| Опция | Что делает |
| --- | --- |
| `--empty` / `--minimal` / `--full` | Что создать; по умолчанию `--minimal` |
| `--dry-run` | Показать файлы и правку модуля-хозяина, ничего не записывать |
| `--no-register` | Не подключать модуль и не запускать кодогенерацию |
| `--no-codegen` | Подключить, но не запускать кодогенерацию |
| `--target <цель\|all>` | Цель кодогенерации |
| `--modules-root <каталог>` | Корень модулей; по умолчанию `src/app/modules` |
| `--app-module <файл>` | Модуль-хозяин; по умолчанию `<корень>/App.module.ts` |
| `--pack <Имя>` | Добавить модуль частью составного модуля |
| `--force` | Перезаписать файлы, включая `MODULE.md` |

Имя — латинские буквы, цифры и дефисы, первой идёт буква.

### Модуль без подключения

С `--no-register` модуль создаётся, но никто его не импортирует.
Кодогенерация его пропускает и предупреждает — остальной проект
собирается:

```text
  [WARN]  not connected — codegen skips it until a module imports it
```

```text
  [OK  ]  codegen         15 files · 3 deps · 1 controller · 2 request models · 1 list  557 ms
  [WARN]  src/app/modules/billing/Billing.module.ts is not imported from the entrypoint — skipped ·
          import its module in the host module, or remove the file
```

> [!NOTE]
> До версии 0.100 такой файл останавливал кодогенерацию всего проекта.

## `bazis g pack`

Составной модуль — несколько независимых функций под общим корнем:

```sh
bunx bazis g pack Catalog --parts items,prices
bunx bazis g module Discounts --empty --pack Catalog   # ещё одна часть
```

```text
  ── FILES ───────────────────────────────────── src/app/modules/catalog_modules
  [OK  ]  files           7 changes
    ├─ + src/app/modules/catalog_modules/Catalog.module.ts
    ├─ + src/app/modules/catalog_modules/MODULE.md
    ├─ + src/app/modules/catalog_modules/items_module/Items.module.ts
    ├─ + src/app/modules/catalog_modules/items_module/MODULE.md
    ├─ + src/app/modules/catalog_modules/prices_module/Prices.module.ts
    ├─ + src/app/modules/catalog_modules/prices_module/MODULE.md
    └─ ~ src/app/modules/App.module.ts

    ✔  SUCCESS   pack Catalog is generated
```

Частей — не меньше двух, части создаются пустыми. Когда нужен атомарный
модуль, а когда составной, — в главе
[Архитектура модулей](../fundamentals/module-architecture.md).

## `bazis codegen`

Обновляет сгенерированный код: зависимости конструкторов, привязки
маршрутов, модели запросов, OpenAPI. `dev`, `test`, `build` и `g module`
запускают его сами; вручную он нужен после правок, если приложение
запускается без CLI.

```sh
bunx bazis codegen                   # цель по умолчанию
bunx bazis codegen --target all      # все цели bazis.config.json
```

Если кодогенерация не может понять код, она показывает место и что
сделать:

```text
  [FAIL]  codegen         1 error                                       639 ms

    ✖  FAILED   codegen failed · 1 error

  ╭─ 1/1 [DI] src/app/modules/stats/Stats.service.ts:5 ─────────────────────╮
  │ ✖  constructor parameter 1 of "StatsService" has type "SQL", which is    │
  │    neither a DI token (createToken) nor a class known to codegen. …      │
  │                                                                          │
  │   3 │ export class StatsService {                                        │
  │   4 │   constructor(                                                     │
  │   5 │     private readonly sql: SQL,                                     │
  │     │                           ^^^                                      │
  │   6 │   ) {}                                                             │
  │                                                                          │
  │ ➜  inject IPostgres from bazis/core/infra instead of Bun's SQL           │
  │    code BAZIS_DI_DEPENDENCY_UNKNOWN                                      │
  ╰──────────────────────────────────────────────────────────────────────────╯
```

Коды ошибок и цели — в главе [Кодогенерация](../fundamentals/codegen.md).

## `bazis dev`

Кодогенерация всех целей, затем запуск точки входа из исходников со
средой `development` (если `BAZIS_ENV` не задана в оболочке):

```sh
bunx bazis dev
bunx bazis dev --watch         # перезапуск при изменениях в src/
PORT=3100 bunx bazis dev       # другой порт
```

С `--watch` изменение в `src/` (кроме `src/generated`) останавливает
приложение, заново запускает кодогенерацию и приложение:

```text
  ↻  src/app/modules/tasks/Tasks.module.ts changed — restarting

  ── BUILD ───────────────────────────────────────────────────────────────
  [OK  ]  codegen         17 files · 3 deps · 1 controller · 2 request models  595 ms
  …
    ✔  SUCCESS   shop is running · ready in 53 ms
```

Если кодогенерация не прошла, `--watch` ждёт следующего сохранения.

### Экран запуска

После сборки приложение само продолжает экран — что оно настроило,
подключило и запустило:

```text
  ── CONFIGURATION ──────────────────────────────── environment: development
  [OK  ]  config          1 section · 1 secret from dev default         0.3 ms
    └─ db        host 127.0.0.1 · port 55432 · database cli_shop · username postgres
       └─ password ← development default (set BAZIS_DB__PASSWORD in production)

  ── INFRASTRUCTURE ──────────────────────────────────────────────────────
  [OK  ]  connections     1 of 1 up                                      26 ms
    └─ [UP  ]  db       PostgreSQL 17.11    postgres@127.0.0.1:55432/cli_shop · pool 10 · 25 ms

  ── DATABASE SCHEMA ─────────────────────────────────────── ensureCreated
  [OK  ]  schema          2 operations · 1 database context               21 ms
    ├─ + create table orders
    └─ + create unique index ix_orders_email on orders (email)

  ── MODULES ──────────────────────────────────────────── 6 modules · 5 routes

     ◉ AppModule
     ├─ TasksModule
     │  └─ empty — add providers, controllers or tools
     ├─ OrdersModule
     │  ├─ ⇄ controller OrdersController · /orders · 5 routes
     │  ├─ ◆ service    IOrdersService → OrdersService · scoped
     │  ├─ ▦ table      Order · OrdersDbContext
     │  └─ ↗ exports    IOrdersService
     └─ CatalogModule [PACK]
        ├─ ItemsModule
        │  └─ empty — add providers, controllers or tools
        └─ PricesModule
           └─ empty — add providers, controllers or tools

  ── ROUTES ─────────────────────────────────────────────── 5 routes · 5 open

     GET      /orders            OrdersController.list     ○ open
     GET      /orders/:id(uuid)  OrdersController.getById  ○ open
     POST     /orders            OrdersController.create   ○ open
     PUT      /orders/:id(uuid)  OrdersController.update   ○ open
     DELETE   /orders/:id(uuid)  OrdersController.delete   ○ open
     plus GET /health · GET /docs · GET /docs/openapi.json

  ── WARNINGS ─────────────────────────────────────────────────────────── 2
  [WARN]  5 routes are open — no @Authorize. Protect them before production.
  [WARN]  db.password uses the development default from the code.

  ── STARTUP ─────────────────────────────────────────────── memory 58.6 MB
     configuration     #.............................................    0.3 ms
     container         ###...........................................      2 ms
     infrastructure    #################################.............     26 ms
     schema            #.............................................    0.2 ms
     services          ###...........................................      2 ms

    ✔  SUCCESS   shop is running · ready in 36 ms

  │ ➜  Local      http://127.0.0.1:3000
  │ ➜  Network    not exposed — listening on 127.0.0.1 (set HOST=0.0.0.0)
  │ ➜  Health     http://127.0.0.1:3000/health
  │ ➜  OpenAPI    http://127.0.0.1:3000/docs
  │
  │ logs below · Ctrl+C to stop

  ─── logs ───────────────────────────────────────────────────────────────
```

| Раздел | Что показывает |
| --- | --- |
| CONFIGURATION | Разделы настроек со значениями; секреты скрыты, рядом — откуда взялись |
| INFRASTRUCTURE | Каждое подключение: продукт и версия, адрес без пароля, время |
| DATABASE SCHEMA | Что `ensureCreated` или миграции изменили в базе |
| MODULES | Модули приложения: контроллеры, сервисы, таблицы, фоновые задачи, инструменты, экспорт |
| ROUTES | Маршруты: метод, путь, обработчик; `○ open` — без `@Authorize`, `🔒` — защищён |
| WARNINGS | Открытые маршруты, секреты из кода, предупреждения схемы |
| STARTUP | Сколько занял каждый этап, память процесса |

Подключения из `@Infra` проверяются одновременно. Разделы без данных —
например, схема без `ensureCreated` — не печатаются.

### Если запуск не удался

Экран показывает, на каком этапе остановился запуск, и пропускает
следующие с причиной. Под баннером **FAILED** — по панели на каждую
проблему: где, что случилось и что изменить.

Конфигурация — сразу все неверные ключи с переменными и файлом
объявления:

```text
  ── CONFIGURATION ─────────────────────────────────────────── 1 problem
  [FAIL]  config          1 problem
    └─ db        password

  ── MODULES ─────────────────────────────────────────────────────────────
  [SKIP]  modules         not checked — configuration is invalid

    ✖  FAILED   configuration is invalid · 1 problem

  ╭─ 1/1 [CONFIG] db.password ───────────────────────────────────────────╮
  │ ✖  required secret is not set                                         │
  │                                                                       │
  │ ➜  set BAZIS_DB__PASSWORD, or a file in a secretFilesSource directory │
  │    declared in src/app/config/db.config.ts:3                          │
  ╰───────────────────────────────────────────────────────────────────────╯

  exit code 1 · nothing was started
```

Модуль с базой данных, но без подключения:

```text
  ╭─ 1/1 [DI] DatabaseProvider ──────────────────────────────────────────╮
  │ ✖  no database is connected, but OrdersDbContext uses one             │
  │    Missing dependency "DatabaseProvider"                              │
  │                                                                       │
  │ ➜  connect a database: @Infra({ db: ormBazisConnect(dbConfig) })      │
  ╰───────────────────────────────────────────────────────────────────────╯
```

Подключение — с адресом и переменными, которые стоит проверить:

```text
  ── INFRASTRUCTURE ─────────────────────────────────────────── 1 problem
  [FAIL]  connections     1 of 1 connections failed
    └─ [DOWN]  db       PostgreSQL   cannot connect to PostgreSQL at 127.0.0.1:55432 …

  ╭─ 1/1 [INFRA] db · postgres@127.0.0.1:55432/cli_shop ─────────────────╮
  │ ✖  cannot connect to PostgreSQL at 127.0.0.1:55432 (database          │
  │    "cli_shop", user "postgres"): password authentication failed for   │
  │    user "postgres" (28P01)                                            │
  │                                                                       │
  │ ➜  check the user and password: BAZIS_DB__USERNAME, BAZIS_DB__PASSWORD │
  ╰───────────────────────────────────────────────────────────────────────╯
```

Если упало несколько подключений, панелей несколько: все проблемы
видны за один запуск.

### Экран без CLI

Экран печатает само приложение, поэтому он есть и при запуске
`bun run src/index.ts` в терминале. Он следует за опцией `startupReport`:
включён вне production. Без терминала — в Docker, под systemd, в CI —
приложение пишет одну строку журнала, как раньше:

```text
info: bazis started {"environment":"development","debug":true,"configKeys":2,…,"startupMs":66.8}
```

а при ошибке — `[bazis] configuration error: …` или
`[bazis] application failed: …`. `BAZIS_UI=1` включает экран и без
терминала, `BAZIS_UI=0` выключает его в терминале.

> [!NOTE]
> Без `bazis dev` среда по умолчанию — production: `bun run src/index.ts`
> требует секреты production. Для разработки задайте `BAZIS_ENV=development`
> или запускайте через `bazis dev`.

## `bazis test`

Кодогенерация всех целей, затем `bun test`. Аргументы после `test`
передаются `bun test` как есть:

```sh
bunx bazis test
bunx bazis test src/app/modules/orders --timeout 20000
```

```text
  ── TESTS ───────────────────────────────────────────────────────────────

bun test v1.4.0 (34cbb9a40)

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [217.00ms]

    ✔  SUCCESS   all tests passed · 222 ms
```

Код выхода — код `bun test`. Как писать тесты — в главе
[Тестирование](../fundamentals/testing.md).

## `bazis build`

Кодогенерация всех целей и проверка типов (`tsc --noEmit`):

```sh
bunx bazis build
```

Ошибки типов показываются с местом в коде:

```text
  [FAIL]  typecheck       1 error                                         2.5 s

    ✖  FAILED   typecheck failed · 1 error

  ╭─ 1/1 [TYPE] src/app/modules/stats/broken.ts:1:7 ─────────────────────╮
  │ ✖  Type 'string' is not assignable to type 'number'.                  │
  │                                                                       │
  │   1 │ const total: number = "five";                                   │
  │     │       ^                                                         │
  │   2 │ export { total };                                               │
  │    code TS2322                                                        │
  ╰───────────────────────────────────────────────────────────────────────╯

  exit code 2
```

### Исполняемый файл

`--bin` после проверки типов собирает приложение в один исполняемый файл
с Bun внутри:

```sh
bunx bazis build --bin                    # bin/<имя из package.json>
bunx bazis build --bin --outfile dist/shop
bunx bazis build --bin --dotenv           # файл будет читать .env
bunx bazis build --bin --platform linux-x64  # для другой платформы: bin/<имя>-linux-x64
```

```text
  ── EXECUTABLE ──────────────────────────────────────────────────────────
  [OK  ]  compile         bin/shop · 62.6 MB                              171 ms

    ✔  SUCCESS   executable is ready · bin/shop

  │ ➜  run        ./bin/shop
  │
  │ BAZIS_ENV defaults to production in the executable
```

В исполняемом файле среда по умолчанию — production, настройки берутся
из переменных окружения. `bunfig.toml` он не читает никогда, `.env` —
только с `--dotenv`. Развёртывание — в разделе «Развёртывание».

## Коды выхода

| Код | Когда |
| --- | --- |
| `0` | Команда выполнена |
| `1` | Ошибка команды, опций, кодогенерации или запуска приложения |
| другой | Код `tsc`, `bun test` или самого приложения |

## Переменные окружения

| Переменная | Что делает |
| --- | --- |
| `BAZIS_LANG` | Язык вывода: `en`, `ru` |
| `BAZIS_UI` | `1` — экран запуска без терминала, `0` — строка журнала в терминале |
| `NO_COLOR` / `FORCE_COLOR` | Выключить / включить цвет |
| `BAZIS_ENV` | Среда приложения; `bazis dev` по умолчанию ставит `development` |
| `PORT`, `HOST` | Порт и адрес HTTP-сервера в шаблоне нового проекта |
| `BAZIS_BUN_BIN` | Какой `bun` запускать, если его нет в `PATH` |

## Дальше

- [Установка](../introduction/installation.md)
- [Архитектура модулей](../fundamentals/module-architecture.md)
- [Кодогенерация](../fundamentals/codegen.md)
- [Тестирование](../fundamentals/testing.md)
- [Конфигурация](../fundamentals/configuration.md)
