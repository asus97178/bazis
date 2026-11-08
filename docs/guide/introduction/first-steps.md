# Первые шаги

**15 минут — и у вас настоящий API: маршруты, проверка входных данных,
документация, тесты и один исполняемый файл для сервера.**

Соберём небольшой сервис приветствий. По дороге вы увидите главное в bazis:
сервисы — обычные классы без декораторов, проверка запросов описывается
одной строкой, документация API появляется сама, а результат собирается в
один файл. Нужен только Bun 1.4.0+ — база данных не понадобится.

Что будет в конце:

- `GET` и `POST` маршруты с проверкой входных данных;
- страница документации API `/docs` — без единой строки настройки;
- тесты, которые запускаются одной командой;
- `bin/my-app` — файл, который можно скопировать на сервер и запустить.

## 1. Создаём проект — одна команда

```sh
bunx bazis new MyApp
cd my-app
bun install
```

Проект готов к работе сразу: с точкой входа, корневым модулем, тестом и
правилами для AI-ассистентов. CLI создаёт папку `my-app` с такой структурой:

```text
my-app/
├── package.json            зависимость "bazis" и скрипты
├── tsconfig.json
├── bazis.config.json       какие файлы читает кодогенерация
├── .env.example            пример настроек (HOST, PORT, BAZIS_ENV)
├── .gitignore
├── AGENTS.md               правила для AI-ассистентов, работающих с проектом
├── README.md
├── docs/architecture/MODULE_ARCHITECTURE.md
└── src/
    ├── index.ts            точка входа: запускает приложение
    └── app/
        ├── modules/App.module.ts   корневой модуль
        └── test/health.test.ts     тест: приложение стартует и отвечает на /health
```

Точка входа `src/index.ts`:

```ts
import { runApp } from "bazis/core/app";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, { http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true } });
```

- `registerBazisGeneratedRuntime()` подключает код, созданный кодогенерацией:
  связи зависимостей и привязки HTTP-параметров. Папка `src/generated/` — это
  результат сборки, как `dist/` в других проектах: `bazis dev`, `bazis test` и
  `bazis build` заново строят её из ваших исходников при каждом запуске.
  Поэтому руками её не правят — следующий запуск перезапишет изменения, менять
  нужно сам код модулей. И в Git её не хранят — она восстанавливается одной
  командой, а в репозитории давала бы лишние изменения при любой правке модулей
  и конфликты при слиянии веток. В `.gitignore` нового проекта она уже есть.
- `runApp(AppModule, ...)` собирает модули, поднимает HTTP-сервер и включает
  маршрут `/health`.

Корневой модуль пока пустой:

```ts
import { Module } from "bazis/core/di";

@Module({ imports: [], exports: [] })
export class AppModule {}
```

## 2. Запускаем — сервис уже отвечает

```sh
bunx bazis dev
```

Команда запускает кодогенерацию, а затем приложение в окружении
`development`. В консоли появится строка вида:

```text
info: bazis started {"environment":"development","debug":true,...}
```

Проверяем:

```sh
curl http://127.0.0.1:3000/health
# {"healthy":true,"checks":[]}
```

Приложение уже работает, а вы ещё не написали ни строчки. Порт и адрес меняются переменными `PORT` и `HOST`, например
`PORT=3100 bunx bazis dev`. С флагом `--watch` приложение перезапускается
при изменениях в `src/`. Остановка — `Ctrl+C`.

## 3. Создаём модуль — CLI сделает каркас

Модули создаются только через CLI — так они сразу получают правильную
структуру и подключаются к приложению. Сервис и контроллер в этом уроке мы
напишем сами, чтобы увидеть, как всё устроено, поэтому сейчас берём профиль
`--empty` — пустой модуль без примеров кода:

```sh
bunx bazis g module Greeting --empty
```

```text
  ── FILES ─────────────────────────────────────────── src/app/modules/greeting
  [OK  ]  files           3 changes
    ├─ + src/app/modules/greeting/Greeting.module.ts
    ├─ + src/app/modules/greeting/MODULE.md
    └─ ~ src/app/modules/App.module.ts
  ↗  connected in src/app/modules/App.module.ts

    ✔  SUCCESS   module Greeting is generated
```

