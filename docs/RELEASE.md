# Подготовка кандидата Osnova

Процедура зафиксирована 2026-10-02 при подготовке **0.95.0**. Это SemVer-номер
запрошенной версии «0.95», а не версия HTTP API, схем БД или wire-протоколов.
Номер в исходниках сам по себе не подтверждает прохождение проверок или выпуск.
Автоматического publish/tag workflow в репозитории нет; оба пакета private.

## Исходное состояние и границы

При работе поверх незакоммиченных изменений сначала сохранить отдельный снимок
текущих исходников, их SHA-256, HEAD и Git status. Чистый HEAD не заменяет этот
снимок. Не включать credentials, рабочие env, БД, runtime data, node_modules,
бинарники и кэши. Исправления делать в отдельной копии; финальный diff строить
от сохранённого состояния, а не присваивать себе прежние изменения checkout.
Не применять reset/clean/stash к чужому дереву. Интегрировать только согласованный
список файлов после повторной сверки исходных хешей и независимого review.

## Версии и зависимости

Согласовать `package.json` и `src/osnova/package.json`, затем активные metadata
приложения в `src/index.ts` и Codex `clientInfo.version`.
Пакеты admin-ui/client-ui имеют независимую версию `0.1.0`.
API/schema versions, исторические отчёты и версии примеров автоматически не менять.

Использовать квалифицированный Bun из [toolchain](../toolchain/README.md).
Обновление версии без Git-операций:

```sh
./scripts/osnova-bun --no-env-file pm version 0.95.0 --no-git-tag-version --allow-same-version
# В src/osnova, через ../../scripts/osnova-bun — та же команда.
./scripts/osnova-bun --no-env-file install --lockfile-only --ignore-scripts
```

