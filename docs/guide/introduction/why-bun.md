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
