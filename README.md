# Osnova

Приложение на Bun со своими DI, kernel, ORM и модульной архитектурой.
Перед изменениями прочитайте [архитектурную спецификацию](docs/architecture/MODULE_ARCHITECTURE.md).

## Локальная работа

Используется квалифицированный Bun через `scripts/osnova-bun`. Переменная
`OSNOVA_BUN_BIN` должна указывать на уже проверенный исполняемый файл;
требования к версии и хосту задаются в `toolchain/`. Проверка не устанавливает
runtime и не заменяет его. Текущий допуск: Bun 1.4.0, macOS arm64
26.5.2 (25F84). Для другой платформы нужна отдельная квалификация.

```sh
# Указать путь к своему квалифицированному Bun:
export OSNOVA_BUN_BIN=/absolute/path/to/bun
./scripts/osnova-bun run toolchain:check
./scripts/osnova-bun install --frozen-lockfile
cp .env.example .env
./scripts/osnova-bun run config:check --environment=development
./scripts/osnova-bun run config:inspect --environment=development
```

## Создать приложение

Пошаговый путь от CLI до бинарника: [быстрый старт](docs/QUICKSTART.md).

```sh
./scripts/osnova-bun run osnova new MyApp
cd my-app
bun install
bun run dev
```

Команда создаёт отдельный минимальный backend с `AppModule`, HTTP `/health`,
настройками TypeScript и codegen. Путь можно задать через `--path`, а состав
файлов заранее посмотреть через `--dry-run`. Из собранного CLI вне checkout
укажите `--framework /path/to/src/osnova`. Фреймворк копируется в `vendor/osnova`;
сохраните этот каталог в Git и переносите вместе с приложением. Зависимость
`file:./vendor/osnova` не требует исходного checkout. Для совместной разработки
с живым checkout есть явный `--link-framework`. После создания проекта модуль без
готовой БД можно добавить командой `bun run osnova g module Task --empty`.

Команды config проверяют активные DB, LLM, JWT, SMS и HTTP-настройки.
Клиенты не создаются, сетевые подключения не открываются, SMS не отправляются.
`config:inspect` выводит JSON: полный ключ, тип, env-имена, источник и значение.
Секреты маскируются. `PASS` подтверждает схему и значения настроек;
доступность сервисов проверяется отдельно при старте и через health.

Для работы приложения нужны PostgreSQL и указанный LLM endpoint.
По умолчанию development использует локальную Ollama и модель `qwen2.5:7b`.
SMS.RU нужен при фактической отправке SMS. Redis и OpenSearch сейчас
не подключены в [AppInfra](src/app/infra/App.infra.ts); их примеры конфигов
не входят в проверку активного приложения.

```sh
./scripts/osnova-bun run dev
# Отдельный backend для разработки Admin UI:
./scripts/osnova-bun run admin:backend
# В другом терминале:
./scripts/osnova-bun run admin:ui
```

Штатные команды dev/start выполняют codegen. Не редактируйте generated-файлы
вручную. Команды запуска используют существующую ORM-политику приложения;
перед подключением рабочей БД проверьте её schema/migration-параметры.

## Настройки и приоритеты

Порядок приложения: defaults → секция окружения → JSON-файл → env → CLI.
Файл задаётся `--config-file=/path/config.json`, окружение —
`--environment=development|test|production`; без аргумента берётся
`OSNOVA_ENV`, затем `NODE_ENV`, затем production.

```sh
./scripts/osnova-bun run config:inspect --environment=test --config-file=/path/config.json --db.host=db.internal
```

Обычное соответствие: `db.host` → `OSNOVA_DB__HOST`, `jwt.system.accessTtl`
→ `OSNOVA_JWT__SYSTEM__ACCESSTTL`. Для LLM также объявлены удобные имена
`OSNOVA_LLM__BASE_URL` и `OSNOVA_LLM__API_KEY`. Разные значения канонического
имени и alias в одном источнике дают ошибку; более поздний источник побеждает.
`OSNOVA_LLM__MODEL` применяется к обоим профилям AppInfra.

