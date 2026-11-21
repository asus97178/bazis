# Модули

**Одна функция — один модуль.** HTTP API, данные, фоновые задачи, бизнес-процессы и AI-инструменты лежат рядом, в одной папке. А bazis следит, чтобы модули не брали друг у друга то, что им не отдавали: нарушение границы остановит запуск и подскажет, как его исправить.

## Что такое модуль

Модуль — основа архитектуры bazis. Это класс с декоратором `@Module`, который собирает всё, что относится к одной функции приложения: сервисы с бизнес-логикой, контроллеры, настройки, базу данных, фоновые службы. В нём же модуль решает две вещи: от каких модулей он зависит (`imports`) и что отдаёт другим (`exports`).

Модуль создаётся командой CLI. Руками заводить файлы и подключать модуль к приложению не нужно.

**Пример.** Создадим пустой модуль заказов:

```bash
bunx bazis g module Orders --empty
```

CLI создал папку модуля и подключил его к приложению:

```text
src/app/modules/
├── orders/
│   ├── Orders.module.ts      + модуль
│   └── MODULE.md             + паспорт модуля
└── App.module.ts             ~ OrdersModule добавлен в imports
```

Сам модуль пока пустой: он ни от кого не зависит и ничего не отдаёт.

```ts
import { Module } from "bazis/core/di";

@Module({ imports: [], exports: [] })
export class OrdersModule {}
```

## Всё для функции — в одном модуле

Модуль не делят по техническим слоям. Модель, контекст базы данных, сервис, контроллер и модели запросов одной функции лежат в одной папке и подключаются в одном `@Module`.

Сервис модуль отдаёт через контракт: абстрактный класс с методами сервиса. Другие модули зависят только от контракта, поэтому реализацию можно заменить, не трогая их.

**Пример.** Команда без `--empty` создаёт готовую основу CRUD-модуля:

```bash
bunx bazis g module Products
```

```text
src/app/modules/products/
├── MODULE.md
├── Products.module.ts
├── model/
│   ├── Products.model.ts           сущность
│   └── Products.dbContext.ts       контекст базы данных
├── services/
│   ├── IProducts.service.ts        контракт сервиса
│   └── Products.service.ts         реализация
└── http/
    ├── Products.controller.ts      HTTP API
    └── contracts/
        ├── Products.requests.ts    модели запросов: создание, изменение
        ├── Products.responses.ts   модели ответов
        └── ProductsList.query.ts   параметры списка: фильтры, сортировка, страницы
```

Все части подключены в `@Module`:

```ts
@Module({
  ormBazis: { context: ProductsDbContext },              // база данных
  controllers: [ProductsController],                     // HTTP API
  providers: [scoped(IProductsService, ProductsService)], // контракт → реализация
  exports: [IProductsService],                           // наружу — только контракт
})
export class ProductsModule {}
```

## Что можно положить в модуль

Все поля `@Module` необязательны: модуль берёт только то, что ему нужно. Начать можно с сервиса и HTTP API, а базу данных, фоновые службы, процессы или AI-инструменты добавить в тот же модуль, когда понадобятся.

| Поле | Назначение |
|---|---|
| `imports` | Модули, от которых зависит этот |
| `providers` | Сервисы и другие компоненты в DI |
| `controllers` | HTTP-контроллеры |
| `exports` | Что модуль отдаёт другим модулям |
| `config` | Настройки модуля, объявленные через `defineConfig` |
| `background` | Фоновые службы с управляемым запуском и остановкой |
| `ormBazis` | Контекст базы данных модуля |
| `gateways` | WebSocket-шлюзы |
| `grpcControllers` | gRPC-контроллеры |
| `httpClients`, `grpcClients` | Клиенты к внешним HTTP- и gRPC-сервисам |
| `processes` | Бизнес-процессы, описанные в коде |
| `permissions`, `roles`, `references` | Права доступа, роли по умолчанию и справочники для админки |
| `tools` | Инструменты, доступные AI-агентам |
| `agentToolHooks` | Хуки вокруг вызовов AI-инструментов: разрешить вызов, записать исход, собрать метрики |
| `uiProfiles` | Описания интерфейса для генерируемого UI (`defineUiProfile`) |
| `configure` | Программная настройка DI для особых случаев |

