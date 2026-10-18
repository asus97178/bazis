# Почему только Bun

bazis работает **только на Bun 1.4.0 и новее**. Node.js и Deno не
поддерживаются. Это осознанное решение, а не временное ограничение.

## Причина 1: пакет — это исходники на TypeScript

В npm лежат исходные `.ts`-файлы, без сборки в JavaScript и без отдельных
`.d.ts`. Bun выполняет TypeScript и стандартные декораторы напрямую.

Node.js умеет отбрасывать типы только у файлов вашего проекта, но не у
пакетов в `node_modules`. Попытка импортировать bazis в Node.js 24
заканчивается так:

```text
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for
"file:///.../node_modules/bazis/core/di/index.ts"
```

## Причина 2: рантайм построен на API Bun

| Что делает bazis | Чем пользуется |
| --- | --- |
| HTTP-сервер и WebSocket | `Bun.serve` |
| PostgreSQL | `Bun.SQL` |
| Redis | встроенный клиент Bun |
| Файлы и процессы | `Bun.file`, `Bun.write`, `Bun.spawn` |
| Тесты | `bun:test` |
| Один исполняемый файл | `bun build --compile` |

Замена этих API на пакеты для Node.js означала бы лишние зависимости и
отдельный код для каждого рантайма. bazis выбирает один рантайм и использует
его полностью.

## Что это значит на практике

- Устанавливайте и запускайте через Bun: `bun add bazis`, `bunx bazis ...`.
  `npm install bazis` тоже скачает пакет, но выполнить его сможет только Bun.
- На сервере Bun не нужен, если вы развёртываете собранный бинарник:
  `bazis build --bin` упаковывает Bun внутрь файла.
- Проверенные платформы: macOS arm64, Linux x64 и arm64. На других
  платформах, включая Windows, bazis не проверялся.

## Какая версия Bun нужна

Минимум — **1.4.0**, это записано в поле `engines` пакета. Сам фреймворк
тестируется на Bun 1.4.0 с проверкой хэша исполняемого файла. Версия Bun в
вашем проекте:

```sh
bun --version
```

### Старый Bun в PATH

CLI сверяет запущенный Bun с `engines` перед каждой командой. На старом
Bun команда не выполняется (вывод без рамки, код выхода 1):

```text
✖  FAILED  command failed
[BUN] /Users/ann/.bun/bin/bun
✖  bazis needs Bun 1.4.0 or newer; this is Bun 1.3.13.
➜  This Bun is /Users/ann/.bun/bin/bun. bunx bazis and bun run scripts start bazis with
   the first bun in PATH, not with the Bun that called them.
➜  Update that Bun: bun upgrade. Or put the newer Bun first in PATH.
```

`bunx bazis` и скрипты `bun run` запускают CLI через `#!/usr/bin/env bun`,
то есть **первым `bun` из `PATH`**. Это может быть другой Bun, не тот, что
вы вызвали: например, Bun 1.4 из своего каталога вызывает `bun run
codegen`, а CLI запускается старым `~/.bun/bin/bun`. Обновите тот Bun,
который назван в ошибке, — `bun upgrade`, — или поставьте нужный первым в
`PATH`.

> [!NOTE]
> Проверка — с версии 0.105.2. Раньше CLI молча работал на старом Bun.
