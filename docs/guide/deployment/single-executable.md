# Один исполняемый файл

`bazis build --bin` собирает приложение в один файл, внутри которого есть и
Bun. На сервере не нужны ни Bun, ни `node_modules`, ни исходники —
только этот файл и настройки в переменных окружения.

Все примеры проверены на bazis 0.111.2 и Bun 1.4.3.

## Сборка

```sh
bunx bazis build --bin
```

Команда обновляет сгенерированный код, проверяет типы и собирает
`bin/<имя из package.json>`:

```text
  ── EXECUTABLE ──────────────────────────────────────────────────────────
  [OK  ]  compile         bin/shop · 62.6 MB                              198 ms

    ✔  SUCCESS   executable is ready · bin/shop
```

Другой путь — `--outfile dist/shop`. Остальные опции — в главе
[Команды CLI](../cli/commands.md#исполняемый-файл).

Файл собирается для той системы, на которой запущена сборка:

```text
$ file bin/shop
bin/shop: Mach-O 64-bit executable arm64
```

На macOS получится файл для macOS. Для Linux-сервера собирайте на Linux —
проще всего в Docker, см. главу [Docker](docker.md).

## Что внутри

В файл попадает всё, что приложение **импортирует**: ваш код,
сгенерированный код из `src/generated/bazis`, пакеты из `node_modules`,
импортированные JSON-файлы. И сам Bun.

Файлы, которые приложение **читает с диска** во время работы, в него не
попадают. Если нужен файл рядом с кодом — шаблон письма, справочник,
картинка, — импортируйте его как файл:

```ts
import plans from "./plans.json";                                  // данные — в коде
import templatePath from "./welcome.tpl" with { type: "file" };     // файл — внутри бинарника

const template = await Bun.file(templatePath).text();
```

Импорт файла возвращает путь к нему внутри бинарника, а TypeScript нужно
объявление расширения — как для `.proto` в главе [gRPC](../realtime/grpc.md#контракт):

```ts
// src/assets.d.ts
declare module "*.tpl" {
  const path: string;
  export default path;
}
```

Возьмите расширение, которое Bun не объявляет сам. `.html` не подойдёт:
в типах Bun это `HTMLBundle` для сборки фронтенда, и `bazis build`
остановится с `No overload matches this call`. `.txt`, `.toml`, `.yaml`
Bun импортирует как содержимое, а не путь.

Проверено: файл скопирован в пустой каталог и запущен оттуда.

```text
imported: {"plan":"pro"}
embedded file: hello asset
disk file exists: false        ← Bun.file("runtime.txt") с диска не нашёлся
```

## Запуск

```sh
BAZIS_DB__PASSWORD=… PORT=8080 HOST=0.0.0.0 ./shop
```

Файл можно запускать из любого каталога. Он ничего не читает рядом с
собой: ни `bunfig.toml`, ни `.env` (если не собран с `--dotenv`). Настройки
приходят из переменных окружения `BAZIS_…` и
[файлов секретов](../security/secrets.md#файлы-секретов).

**Среда по умолчанию — production.** Без `BAZIS_ENV` приложение требует
секреты production, не показывает подробности ошибок и страницу
OpenAPI (`/docs` отвечает 404). Если секрет не задан, оно не стартует:

```text
$ ./shop
[bazis] configuration error: Invalid configuration (environment "production"):
  db.password — required non-empty secret is not set (BAZIS_DB__PASSWORD).
$ echo $?
1
```

**Запуск и остановка — по строке в журнале**, в том числе в production.
В `listening` — адрес, на котором слушает сервер:

```text
info: bazis started {"environment":"production","debug":false,"configKeys":6,"configMs":0.2,"containerMs":2.2,"hostedServices":6,"hooks":0,"startupMs":127.8,"listening":["http://127.0.0.1:3096"]}
info: bazis stopped {"signal":"SIGTERM","exitCode":0,"shutdownMs":1.1}
```

Обе строки отключает `runApp({ kernel: { startupReport: false } })`.
[Экран запуска](../cli/commands.md#экран-запуска) печатается только вне
production и только в терминале. Готовность для балансировщика
по-прежнему проверяйте по `/health`.

> [!NOTE]
> С версии 0.107.0. Раньше в production успешный запуск и остановка не
> писали ничего, а в строке запуска не было адреса.

Приложение из примера готово отвечать через 0.1 секунды после запуска.

## Шаг схемы

Если схема базы создаётся при старте (`ensureCreated`, миграции), её можно
применить отдельным шагом до выкладки новой версии:

```sh
BAZIS_SCHEMA_ONLY=1 BAZIS_DB__USERNAME=app_owner BAZIS_DB__PASSWORD=… ./shop
```

```text
info: schema only: infrastructure and schema are ready, stopping (BAZIS_SCHEMA_ONLY) {"hostedServices":2,"startupMs":114}
```

Приложение подключается к инфраструктуре, приводит схему в порядок и
выходит с кодом 0 — HTTP-сервер не запускается. Зачем запускать схему под
отдельным пользователем — в [чек-листе](../security/production-checklist.md#пользователь-без-прав-на-схему).

## Остановка и обновление

По `SIGTERM` или `SIGINT` приложение доделывает начатые запросы,
останавливает фоновые задачи, закрывает подключения и выходит с кодом 0.
Подробнее — в главе [Плавная остановка и health](graceful-shutdown.md).

Обновление — замена файла и перезапуск. Файл не зависит от того, что
лежит рядом, поэтому старую версию можно сохранить под другим именем и
вернуть её так же.

## Дальше

- [Настройка продакшена](production.md)
- [Docker](docker.md)
- [Плавная остановка и health](graceful-shutdown.md)
- [Чек-лист перед продакшеном](../security/production-checklist.md)
