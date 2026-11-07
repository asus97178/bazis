# Почему только Bun

**Bun нужен для разработки и сборки. На сервер можно отправить один исполняемый файл.**

bazis работает на Bun 1.4.0 и новее. Node.js и Deno не поддерживаются, и это осознанное решение, а не временное ограничение. bazis использует одну среду выполнения, чтобы брать то, что в ней уже есть: HTTP-сервер, клиенты PostgreSQL и Redis, запуск TypeScript и сборку в бинарник. Поэтому у самого bazis нет сторонних npm-зависимостей, кроме TypeScript для проверки типов.

## Всё нужное уже в Bun

Пакет bazis публикуется в npm как исходный TypeScript. Bun запускает `.ts`-файлы со стандартными декораторами напрямую, поэтому не нужны `tsc`, сборка пакета, `.d.ts` и `reflect-metadata`. Достаточно установить пакет и пользоваться CLI:

```sh
bun add bazis
```

Под капотом HTTP и WebSocket работают через `Bun.serve`, PostgreSQL — через `Bun.SQL`, Redis — через встроенный клиент Bun. Для запуска тестов используется `bun:test`. Поддержка других сред потребовала бы отдельных реализаций для этих возможностей.

`npm install bazis` скачает пакет, но не сделает его совместимым с Node.js. Node.js 24 не удаляет типы из `.ts`-файлов пакетов в `node_modules`, и импорт bazis заканчивается так:

```text
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for
"file:///.../node_modules/bazis/core/di/index.ts"
```

## Соберите на машине разработчика, запустите на сервере

```sh
bunx bazis build --bin                      # для своей платформы
bunx bazis build --bin --platform linux-x64 # для сервера Linux, прямо с Mac
```

Команда упакует приложение вместе с Bun. На сервере запускается готовый файл: отдельно устанавливать Bun или копировать `node_modules` не нужно. Подробнее — в [«Один исполняемый файл»](../deployment/single-executable.md) и [«Платформы»](../deployment/platforms.md).

bazis проверен на macOS arm64, Linux x64 и Linux arm64. Windows и другие платформы пока не проверялись.

## Решение проблем: старый Bun в PATH

Проверьте, какая версия доступна в терминале:

```sh
bun --version
```

Минимальная версия указана в `engines` пакета. Перед каждой командой CLI проверяет версию запущенного Bun. Если она ниже 1.4.0, команда остановится и покажет версию и путь к исполняемому файлу:

```text
✖  FAILED  command failed
[BUN] /Users/ann/.bun/bin/bun
✖  bazis needs Bun 1.4.0 or newer; this is Bun 1.3.13.
➜  This Bun is /Users/ann/.bun/bin/bun. bunx bazis and bun run scripts start bazis with
   the first bun in PATH, not with the Bun that called them.
➜  Update that Bun: bun upgrade. Or put the newer Bun first in PATH.
```

Если вы уже установили новый Bun, посмотрите на путь в сообщении. `bunx bazis` и скрипты `bun run` запускают CLI через первый `bun` в `PATH`. При нескольких установках это может оказаться старая копия, даже если саму команду вы вызвали новым Bun. Обновите Bun по указанному пути командой `bun upgrade` или поставьте нужную версию первой в `PATH`.

[Установить bazis →](installation.md) · [Собрать первый сервис](first-steps.md)