CLI создал модуль, его «паспорт» `MODULE.md` (описание ответственности и
входов модуля) и добавил модуль в корневой:

```ts
@Module({ imports: [GreetingModule], exports: [] })
export class AppModule {}
```

Без `--empty` CLI создаёт модуль с готовым примером: `--minimal` (по
умолчанию) — CRUD с базой данных, `--full` — ещё список, кэш, права доступа,
фоновую задачу и инструмент для AI-агента. Подробнее о профилях — в
[«Командах CLI»](../cli/commands.md#bazis-g-module).

## 4. Пишем сервис — обычный класс

Бизнес-логика живёт в сервисах. Создайте
`src/app/modules/greeting/services/Greeting.service.ts`:

```ts
export interface Greeting {
  name: string;
  message: string;
}

export class GreetingService {
  private readonly history: Greeting[] = [];

  getAll(): readonly Greeting[] {
    return this.history;
  }

  create(name: string): Greeting {
    const greeting = { name, message: `Hello, ${name}!` };
    this.history.push(greeting);
    return greeting;
  }
}
```

Сервис — обычный класс. Никаких `@Injectable`, декораторов и регистрации:
его легко читать и легко тестировать.

## 5. Описываем модель запроса — проверка в одну строку

Данные, которые приходят в теле запроса, описываются классом с проверками.
Создайте `src/app/modules/greeting/http/contracts/Greeting.requests.ts`:

```ts
import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class CreateGreetingRequest {
  @Validator({ required: true, minLength: 1, maxLength: 50 })
  name!: string;
}
```

`@Validator` задаёт правила: поле обязательно, длина от 1 до 50 символов.
Тип `string` тоже проверяется: число вместо строки вернёт ошибку 400.
Писать проверки в контроллере не нужно — неверный запрос до него просто не
дойдёт. Отдельная библиотека вроде `class-validator` тоже не нужна.

## 6. Пишем контроллер — без декораторов на параметрах

Контроллер принимает HTTP-запросы и вызывает сервис. Создайте
`src/app/modules/greeting/http/Greeting.controller.ts`:

```ts
import { Controller, Created, Get, HttpContext, Post } from "bazis/core/http";
import { GreetingService } from "../services/Greeting.service";
import { CreateGreetingRequest } from "./contracts/Greeting.requests";

@Controller("greetings")
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get()
  getAll() {
    return this.greetings.getAll();
  }

  @Get(":name")
  getByName(name: string) {
    return { message: `Hello, ${name}!` };
  }

  @Post()
  create(body: CreateGreetingRequest, ctx: HttpContext) {
    const greeting = this.greetings.create(body.name);
    return Created(`${ctx.path}/${encodeURIComponent(greeting.name)}`, greeting);
  }
}
```

Откуда берутся аргументы методов — фреймворк определяет по их именам и
типам, без декораторов на параметрах:

| Параметр | Откуда значение |
| --- | --- |
| `name: string`, а в маршруте есть `:name` | из пути: `/greetings/world` → `"world"` |
| `body: CreateGreetingRequest` | из JSON-тела запроса, с проверкой `@Validator` |
| `ctx: HttpContext` | контекст текущего запроса |
| простой тип, которого нет в маршруте | из строки запроса: `?limit=10` |

Сервис попадает в контроллер через конструктор. А если фреймворк не может
понять, откуда взять параметр, вы узнаете об этом ещё до запуска:
кодогенерация остановится с ошибкой `BAZIS_HTTP_BINDING_UNRESOLVED` и назовёт
метод и причину.

## 7. Собираем модуль

Откройте `src/app/modules/greeting/Greeting.module.ts`:

```ts
import { Module, singleton } from "bazis/core/di";
import { GreetingController } from "./http/Greeting.controller";
import { GreetingService } from "./services/Greeting.service";

@Module({
  providers: [singleton(GreetingService)],
  controllers: [GreetingController],
  exports: [GreetingService],
})
export class GreetingModule {}
```

- `providers` — сервисы модуля. `singleton` значит «один экземпляр на всё
  приложение»: история приветствий сохраняется между запросами. Для сервисов
  без состояния обычно выбирают `scoped` — новый экземпляр на каждый запрос.
- `controllers` — контроллеры модуля, их регистрировать как провайдеры не
  нужно.
- `exports` — что модуль отдаёт другим модулям. Здесь `GreetingService`
  смогут внедрять модули, которые импортируют `GreetingModule`.

## 8. Проверяем — и смотрим документацию

Если `bunx bazis dev` всё ещё запущен без `--watch`, перезапустите его.

```sh
curl http://127.0.0.1:3000/greetings/world
# {"message":"Hello, world!"}

curl -i -X POST http://127.0.0.1:3000/greetings \
  -H 'content-type: application/json' -d '{"name":"Anna"}'
# HTTP/1.1 201 Created
# Location: /greetings/Anna
# {"name":"Anna","message":"Hello, Anna!"}

curl http://127.0.0.1:3000/greetings
# [{"name":"Anna","message":"Hello, Anna!"}]
```

Неверные данные отклоняются до вызова контроллера:

```sh
curl -X POST http://127.0.0.1:3000/greetings \
  -H 'content-type: application/json' -d '{"name":""}'
# 400 {"error":"Validation failed","details":[{"property":"name",
#   "message":"Field \"name\" must be at least 1 characters long","code":"minLength"}]}

curl -X POST http://127.0.0.1:3000/greetings \
  -H 'content-type: application/json' -d '{"name":42}'
# 400 {"error":"Validation failed","details":[{"property":"name",
#   "message":"Field \"name\" must be of type string, got: number","code":"type"}]}
```

Теперь откройте в браузере <http://127.0.0.1:3000/docs>. Там уже описаны все
три маршрута `/greetings`: параметры, тело запроса с правилами проверки и ответы. bazis
строит документацию из кода при кодогенерации, поэтому она не расходится с
API. В `production` страница по умолчанию выключена, подробнее — в
[«OpenAPI»](../http/openapi.md).

## 9. Запускаем тесты — одна команда

```sh
bunx bazis test
```

Команда запускает кодогенерацию и `bun test`. В проекте уже есть тест
`src/app/test/health.test.ts`: он запускает приложение и проверяет `/health`.
Свои тесты кладите рядом в файлы `*.test.ts`. Ставить и настраивать тестовый
фреймворк не нужно.

## 10. Собираем один файл для сервера

```sh
bunx bazis build --bin
```

Получится `bin/my-app` — около 62 МБ, внутри приложение и сам Bun. На
сервере не нужны ни Bun, ни `node_modules`, ни исходники:

```sh
BAZIS_ENV=production ./bin/my-app
```

Сервер на Linux, а работаете на Mac? Соберите файл для него прямо отсюда:

```sh
bunx bazis build --bin --platform linux-x64
```

`BAZIS_ENV` выбирает окружение: `development`, `test` или `production`.
Без этой переменной (и без `NODE_ENV`) приложение работает как `production`.

> **Важно для старых бинарников.** В версиях до 0.96.3 бинарник без `BAZIS_ENV` по ошибке запускался как
> `development` — с подробностями ошибок в ответах и страницей OpenAPI. Если
> у вас бинарник, собранный старой версией, задавайте
> `BAZIS_ENV=production` явно.

## Что получилось

За десять шагов вы написали сервис, которому не понадобились ни ручная
регистрация зависимостей, ни код проверки входных данных, ни описание API, ни
Docker: всё это сделал фреймворк. На сервер едет один файл.

## Что дальше

- [Основные понятия](essentials.md) — модули, DI, контроллеры, кодогенерация
  и конфигурация подробнее
- [Учебный проект](tutorial.md) — планировщик задач с PostgreSQL, входом по
  JWT и двумя модулями, до исполняемого файла
