# Установка

## Что нужно заранее

- **Bun 1.4.0 или новее.** Если Bun ещё не установлен — инструкция на
  [bun.com](https://bun.com/docs/installation). Для macOS и Linux:

  ```sh
  curl -fsSL https://bun.com/install | bash
  ```

- **PostgreSQL** — только если вы будете пользоваться ORM. Для первого
  приложения база не нужна.

Node.js не нужен и не поддерживается — см. [«Почему только Bun»](why-bun.md).

## Новый проект (рекомендуется)

```sh
bunx bazis new MyApp
cd my-app
bun install
bunx bazis dev
```

Что происходит:

1. `bunx bazis new MyApp` скачивает CLI из npm и создаёт папку `my-app`.
   Имя проекта переводится в kebab-case.
2. В `package.json` нового проекта записывается зависимость
   `"bazis": "^<текущая версия>"`. Сам фреймворк в проект не копируется.
3. `bun install` скачивает bazis и его зависимость `typescript`.
4. `bunx bazis dev` запускает кодогенерацию и приложение на
   `http://127.0.0.1:3000`.

Проверка:

```sh
curl http://127.0.0.1:3000/health
# {"healthy":true,"checks":[]}
```

Подробный разбор созданного проекта — в [«Первых шагах»](first-steps.md).

### Параметры `bazis new`

| Параметр | Что делает |
| --- | --- |
| `--path <папка>` | Создать проект в указанной папке вместо `./<имя>` |
| `--vendor` | Скопировать фреймворк в `vendor/bazis` вместо зависимости из npm. Для проектов, которые собираются без доступа к npm |
| `--dry-run` | Показать, какие файлы будут созданы, ничего не записывая |

## Существующий проект на Bun

```sh
bun add bazis
bun add -d typescript@^6 @types/bun
```

Подойдёт TypeScript 5.9, 6 или 7. Проект, созданный `bazis new`, получает
`"typescript": "^6"`.

### TypeScript 7

В TypeScript 7 нет программного API компилятора, через который
кодогенерация bazis читает исходники: `import ts from "typescript"` отдаёт
только номер версии. Microsoft выпускает этот API отдельно, пакетом
`@typescript/typescript6`. С TypeScript 7 поставьте его рядом:

```sh
bun add -d typescript@^7 @typescript/typescript6 @types/bun
```

Проверка типов (`bazis build`) идёт самим TypeScript 7, а кодогенерация
читает исходники через API шестой версии. Без этого пакета кодогенерация
остановится и подскажет команду:

```text
[bazis] BAZIS_TYPESCRIPT_API_MISSING: TypeScript 7 has no compiler API, and bazis codegen needs one.
Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6
```

Учтите: `bun add -d typescript` без версии ставит именно TypeScript 7 —
тогда нужен и `@typescript/typescript6`.

> [!NOTE]
> TypeScript 7 поддерживается с версии bazis 0.97.5.

Дальше проекту нужны четыре файла. Проще всего взять их из проекта,
созданного `bazis new`, — ниже их минимальное содержимое.

`tsconfig.json` — строка `"types": ["bun"]` обязательна: TypeScript 6 не
подключает типы Bun сам:

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

`src/generated/bazis/runtime.ts` создаёт кодогенерация. Запустите её один раз
и добавьте `src/generated/` в `.gitignore`:

```sh
bunx bazis codegen
```

## Версии и обновление

| Задача | Команда |
| --- | --- |
| Какая версия установлена | `bun pm ls \| grep bazis` |
| Обновиться в пределах диапазона из `package.json` | `bun update bazis` |
| Перейти на последнюю версию | `bun add bazis@latest` |
| Поставить конкретную версию | `bun add bazis@0.96.2` |

bazis пока в версиях 0.x: **патч-версия** (0.96.2 → 0.96.3) совместима,
**минорная** (0.96 → 0.97) может содержать несовместимые изменения. Что
изменилось — в [CHANGELOG](../../../CHANGELOG.md).

## Откуда берётся пакет

Каждая версия публикуется из GitHub Actions с
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): на
странице пакета в npm видно, из какого коммита и каким workflow он собран.
Тот же архив пакета приложен к каждому
[выпуску на GitHub](https://github.com/asus97178/bazis/releases).
