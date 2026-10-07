# Кодогенерация

В bazis нет `reflect-metadata` и декораторов на параметрах вроде
`@Inject()` или `@Param()`. Всё, что другие фреймворки узнают во время
выполнения, bazis узнаёт заранее: перед запуском он читает исходники
TypeScript и записывает результат в `src/generated/bazis`.

```ts
// вы пишете
export class TaskController {
  constructor(private readonly tasks: ITaskService) {}

  @Get(":id")
  getById(id: string) { ... }
}
```

```ts
// codegen записывает в src/generated/bazis/deps.ts
[TargetClass_0, [DependencyClass_1]]                     // TaskController ← ITaskService

// и в src/generated/bazis/bindings.ts
[TargetController_0, {"getById":[{"source":"route","name":"id","optional":false}]}]
```

Плюсы такого подхода: зависимости проверяются до запуска, рантайму не
нужна рефлексия, а приложение собирается в один бинарный файл без
сюрпризов.

## Когда запускается

| Команда | Codegen |
| --- | --- |
| `bazis dev` | Перед запуском; с `--watch` — после каждого изменения в `src/` |
| `bazis test` | Перед тестами |
| `bazis build`, `bazis build --bin` | Перед проверкой типов и сборкой |
| `bazis codegen` | Только codegen; `--target <имя>` или `--target all` — для [других целей](#несколько-точек-входа) |

Если запускать приложение напрямую — `bun src/index.ts` — codegen сам не
выполнится. Тогда bazis сравнивает исходники с тем, что было при последнем
codegen, и предупреждает:

```text
[bazis] WARNING: generated code is out of date (application sources changed).
[bazis] New or changed controllers, routes and constructor dependencies are NOT active.
[bazis] Run: bunx bazis codegen   (bazis dev, bazis build and bazis test run it automatically)
```

Предупреждение стоит воспринимать всерьёз. Новый параметр конструктора без
codegen не пройдёт проверку графа сервисов, и приложение не стартует:

```text
[bazis] configuration error: Service graph validation failed:
Class provider "PingController" requires at least 1 constructor deps, but only 0 declared.
```

Хуже с новым методом контроллера: маршрут уже работает, а описания его
аргументов ещё нет. Метод получит не те значения и упадёт только на запросе:

```text
GET /ping/ann/upper → 500 "name.toUpperCase is not a function"
```

После `bazis codegen` тот же запрос отвечает `{"pong":"ANN"}`. Поэтому в
разработке запускайте приложение через `bazis dev`.

## Что генерируется

| Файл | Содержимое |
| --- | --- |
| `deps.ts` | Зависимости конструкторов: какие сервисы передать каждому классу |
| `bindings.ts` | Откуда брать каждый аргумент методов контроллеров |
| `httpRequestModels.ts` | Описания моделей запросов: типы полей для проверки JSON |
| `httpListModels.ts` | Описания моделей списков (`ListRequest`) |
| `openapi.ts` | Данные для документации API |
| `agentCatalog.ts` | Описания AI-инструментов |
| `fingerprint.ts` | Отпечаток исходников — для предупреждения об устаревании |
| `runtime.ts` | `registerBazisGeneratedRuntime()` — подключает всё остальное |

Папку `src/generated` не правят руками и не хранят в Git: созданный CLI
проект уже добавил её в `.gitignore`.

## Какие файлы читает codegen

`bazis.config.json` описывает **цели** — точки входа приложения:

```json
{
  "version": 1,
  "defaultTarget": "production",
  "targets": {
    "production": { "entrypoints": ["src/index.ts"] }
  }
}
```

Codegen разбирает только файлы, до которых можно дойти по `import` от
точки входа. Модуль, который никто не импортирует, не попадает в
приложение — и codegen не молчит об этом, а останавливается:

```text
BAZIS_CODEGEN_SOURCE_UNASSIGNED: src/app/modules/orders/Orders.module.ts
```

Обычная причина — модуль создан, но не добавлен в `imports` корневого
`AppModule`. `bazis g module` добавляет его сам.

### Несколько точек входа

Если в проекте кроме HTTP-сервера есть, например, фоновый обработчик со
своей точкой входа, опишите его отдельной целью:

```json
"targets": {
  "production": { "entrypoints": ["src/index.ts"] },
  "worker": { "entrypoints": ["src/worker.ts"] }
}
```

Результат цели по умолчанию лежит в `src/generated/bazis`, остальных — в
`src/generated/bazis/targets/<имя>`. Точка входа подключает свой вариант:

```ts
// src/worker.ts
import { runApp } from "bazis/core/app";
import { WorkerModule } from "./app/Worker.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/targets/worker/runtime";

await registerBazisGeneratedRuntime();
await runApp(WorkerModule);
```

> [!WARNING]
> `bazis dev`, `bazis test` и `bazis build` генерируют только цель по
> умолчанию. Для остальных запускайте `bazis codegen --target all` — иначе
> их сгенерированный код останется прежним.

## Ошибки codegen

Codegen останавливается с кодом ошибки и местом в исходниках, если
чего-то не может понять:

| Код | Причина | Что сделать |
| --- | --- | --- |
| `BAZIS_DI_DEPENDENCY_UNKNOWN` | Тип параметра конструктора — не класс и не токен, например интерфейс без токена | Сделать контракт [абстрактным классом](../overview/providers.md#регистрация-по-контракту) или объявить токен |
| `BAZIS_DI_CONFIG_UNKNOWN` | `ConfigView<T>`, а `defineConfig<T>` с таким типом нет | Объявить настройки с типом в угловых скобках |
| `BAZIS_DI_CONFIG_AMBIGUOUS` | `ConfigView<T>` подходит к нескольким `defineConfig<T>` | Оставить одно объявление на тип |
| `BAZIS_HTTP_BINDING_UNRESOLVED` | Аргумент метода контроллера нельзя связать с запросом — например, два параметра-класса, а тело у запроса одно | Оставить одну модель тела; заголовки и сырое тело читать через `HttpContext` |
| `BAZIS_CODEGEN_SOURCE_UNASSIGNED` | Файл не достижим ни из одной точки входа | Импортировать модуль или добавить цель |
| `BAZIS_CODEGEN_CONFIG_INVALID` | Ошибка в `bazis.config.json` | Исправить файл |

## Дальше

- [Провайдеры и DI](../overview/providers.md)
- [Контроллеры](../overview/controllers.md)
- [Приложение](../overview/application.md)
