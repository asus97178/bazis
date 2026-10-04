# src/osnova/core/http — HTTP-модуль (в духе ASP.NET Core)

Контроллеры — классы со стандартными TC39-декораторами; маршруты компилируются
в radix-дерево на старте; каждый запрос живёт в собственном DI-scope.
Без внешних зависимостей, без рефлексии, совместим с `bun build --compile`
(проверяется общим `bun run build:bin`).

Полная спецификация middleware и `@Middleware`: [SPEC.md](./SPEC.md).

## Быстрый старт

Сначала создайте приложение по [руководству](../../../../docs/QUICKSTART.md),
затем модуль `bunx osnv g module Echo --empty`. Для пробы без БД замените
содержимое созданного `Echo.module.ts` этим кодом и заполните его `MODULE.md`:

```ts
import { Module } from "osnova/core/di";
import { Controller, Get, Post, RequestModel } from "osnova/core/http";
import { Validator } from "osnova/library/validation";

@RequestModel()
export class EchoRequest {
  @Validator({ required: true, type: "string", minLength: 3, maxLength: 100 })
  text!: string;
}

@Controller("echo")
export class EchoController {
  @Get(":id(int)")
  getById(id: number) { return { id }; }

  @Post()
  send(body: EchoRequest) { return { text: body.text }; }
}

@Module({ controllers: [EchoController], exports: [] })
export class EchoModule {}
```

`bun run dev` запускает codegen перед приложением. GET `/echo/42` возвращает
`{"id":42}`; POST `/echo` с `{"text":"hello"}` — `{"text":"hello"}`.
Невалидное тело получает HTTP 400. Если host задаёт prefix, добавьте его к пути.
Привязки параметров выводятся из сигнатуры до запуска; на каждом запросе
TypeScript не анализируется. Для зависимостей сервисов достаточно конструктора
и `scoped(IService, Service)` — обычные `deps` выводит тот же codegen.

## Конвенции привязки (а не декораторы параметров)

Декораторы **параметров** (`getUser(@Param("id") id)`) в стандарте TC39
отсутствуют, а `experimentalDecorators` сломал бы остальные модули фреймворка.
Вместо них — конвенции в стиле ASP.NET, выведенные codegen'ом из сигнатуры:

| Параметр метода | Привязка |
|---|---|
| имя совпадает с `:name` маршрута | значение из маршрута (конверсия по ограничению/типу) |
| DTO-класс из исходников приложения | тело запроса + валидация `@Validator` (ошибки -> 400) |
| `HttpContext` / `Request` / `ResponseBuilder` | контекст / сырой запрос / билдер ответа |
| примитив (`string`/`number`/`boolean` или вывод из default) | query-параметр; `?` и default -> опциональный |

Если конвенция не выводится (например, union из строковых литералов,
нет аннотации или два класса-тела), `di:generate` завершается с ошибкой
`OSNOVA_HTTP_BINDING_UNRESOLVED`, именем метода и причиной. Предыдущие generated-
файлы не заменяются. Используйте поддерживаемый тип; для заголовков и сырых
тел передавайте `ctx: HttpContext`, сервисы внедряйте в конструктор.
Проверка допустимых значений принадлежит Validator или сервису.

Параметр `ctx: HttpContext` остаётся обычным поддерживаемым входом. Для старой
ручной сборки HTTP без generated metadata сохранён runtime fallback с одним
HttpContext; он не заменяет codegen для типизированных actions.

### Вложенные request DTO

`di:generate` также читает типы полей request-модели и регистрирует форму для
рекурсивной гидрации без `reflect-metadata`. Поэтому обычный DX сохраняется и
для объектов и массивов:

```ts
export class AddressRequest {
  @Validator({ required: true })
  city!: string;
}

export class CreateUserRequest {
  @Validator({ required: true, nested: true })
  address!: AddressRequest;

  @Validator({ nested: true })
  previousAddresses!: AddressRequest[];
}
```

Оба класса должны быть именованными top-level export. Binder создаёт настоящие
экземпляры вложенных DTO, удаляет неизвестные и prototype-polluting поля на
каждом уровне, затем запускает валидацию с путями вида `address.city` и
`previousAddresses[0].city`. Неоднозначный тип у `nested: true` (например,
union из двух классов) останавливает codegen; plain object при отсутствующей
или устаревшей generated-метадате стандартный validator отклоняет fail-closed.

Открытые JSON-поля (`Record<string, unknown>`, `{}`, `unknown[]`) сохраняют
обычные пользовательские ключи, но binder рекурсивно клонирует их и удаляет
`__proto__`, `constructor`, `prototype` на любой глубине. Циклы, глубина более
64 контейнеров и чрезмерно сложные графы отклоняются с 400 до передачи в action.

## Карта папки

| Папка/файл | Назначение |
|---|---|
| `Decorators/` | `@Controller`, `@Get`/`@Post`/... (+ inline-опции `{ code, produces, consumes, version, middleware }`), `@HttpCode`, `@Produces`, `@Consumes`, `@Middleware`, `@ApiVersion`, `@Catch`, `@ActionFilter`; хранение метаданных через `Symbol.metadata` |
| `Routing/` | парсер шаблонов (`:id(int)`, `:u(uuid)`, `*rest`), radix-дерево с backtracking, сборка конвейеров на старте |
| `Binding/` | дескрипторы привязок, конверсия типов (400 при ошибке), model binding c защитой от prototype pollution и валидацией `@Validator` |
| `Results/` | `Ok`, `Created`, `NotFound`, `Redirect`, `File` (через `Bun.file`) и нормализация результата с авто Content-Type |
| `Middleware/` | конвейер, `cors` (+ preflight), `errorHandler`, `rateLimit`; access log — `@/logging/http` |
| `Versioning/` | чтение версии API из URL-сегмента, query-параметра или заголовка |
| `HttpContext/` | контекст запроса (params, scope DI, кэш тела) и `ResponseBuilder` |
| `Errors/` | `HttpError` и наследники (4xx/5xx), `ModelValidationError`, `HttpSetupError` |
| `HttpServer.ts` | hosted service: `Bun.serve`, scope на запрос, 404/405/preflight без конвейера |
| `httpModule.ts` | фабрика `OsnovaModule`: scoped-контроллеры + сервер |

## Гарантии

- **Производительность**: вся метадата обрабатывается на старте; на запрос —
  radix-поиск O(сегментов), скомпилированный конвейер, scope DI; тело парсится
  один раз (кэш в контексте).
- **Отказоустойчивость**: глобальная граница ошибок всегда установлена
  (`HttpError` -> статус, прочее -> 500 без деталей в production); `@Catch`
  на контроллере для доменных ошибок; битые JSON/конверсии -> 400, не 500.
- **Безопасность**: prototype pollution отфильтрован в model binding и именах
  параметров маршрута; `..`/`%zz` в пути -> 400; CORS с preflight; точки
  подключения auth — обычные middleware (`@Middleware` или глобально);
  `rateLimit` подключается одной строкой.
- **Ошибки конфигурации** (дубликат маршрута, неизвестное ограничение,
  класс без `@Controller`) — `HttpSetupError` на старте, не в рантайме.