Базу данных, gRPC, бизнес-процессы, права и AI модуль получает, когда в приложении подключены соответствующие части фреймворка: `bazis/core/orm`, `bazis/core/grpc`, `bazis/core/workflow`, `bazis/core/access`, `bazis/core/agent`.

## Приложение — это набор модулей

Каждый модуль отвечает за свою функцию, а корневой модуль `AppModule` собирает их в приложение. Бизнес-логики в нём нет: он только определяет, из чего состоит приложение.

`AppModule` лежит в `src/app/modules/App.module.ts` и подключается в `src/app/App.ts` декоратором `@App`. Каждый модуль, созданный через CLI, сам добавляется в его `imports`.

**Пример.** После двух команд выше корневой модуль выглядит так:

```ts
import { Module } from "bazis/core/di";
import { OrdersModule } from "./orders/Orders.module";
import { ProductsModule } from "./products/Products.module";

@Module({ imports: [OrdersModule, ProductsModule], exports: [] })
export class AppModule {}
```

## Границы: что видно другим модулям

Модули не просто раскладывают код по папкам, они контролируют, кто чем пользуется. Модуль может взять сервис другого модуля, только если выполнены оба условия:

1. Он подключил модуль-источник через `imports`.
2. Модуль-источник отдал этот сервис через `exports`.

**Пример.** Модулю отчётов нужно число товаров. Его сервис просит контракт `IProductsService` в конструкторе:

```ts
export class ReportsService {
  constructor(private readonly products: IProductsService) {}

  async productCount(): Promise<number> {
    return this.products.count();
  }
}
```

`ProductsModule` уже отдаёт `IProductsService`, поэтому модулю отчётов достаточно его подключить:

```ts
@Module({
  imports: [ProductsModule],
  providers: [scoped(ReportsService)],
  exports: [ReportsService],
})
export class ReportsModule {}
```

Зависимость видна прямо в коде: по `imports` понятно, кто от кого зависит.

### Что значит `exports`

| `exports` | Что получат модули, которые импортируют этот |
|---|---|
| `exports: [IProductsService]` | Только `IProductsService` |
| `exports: []` | Ничего: все сервисы модуля приватные |
| Поле не указано | Всё, что зарегистрировано в модуле |

**Всегда указывайте `exports`.** CLI так и создаёт модули. Модуль без `exports` открыт целиком, и его внутренние сервисы незаметно становятся чужим API. Если `exports` указан, случайно взять внутренний сервис другого модуля не получится.

### Если граница нарушена

bazis проверяет границы при запуске. Нарушение останавливает запуск, а сообщение говорит, что исправить.

**Пример.** Забыли добавить `ProductsModule` в `imports` модуля отчётов:

```text
Module encapsulation violated:
Module "ReportsModule": "ReportsService" depends on "IProductsService", which module
"ProductsModule" exports, but "ReportsModule" does not list "ProductsModule" in its imports.
Add "ProductsModule" to the imports of "ReportsModule".
```

А если `ProductsModule` подключён, но контракт не отдаёт (`exports: []`):

```text
Module encapsulation violated:
Module "ReportsModule": "ReportsService" depends on "IProductsService", which module
"ProductsModule" provides but does not export. Add it to the exports of "ProductsModule".
```

Архитектурная ошибка видна сразу, искать её в коде не нужно. Подробнее о цепочках импортов, реэкспорте и подмене реализаций — в разделе [Инкапсуляция модулей](../fundamentals/encapsulation.md).

> `exports` управляет только внедрением зависимостей. Контроллеры, фоновые службы и инструменты модуля работают в любом случае. Доступ к API и другим точкам входа настраивается отдельно, например через `@Authorize`.

## Глобальные модули