| Настройка | Development default | Production / ограничения |
| --- | --- | --- |
| `http.port` / `http.adminPort` | 3000 | Целое 1…65535; прежний `OSNOVA_ADMIN_PORT` поддерживается |
| `http.hostname` / `http.adminHostname` | `0.0.0.0` | IPv4/IPv6 либо `localhost`; для loopback задайте `127.0.0.1`; alias `OSNOVA_ADMIN_HTTP__HOSTNAME` |
| `http.corsOrigins` / `http.adminCorsOrigins` | Локальные UI origins | В production список пуст; задайте точные origins через запятую |
| `db.tls` | disable | verify-full по умолчанию; режимы Bun TLS |
| `db.max` | 10 соединений | Целое 1…1000 |
| `db.connectionTimeout` | 10 секунд | 1…3600 секунд |
| `db.idleTimeout` | 30 секунд | 0…86400; 0 отключает этот предел |
| `db.maxLifetime` | 1800 секунд | 0…604800; 0 отключает этот предел |
| JWT TTL | Значения в jwt.config.ts | Положительные целые секунды; system access — 1…300 |

Production требует восемь непустых секретов из [.env.example](.env.example).
В development JWT-ключи создаются заново при запуске процесса; после перезапуска
старые токены перестают действовать. Изменение env/файла требует нового запуска:
готовый kernel использует свой неизменяемый снимок.

В коде модуль объявляет `config: myConfig`. Сервис получает `myConfig.token`
через существующий DI, host-фабрика может использовать `myConfig.resolve(...)`.
Коннектор читает `configs.get(myConfig)` внутри `create(configs)`.
Прямой `myConfig.get()` — самостоятельное чтение process env; он не выбирает
настройки конкретного kernel. Подробности: [контракты config](src/osnova/core/kernel/config/README.md).

## Бинарники и проверка

```sh
./scripts/osnova-bun run build
./scripts/osnova-bun run build:bin
./bin/osnova-app config check --environment=production
./bin/osnova-app config inspect --environment=test --config-file=/path/config.json
./bin/osnova --help
```

Бинарник приложения содержит статические объявления конфигурации. Команды
config работают вне каталога исходников. JSON-файл загружается во время
выполнения; для env надёжный путь — передать переменные процессу через
окружение сервиса/оболочки. Внешние credentials и конфиг не встраиваются в сборку.
Без команды config бинарник запускает приложение.

Health выполняет до четырёх checks одновременно: default 1 секунда на check,
5 секунд на отчёт. Тайм-аут означает unhealthy и передаёт AbortSignal.
Контракты и ограничения драйверов: [Infra](src/osnova/core/infra/MODULE.md).

Результаты исправлений: [план работ](docs/audits/2026-09-14-infra-config/WORK_PLAN.md)
и [исходный аудит](docs/audits/2026-09-14-infra-config/AUDIT.md).

Эксплуатация Infra/Config: [runbook](docs/audits/2026-09-14-infra-config-acceptance/RUNBOOK.md)
и [результат локальной приёмки](docs/audits/2026-09-14-infra-config-acceptance/RESULT.md).
Проверка [полного бинарника, восстановления приложения и длительной нагрузки](docs/audits/2026-09-14-infra-config-operations/RESULT.md) содержит актуальные результаты и границы production-готовности.
При остановке raw PostgreSQL ожидает завершения запросов не более 1000 мс
по умолчанию; свой предел задаётся через `postgres(config, { shutdownTimeoutMs })`.

## CI

Весь конвейер выпуска — одна команда, её вызывает и CI-хост:

```sh
./scripts/osnova-bun --no-env-file run ci
# С квалификацией на одноразовом PostgreSQL 17 (нужен Docker):
./scripts/osnova-bun --no-env-file run ci -- --live docs/audits/<имя-прогона>
```

[scripts/ci.ts](scripts/ci.ts) последовательно выполняет toolchain-проверку,
codegen с проверкой, что `src/generated` закоммичен, `tsc`, тесты, сборки
Admin/Client UI, `build:bin` и запуск обоих бинарников из пустого каталога.
Первый сбой останавливает конвейер с ненулевым кодом. Toolchain квалифицирован
только для macOS 26.5.2 / 25F84 arm64, поэтому CI-раннер — эта машина
(self-hosted) до отдельной квалификации другой платформы.