Проверить полученный `bun.lock`: версии внешних пакетов и integrity должны
остаться прежними. Bun 1.4.0 может оставить старую версию неиспользуемого workspace
при отсутствии изменений графа. В таком случае в изолированной копии временно
добавить корневую зависимость `osnova: "workspace:0.95.0"`, выполнить тот же
lockfile-only, восстановить исходный состав manifest и выполнить команду снова.
Временная локальная зависимость не остаётся в результате. Не использовать
`--force`: он запрашивает свежие версии внешних зависимостей. Generated TypeScript
и lockfile вручную не редактировать. Поведение `pm version` описано в
[официальной документации Bun](https://bun.com/docs/pm/cli/pm#version).

## Последовательность проверок

Перед запуском сверить наличие команд в `package.json`. Все команды выполняются
с явным `OSNV_BUN_BIN`, без рабочих env и provider credentials. Общий codegen
и тестовые серверы имеют одного владельца; одновременно их не запускать.

1. `toolchain:check` и `di:generate --target all`.
2. `build`: codegen production и полный TypeScript `tsc --noEmit`.
3. `test`: проектный pretest/codegen и полный isolated suite. Не считать SKIP
   физических PostgreSQL/Redis тестов успешной проверкой инфраструктуры.
4. `admin:ui:check`, `admin:ui:build`, `client:ui:build`. Обе UI-сборки запускают
   установленный `vue-tsc --noEmit` через настоящий Node ≥22.12 и только затем
   Vite. Bun 1.4.0 обходит нужный hook и может пропускать Vue SFC без ошибки.
   При необходимости путь к Node задаётся через `OSNV_VUE_NODE_BIN`.
5. `build:bin` создаёт `bin/osnova-app` и `bin/osnova`. Выполнить оба вне checkout:
   app `config check --environment=test`, CLI `--help`, а затронутые runtime-пути
   проверить отдельной контролируемой compiled-фикстурой.
6. Проверить public API/barrels и переносимость framework package: публичные
   smoke/boundary tests, создание переносимого CLI-проекта; при упаковке — только
   `pm pack --ignore-scripts`, без публикации. Проверить версию внутри артефакта.
7. Для каждого дефекта сохранить исходное воспроизведение FAIL и fixed PASS.
   Физические проверки проводить только на своих временных сервисах и проверять
   cleanup. UI: запоздавшие ответы, смена сессии, HTTP-target действий и доступность.

Скрипта lint в текущих manifests нет: его отсутствие указывается явно.
Результаты, команды, SHA-256 исходников/артефактов и ограничения записываются
в отчёт конкретного кандидата. Исторические PASS туда не переносятся как новые.

## Миграция defaults 0.95.0

- Production bootstrap первого администратора закрыт до настройки установочного
  Secret и подтверждения `X-Osnova-Setup-Token`. Оператор доставляет секрет
  через защищённый источник конфигурации, не через argv/URL, и отправляет header
  своим доверенным HTTP-клиентом. Не записывать значение в логи/историю shell,
  не коммитить его. После установки сохраняется прежний постоянный bootstrap
  marker; лишний установочный секрет следует убрать. Процедура не создаёт и
  не сохраняет реальное значение автоматически. Контракт и условия локального
  development/test setup: [AdminAuth](../src/app/modules/actor_modules/admin_modules/auth_module/MODULE.md).
  Локальный reverse proxy виден как loopback peer: при внешнем доступе к dev/test
  установочный Secret также нужен, либо setup должен быть закрыт сетью.
- Client cookie получает Secure в production. При TLS-терминации оператор задаёт
  точный внешний origin, общий для HTTP и WS. Произвольным forwarded headers
  доверия нет. Для локального HTTP используется development/test либо осознанная
  настройка оператора: [ClientAuth](../src/app/modules/client-auth/MODULE.md).
- Launcher по умолчанию даёт 15 секунд на остановку. При большем kernel-бюджете
  согласовать `OSNV_BUN_SHUTDOWN_TIMEOUT_MS`: [toolchain](../toolchain/README.md).
- SMS endpoint должен принимать конечный POST без redirects. Перенаправления
  завершаются ошибкой: [SMS](../src/app/modules/sms/MODULE.md).
- Admin UI и OpenAPI поставляются вместе: UI берёт разрешённые сортировки из
  `x-osnova-sort-fields`; при отсутствии metadata не предлагает неизвестные поля.
- Auth ограничивает запросы до разбора тела; административные операции имеют
  предел конкурентного выполнения на процесс. Клиенты за одним proxy делят
  лимит его непосредственного IP. Значения и поведение 429 описаны в паспортах
  [AdminAuth](../src/app/modules/actor_modules/admin_modules/auth_module/MODULE.md)
  и [ClientAuth](../src/app/modules/client-auth/MODULE.md).
- После превышения верхней границы длины framework пропускает проверки содержимого
  того же декоратора, поэтому массив ошибок короче. Отдельные pattern/custom
  остаются ответственностью автора: [валидация](../src/osnova/library/validation/SPEC.md).

## Решение о готовности

Отдельно оценивать framework, приложение с внешними зависимостями, admin/client
UI, исходники, упакованный framework и бинарники. Перечислить непроверенные
платформы и реальные провайдеры. Даже полный локальный PASS не означает абсолютной
безопасности или проверки production-среды. Tag, push, publish и принятие чужого
baseline не входят в подготовку кандидата и требуют отдельного решения.

## Удаление ручной HTTP-привязки (2026-10-03, изменение после кандидата 0.95)

Breaking change: удалены `@Bind` и его дескрипторы `Param`, `Query`, `Body`,
`Header`, `Req`, `Res`, `Ctx`, `FromServices`, `List`, алиасы `FromRoute`,
`FromQuery`, `FromBody`, `FromHeader` и `ValueBindingOptions` из публичного HTTP API.
Удалите их imports и декораторы. Источники параметров выводит штатный codegen:

```ts
@Put("tables/:table/validators")
replace(table: string, input: ReplaceValidatorsRequest) { /* ... */ }
```

`table` берётся из маршрута, DTO — из JSON-тела с прежней валидацией.
Заголовки и произвольные тела читайте через `ctx: HttpContext`; сервисы
внедряйте в конструктор. Для query default указывайте default параметра метода,
для list используйте подкласс `ListRequest` с `Sortable`/`Filterable`/`ListOptions`.
После миграции выполните `di:generate --target all` и typecheck.
`@RequestModel()` остаётся для совместимости; для DTO текущего приложения
штатная генерация обходится без него. Binding runtime и generated descriptors
сохраняются. Генерация дополнительно публикует схемы `ReplaceValidatorsRequest`
и `ValidatorRuleRequest` в OpenAPI; маршруты и правила валидации не меняются.

Это изменение исходников не обновляет ранее одобренный tarball. Новый артефакт
и переход Docs на него требуют отдельной проверки и согласованного шага.

Устранена коллизия consumer `UsersController.list()` со старой картой
привязок исходного приложения. Codegen записывает пустой descriptor для
методов без параметров, runtime использует только конкретный класс target,
а package compatibility-карта больше не содержит метаданные приложения.

## Квалификация на живом PostgreSQL (2026-10-04, изменение после кандидата 0.95)

Физическая проверка выполняется одной командой на одноразовом PostgreSQL 17 с TLS:

```sh
python3 ops/live-postgres/runner.py <каталог-вне-репозитория>/<имя-прогона>
```

Runner прогоняет полный набор и каждый гейтированный live-набор в своей базе,
проверяет отсутствие сессий и удаляет контейнер. Нативная отмена Bun.SQL
отмечается как известный внешний дефект и не считается PASS. Redis-наборы
требуют надёжной конфигурации сервера (`appendonly yes`, `appendfsync always`,
`maxmemory-policy noeviction`). Результаты: [отчёт](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/release-0.95-live-postgres-2026-10-04/REPORT.md).

Изменения поведения:

- Новый ключ `db.tlsCa` (`OSNV_DB__TLS_CA`): PEM дополнительного CA для
  `db.tls=verify-full`; пусто — только системное доверие. В ORM-коннекторе
  пустой `tlsCa` теперь означает «CA не задан» вместо ошибки конфигурации.
- Kernel, `Application` и hosted-helpers запускают singleton, на который
  указывают несколько регистраций `HOSTED_SERVICE`, один раз. Модуль с
  несколькими `ownedStore`-контекстами теперь стартует.

## Выпуск 0.96.0 (2026-10-04)

Инкрементный выпуск поверх кандидата 0.95.0. Версия согласована в
`package.json`, `src/osnova/package.json`, `bun.lock`, metadata `src/index.ts`,
`src/admin-ui-dev.ts` и Codex `clientInfo` (включая `ops/codex/check-skills.ts`).

Изменения относительно 0.95.0:

- `db.tlsCa` / `OSNV_DB__TLS_CA` для production `verify-full` с частным CA;
  пустой `tlsCa` в ORM-коннекторе означает «CA не задан».
- Singleton с несколькими регистрациями `HOSTED_SERVICE` запускается один раз;
  модуль с несколькими `ownedStore` стартует в kernel.
- `build:bin:*` компилируют через `scripts/build-bin.ts`: launcher больше не
  оставляет неудаляемые `.bun-build` в checkout.
- Удалены ручные `deps`, дублировавшие codegen в DataManager; явный
  `exports: []` у `AdminDeveloperTools`; паспорта корней DataManager/Admin и
  частей Access, DeveloperTools, Observability.
- Физическая квалификация: `ops/live-postgres/runner.py`.

Миграция: действий не требуется; `OSNV_DB__TLS_CA` — опционально.

## Выпуск 0.96.1 (2026-10-04): пакет `osnv`

Фреймворк приведён к виду публикуемого npm-пакета для Bun. Поставляется
исходниками TypeScript, сборка в JavaScript не нужна; работает только в Bun ≥ 1.4.0.

- Имя пакета `osnova` заменено на `osnv`: в npm `osnova` занято чужим пакетом.
  Сгенерированный код и шаблоны CLI импортируют фреймворк по имени пакета
  (`osnv/core/di`), а не через алиасы `@osnova/*` и `@/*`. Новый проект из
  `osnv new` не содержит `paths` в `tsconfig.json`; снимок лежит в `vendor/osnv`.
- Манифест: снят `private`, добавлены `license: MIT`, `bin: osnv`,
  `engines.bun >= 1.4.0`, `peerDependencies.typescript` (нужен только
  кодогенерации и CLI; runtime внешних зависимостей не имеет). Из пакета
  исключены тесты и фикстуры (537 файлов, 0.92 МБ вместо 792 и 1.47 МБ).
- Самоимпорты `@/…` в `core/agent/session` заменены относительными.
- `scripts/package-check.ts` (входит в `run ci`): pack → установка в пустой
  проект → `osnv new` → codegen → модуль → typecheck → `/health`.

Миграция существующего приложения: зависимость `osnova` → `osnv`, пути
`tsconfig` `osnova/*` → `osnv/*` (алиасы `@osnova/*` можно оставить для
своего кода), затем `di:generate --target all` — сгенерированные файлы
импортируют `osnv/...`.

CLI 0.96.1: все команды вызываются как `osnv` (`bunx osnv …`; в этом репозитории
`./scripts/osnova-bun run osnv …`, бинарник CLI — `bin/osnv`). Новые команды
`osnv dev`, `osnv build`, `osnv build --bin [--outfile]`; скрипты созданного
проекта — обёртки над ними. `g module --full` больше не требует auth-модуля
приложения: без него маршруты генерируются публичными с предупреждением.
`agent run` перенесён в приложение (`bun run agent:run`).

Также в 0.96.1: `osnv codegen` вызывает генератор фреймворка напрямую (скрипт
`di:generate` в проекте больше не нужен); `osnv dev --watch`; `osnv test`;
предупреждение при старте из исходников, изменённых после кодогенерации
(`src/generated/osnv/fingerprint.ts`). Новый проект получает скрипты `test` и
`start`, `.env.example`, тест `/health`, `HOST`; копия `vendor/osnv` совпадает по
составу с npm-пакетом.

`osnv dev` запускает приложение с `OSNV_ENV=development`, если переменная не
задана в оболочке (раньше без `.env` приложение стартовало как `production`
и требовало продовые секреты). README пакета переписан на английском.
Добавлен пример `examples/todo` (модули project, task, report; PostgreSQL с
автомиграцией, межмодульный DI, валидация, JSON:API, e2e-тест, бинарник);
`run ci` собирает его как пользователь (`example install/build/test`), e2e-тест
выполняется при заданном `OSNV_DB__HOST`, иначе помечается skip.

Перед выпуском доделано:
- ORM: нарушение уникального индекса в `saveChanges()` приходит как
  `UniqueViolationError` (`constraint`, `table`, `cause`) вместо сырой ошибки
  драйвера и HTTP 500.
- ORM: создание и миграцию таблиц задаёт только модуль (`ensureCreated` или
  `migrateOnStart` в `ormOsnova`). Флаг `@Entity({ migrate: true })` удалён:
  `migrateOnStart` теперь мигрирует все сущности контекста модуля.
- HTTP: поля тела запроса, объявленные как `string`/`number`/`boolean`,
  проверяются по типу JSON без `@Validator` (400, код `type`). gRPC и агенты
  не затронуты.
- CLI: имена по модулю, как его ввели. `g module Stats` создаёт файлы
  `<Модуль>.<роль>.ts` (`Stats.module.ts`, `Stats.controller.ts`,
  `Stats.service.ts`, `IStats.service.ts`, `Stats.model.ts`, `Stats.dbContext.ts`,
  `Stats.requests.ts`, `Stats.responses.ts`, `StatsList.query.ts`) и классы ролей
  `StatsModule`, `StatsController`, `StatsService`, `StatsDbContext`. Единственное
  число остаётся у записи и её DTO (`Stat`, `CreateStatRequest`, `StatResponse`).
  Раньше: `Stat.module.ts`, `StatController.ts`, `StatService`.
- Встроенные тексты фреймворка и шаблоны CLI — на английском. Русские наборы:
  `RU_VALIDATION_MESSAGES`, `RU_CODEX_MESSAGES`, `RU_UI_LABELS`. Приложение
  подключает их при старте. Ошибки конфигурации и заголовки промпта агента
  только английские.

В корне `src/` осталась только точка входа `index.ts`. Вспомогательные скрипты
перенесены к модулям-владельцам (команды `bun run …` прежние):
`admin:token` → `src/app/modules/auth/AdminToken.cli.ts`, `agent:run` →
`src/app/modules/agent-chat/client/AgentRun.cli.ts`, `config:check`/`config:inspect`
→ `src/app/config/ConfigCheck.cli.ts`. Удалены заглушка снятой фичи Workflow
(`src/system-workflow-producer.ts`) и отдельный dev-backend админки
(`admin:backend`, `AdminUiDevModule`, настройки `http.admin*` и переменные
`OSNV_ADMIN_*`): он поднимал устаревший набор модулей без DataManager.
Admin UI разрабатывается на обычном `bun run dev` + `bun run admin:ui`.

Миграция: сообщения валидации, ошибки конфигурации, тексты Codex и подписи UI
по умолчанию стали английскими — для прежнего поведения подключите русские
наборы; тесты, сравнивающие эти тексты, нужно обновить. `RequestModelFieldShape`
стал объединением (`model` или `primitive`).
