# Установка

**Четыре команды — и сервис отвечает на запросы.** Нужен только Bun: ни Node.js, ни глобальных пакетов, ни базы данных для первого запуска.

```sh
bunx bazis new MyApp
cd my-app
bun install
bunx bazis dev
```

```sh
curl http://127.0.0.1:3000/health
# {"healthy":true,"checks":[]}
```

Готово: у вас работающее приложение с модулями, DI и health-check. Дальше — [«Первые шаги»](first-steps.md): первый контроллер, первый маршрут, сборка в один файл.

## Что понадобится

- **Bun 1.4.0 или новее.** Если его ещё нет, на macOS и Linux он ставится одной командой (подробнее — на [bun.com](https://bun.com/docs/installation)):

  ```sh
  curl -fsSL https://bun.com/install | bash
  ```

- **PostgreSQL — только когда дойдёте до ORM.** Для первого приложения база не нужна.

Node.js не нужен и не поддерживается — почему, рассказано в [«Почему только Bun»](why-bun.md).

## Что делают эти четыре команды

1. `bunx bazis new MyApp` скачивает CLI из npm и создаёт готовый проект в папке `my-app` (имя переводится в kebab-case).
2. В `package.json` записывается одна зависимость — `"bazis": "^<текущая версия>"`. Фреймворк не копируется в проект: обновление — это смена версии.
3. `bun install` ставит bazis и TypeScript. Больше ничего: у bazis нет сторонних npm-зависимостей.
4. `bunx bazis dev` сам запускает кодогенерацию и поднимает приложение на `http://127.0.0.1:3000`.

### Параметры `bazis new`

| Параметр | Что делает |
| --- | --- |
| `--path <папка>` | Создать проект в указанной папке вместо `./<имя>` |
| `--vendor` | Скопировать фреймворк в `vendor/bazis` вместо зависимости из npm — для сборки без доступа к npm |
| `--dry-run` | Показать, какие файлы будут созданы, ничего не записывая |

## Уже есть проект на Bun? Подключите bazis

```sh
bun add bazis
bun add -d typescript@^6 @types/bun
```

Подойдёт TypeScript 5.9, 6 или 7. Проект, созданный `bazis new`, получает `"typescript": "^6"`.

> **Важно, если проект создан через `bun init`.** Он записывает `typescript` в `peerDependencies`. Тогда `bun add -d typescript@^6` ничего не ставит, Bun подтягивает самый новый TypeScript — седьмой, — и кодогенерация остановится с `BAZIS_TYPESCRIPT_API_MISSING`. Сначала уберите запись:
>
> ```sh
> bun remove typescript
> bun add -d typescript@^6
> ```

Дальше проекту нужны четыре небольших файла. Проще всего взять их из проекта, созданного `bazis new`; вот минимальное содержимое.

`tsconfig.json` — строка `"types": ["bun"]` обязательна: TypeScript 6 не подключает типы Bun сам:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

`bazis.config.json` — какие файлы читает кодогенерация:

```json
{
  "version": 1,
  "defaultTarget": "production",
  "targets": {
    "production": { "entrypoints": ["src/index.ts"] }
  }
}
```

`src/index.ts` — точка входа:

```ts
import { runApp } from "bazis/core/app";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, { http: { port: 3000, health: true } });
```

`src/app/modules/App.module.ts` — корневой модуль:

```ts
import { Module } from "bazis/core/di";

@Module({ imports: [], exports: [] })
export class AppModule {}
```

`src/generated/bazis/runtime.ts` создаёт кодогенерация. Запустите её один раз и добавьте `src/generated/` в `.gitignore`:

```sh
bunx bazis codegen
```

### TypeScript 7 — тоже поддерживается

В TypeScript 7 нет программного API компилятора, через который кодогенерация bazis читает исходники: `import ts from "typescript"` отдаёт только номер версии. Microsoft выпускает этот API отдельно, пакетом `@typescript/typescript6`. Поставьте его рядом:

```sh
bun add -d typescript@^7 @typescript/typescript6 @types/bun
```

Проверка типов (`bazis build`) идёт самим TypeScript 7, а кодогенерация читает исходники через API шестой версии. Если пакет забыть, кодогенерация остановится и сама подскажет команду:

```text
[bazis] BAZIS_TYPESCRIPT_API_MISSING: TypeScript 7 has no compiler API, and bazis codegen needs one.
Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6
```

Учтите: `bun add -d typescript` без версии ставит именно TypeScript 7 — тогда нужен и `@typescript/typescript6`. TypeScript 7 поддерживается с bazis 0.97.5.

## Обновление — одной командой

| Задача | Команда |
| --- | --- |
| Какая версия установлена | `bunx bazis --version` |
| Обновиться в пределах диапазона из `package.json` | `bun update bazis` |
| Перейти на последнюю версию | `bun add bazis@latest` |
| Поставить конкретную версию | `bun add bazis@0.96.2` |

bazis пока в версиях 0.x: **патч-версия** (0.96.2 → 0.96.3) совместима, **минорная** (0.96 → 0.97) может содержать несовместимые изменения. Что изменилось — в [CHANGELOG](../../../CHANGELOG.md).

## Пакет, которому можно доверять

Каждая версия публикуется из GitHub Actions с [npm provenance](https://docs.npmjs.com/generating-provenance-statements): на странице пакета в npm видно, из какого коммита и каким workflow он собран. Тот же архив пакета приложен к каждому [выпуску на GitHub](https://github.com/asus97178/bazis/releases). Вместе с нулём сторонних зависимостей это значит: вы точно знаете, какой код попадает в ваш проект.

[Собрать первый сервис →](first-steps.md)