Некоторые вещи нужны почти везде: системные часы, логгер, подключения к инфраструктуре, кэш. Модуль с декоратором `@Global()` отдаёт свои `exports` всем модулям приложения без `imports`.

Это инструмент для инфраструктуры. Для бизнес-функций оставляйте явные `imports`: по ним видно, кто от кого зависит.

**Пример.** Модуль часов, которые доступны везде:

```ts
import { Global, Module, singletonValue } from "bazis/core/di";

@Global()
@Module({
  providers: [singletonValue(CLOCK, systemClock)],
  exports: [CLOCK],
})
export class ClockModule {}
```

## Составные модули

Обычно одна функция — один модуль. Составной модуль нужен, когда внутри функции есть несколько самостоятельных частей со своими данными, логикой и ответственностью. Корень составного модуля только собирает части через `imports`, вся логика живёт в частях.

**Пример.** Каталог из товаров и категорий:

```bash
bunx bazis g pack Catalog --parts items,categories
```

```text
src/app/modules/
├── catalog_modules/
│   ├── Catalog.module.ts               + корень каталога
│   ├── MODULE.md
│   ├── items_module/
│   │   ├── Items.module.ts             + часть «товары»
│   │   └── MODULE.md
│   └── categories_module/
│       ├── Categories.module.ts        + часть «категории»
│       └── MODULE.md
└── App.module.ts                       ~ CatalogModule добавлен в imports
```

```ts
@Module({
  imports: [ItemsModule, CategoriesModule],
  exports: [],
})
export class CatalogModule {}
```

Ещё одну часть в готовый каталог добавляет `bunx bazis g module Brands --pack Catalog`. Подробнее — в разделе [Архитектура модулей](../fundamentals/module-architecture.md).

## Какой шаблон выбрать

CLI создаёт модуль с нужной стартовой начинкой. Выберите, с чего начать, а дальше займитесь бизнес-логикой.

| Команда | Что получится |
|---|---|
| `bunx bazis g module Orders --empty` | Пустой модуль и паспорт |
| `bunx bazis g module Products` или `--minimal` | Основа CRUD: модель, контекст БД, контракт и сервис, контроллер, модели запросов |
| `bunx bazis g module Products --full` | CRUD плюс список с фильтрами, кэш, авторизация, фоновая служба и AI-инструмент |
| `bunx bazis g pack Catalog --parts items,categories` | Составной модуль из нескольких частей |
| `bunx bazis g module Brands --pack Catalog` | Ещё одна часть в готовом составном модуле |

## Структура модуля

Папка внутри модуля появляется, только когда в ней есть код, поэтому пустых каталогов «на будущее» нет. Когда модуль вырастет, его структура будет такой:

```text
products/
├── MODULE.md                 паспорт модуля
├── Products.module.ts        подключение модуля
├── model/                    сущности и контекст БД
├── services/                 бизнес-логика и контракты сервисов
├── http/                     HTTP-контроллеры
│   └── contracts/            модели запросов и ответов
├── background/               фоновые службы
├── ai/                       AI-инструменты
└── test/                     тесты
```

`MODULE.md` — паспорт модуля: назначение, ответственность, входы и зависимости. По паспорту в проекте быстро разбирается и новый разработчик, и AI-ассистент. В новом проекте `AGENTS.md` прямо просит ассистента создавать модули через CLI и заполнять паспорт.

## Почему модули bazis

- **Всё в одном месте.** Функция целиком лежит в одной папке.
- **Явные зависимости.** Модуль сам говорит, от чего зависит и что отдаёт.
- **Границы под контролем.** bazis проверяет их при запуске и подсказывает, как исправить ошибку.
- **Рост без перестройки.** Новая возможность добавляется в модуль или новым модулем, остальное приложение не меняется.
- **Старт одной командой.** CLI создаёт структуру, подключение, паспорт и заготовки.
- **Единый подход.** HTTP, база данных, фоновые задачи, WebSocket, gRPC, бизнес-процессы, права и AI-инструменты — части одной функции.

## Дальше

- [Провайдеры и DI](providers.md)
- [Контроллеры](controllers.md)
