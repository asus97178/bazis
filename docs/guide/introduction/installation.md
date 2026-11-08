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

Три шага: поставить пакеты, добавить четыре файла и один раз запустить
кодогенерацию.

### Шаг 1. Пакеты: выберите свою версию TypeScript

bazis работает с TypeScript 5.9, 6 и 7. Возьмите ту, что уже стоит в проекте.
Если TypeScript ещё нет, ставьте 6: её получает проект от `bazis new`.

> **Если проект создан через `bun init`.** Он записывает `typescript` в
> `peerDependencies`. Тогда `bun add -d typescript@…` ничего не ставит, а Bun
> подтягивает самый новый TypeScript, седьмой. Сначала уберите запись:
>
> ```sh
> bun remove typescript
> ```

#### TypeScript 6 — рекомендуем

```sh
bun add bazis
bun add -d typescript@^6 @types/bun
```

Больше ничего не нужно.

#### TypeScript 5.9 — если проект уже на нём

```sh
bun add bazis
bun add -d typescript@~5.9 @types/bun
```

Подходит 5.9.3 и новее в ветке 5.9. Более старые TypeScript не
поддерживаются: обновитесь до 5.9 или сразу до 6.

#### TypeScript 7

```sh
bun add bazis
bun add -d typescript@^7 @typescript/typescript6 @types/bun
```

Здесь нужен ещё пакет `@typescript/typescript6`. Кодогенерация bazis читает
исходники через программный API компилятора, а в TypeScript 7 его нет. Microsoft
выпускает этот API отдельным пакетом. Проверку типов при этом делает сам
TypeScript 7.

Забыли пакет? Кодогенерация остановится и подскажет команду:

```text
[bazis] BAZIS_TYPESCRIPT_API_MISSING: TypeScript 7 has no compiler API, and bazis codegen needs one.
Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6
```

Учтите: `bun add -d typescript` без версии ставит именно TypeScript 7.
TypeScript 7 поддерживается с bazis 0.97.5.

### Шаг 2. Четыре файла

Файлы одинаковые для всех версий TypeScript. Проще всего взять их из проекта,
созданного `bazis new`. Вот минимальное содержимое.

`tsconfig.json`. Оставьте строку `"types": ["bun"]`: с TypeScript 6 и 7 без неё
типы Bun могут не подключиться.

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

### Шаг 3. Кодогенерация

```sh
bunx bazis codegen
```

Она создаст `src/generated/bazis/runtime.ts`. Добавьте `src/generated/` в
`.gitignore`: папка каждый раз строится заново из исходников.

Готово. `bunx bazis dev` запустит приложение.

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
