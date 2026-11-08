# Первые шаги

**15 минут — и у вас готовый API.**

Мы сделаем маленький сервис пользователей. Он умеет три вещи: добавить
пользователя, найти его по имени и показать всех.

Что будет в конце:

- маршруты `GET` и `POST`, которые сами проверяют входные данные;
- страница с документацией API — её не нужно писать;
- тесты, которые запускаются одной командой;
- один файл, который можно скопировать на сервер.

Нужен только Bun 1.4.0 или новее. База данных не понадобится.

## 1. Создаём проект

```sh
bunx bazis new MyApp
cd my-app
bun install
```

Готово. В папке `my-app` уже лежит рабочий проект:

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

Посмотрим на точку входа `src/index.ts`:

```ts
import { runApp } from "bazis/core/app";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, { http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true } });
```

Здесь две строки:

- `registerBazisGeneratedRuntime()` подключает код из папки `src/generated/`.
- `runApp(AppModule, ...)` запускает приложение и включает адрес `/health`.

> **Что за папка `src/generated/`?** Её создаёт сам bazis при каждом запуске.
> Там записано, какой класс от какого зависит. Руками её не меняют: при
> следующем запуске bazis всё равно перезапишет её. В Git её тоже не кладут:
> она восстанавливается сама. В `.gitignore` нового проекта она уже есть.

Корневой модуль пока пустой:

```ts
import { Module } from "bazis/core/di";

@Module({ imports: [], exports: [] })
export class AppModule {}
```

## 2. Запускаем

```sh
bunx bazis dev
```

В консоли появится строка:

```text
info: bazis started {"environment":"development","debug":true,...}
```

Проверяем:

```sh
curl http://127.0.0.1:3000/health
# {"healthy":true,"checks":[]}
```

Приложение уже работает, а вы ещё не написали ни строчки кода.

Что пригодится при разработке:

| Задача | Как сделать |
| --- | --- |
| Запустить на другом порту | `PORT=3100 bunx bazis dev` |
| Слушать другой адрес | переменная `HOST`, например `HOST=0.0.0.0` |
| Перезапускать при изменениях в `src/` | `bunx bazis dev --watch` |
| Остановить приложение | `Ctrl+C` |

## 3. Создаём модуль

Модуль — это папка с кодом про одну тему. У нас тема — пользователи.

Модули создают через CLI. Он сам делает нужные файлы и подключает модуль к
приложению. Сервис и контроллер мы напишем сами, поэтому просим пустой модуль
— флаг `--empty`:

```sh
bunx bazis g module Users --empty
```

```text
  ── FILES ────────────────────────────────────────────── src/app/modules/users
  [OK  ]  files           3 changes
    ├─ + src/app/modules/users/Users.module.ts
    ├─ + src/app/modules/users/MODULE.md
    └─ ~ src/app/modules/App.module.ts
  ↗  connected in src/app/modules/App.module.ts

    ✔  SUCCESS   module Users is generated
```

CLI сделал три вещи:

- создал файл модуля `Users.module.ts`;
- создал `MODULE.md` — короткое описание: за что отвечает модуль;
- подключил модуль к корневому:

```ts
@Module({ imports: [UsersModule], exports: [] })
export class AppModule {}
```

Без `--empty` CLI сразу кладёт в модуль пример кода. Какие бывают варианты —
в [«Командах CLI»](../cli/commands.md#bazis-g-module).

## 4. Пишем сервис

Сервис хранит логику. Наш сервис хранит список пользователей.

Сначала опишем, **что** сервис умеет. Это контракт. Создайте файл
`src/app/modules/users/services/IUsers.service.ts`:

```ts
export interface User {
  name: string;
}

export abstract class IUsersService {
  abstract getAll(): readonly User[];
  abstract find(name: string): User | undefined;
  abstract create(name: string): User;
}
```

Теперь напишем, **как** он это делает. Создайте рядом файл `Users.service.ts`:

```ts
import { IUsersService, type User } from "./IUsers.service";

export class UsersService implements IUsersService {
  private readonly users: User[] = [];

  getAll(): readonly User[] {
    return this.users;
  }

  find(name: string): User | undefined {
    return this.users.find((user) => user.name === name);
  }

  create(name: string): User {
    const user = { name };
    this.users.push(user);
    return user;
  }
}
```

Это обычный класс. Никаких декораторов и регистрации не нужно.

Зачем два файла? Контроллер будет знать только контракт `IUsersService`. Какой
класс стоит за ним, решает модуль. Сегодня пользователи хранятся в памяти.
Завтра вы напишете версию с базой данных, а в тестах подставите заглушку.
Контроллер при этом не меняется ни на строчку.

Контракт — это абстрактный класс, а не `interface`. Интерфейсы TypeScript
пропадают при запуске, а абстрактный класс остаётся. По нему bazis и находит
нужную реализацию.

## 5. Описываем, что приходит в запросе

Клиент присылает имя нового пользователя. Опишем, каким оно должно быть.

Создайте файл `src/app/modules/users/http/contracts/Users.requests.ts`:

```ts
import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class CreateUserRequest {
  @Validator({ required: true, minLength: 1, maxLength: 50 })
  name!: string;
}
```

Строка `@Validator` — это все правила:

- имя обязательно;
- длина от 1 до 50 символов;
- это строка, а не число.

Если запрос нарушает правила, bazis сам ответит ошибкой 400. Ваш код даже не
запустится. Отдельная библиотека для проверок не нужна.

## 6. Пишем контроллер

Контроллер принимает запросы и передаёт их сервису.

Создайте файл `src/app/modules/users/http/Users.controller.ts`:

```ts
import { Controller, Created, Get, HttpContext, NotFound, Post } from "bazis/core/http";
import { IUsersService } from "../services/IUsers.service";
import { CreateUserRequest } from "./contracts/Users.requests";

@Controller("users")
export class UsersController {
  constructor(private readonly users: IUsersService) {}

  @Get()
  getAll() {
    return this.users.getAll();
  }

  @Get(":name")
  getByName(name: string) {
    return this.users.find(name) ?? NotFound({ error: `User ${name} not found` });
  }

  @Post()
  create(body: CreateUserRequest, ctx: HttpContext) {
    const user = this.users.create(body.name);
    return Created(`${ctx.path}/${encodeURIComponent(user.name)}`, user);
  }
}
```

Как это читать:

- `@Controller("users")` — все адреса начинаются с `/users`.
- `getAll()` отдаёт всех пользователей.
- `getByName(name)` ищет одного. Нет такого — ответ 404 (`NotFound`).
- `create(...)` добавляет пользователя. Ответ 201 (`Created`) и адрес нового
  пользователя.

Откуда берутся аргументы? bazis смотрит на их имена и типы:

| Аргумент | Откуда bazis его берёт |
| --- | --- |
| `name: string`, в адресе есть `:name` | из адреса: `/users/Anna` → `"Anna"` |
| `body: CreateUserRequest` | из тела запроса, сразу с проверкой |
| `ctx: HttpContext` | сведения о текущем запросе |
| простой тип, которого нет в адресе | из строки запроса: `?limit=10` |

Сервис приходит в контроллер через конструктор. Контроллер просит контракт
`IUsersService`, а bazis передаёт реализацию, которую выбрал модуль.

Если bazis не поймёт, откуда взять аргумент, он скажет об этом сразу, ещё до
запуска. В ошибке `BAZIS_HTTP_BINDING_UNRESOLVED` будут метод и причина.

## 7. Собираем модуль

Осталось сказать модулю, что в нём есть. Откройте
`src/app/modules/users/Users.module.ts` и замените содержимое:

```ts
import { Module, singleton } from "bazis/core/di";
import { UsersController } from "./http/Users.controller";
import { IUsersService } from "./services/IUsers.service";
import { UsersService } from "./services/Users.service";

@Module({
  providers: [singleton(IUsersService, UsersService)],
  controllers: [UsersController],
  exports: [IUsersService],
})
export class UsersModule {}
```

Три списка:

- `providers` — сервисы модуля. `singleton(IUsersService, UsersService)`
  читается так: «кто просит `IUsersService`, получит `UsersService`». Один на
  всё приложение, поэтому список пользователей не пропадает между запросами.
- `controllers` — контроллеры модуля.
- `exports` — что можно брать из этого модуля в других модулях. Отдаём
  контракт, а не класс: соседям незачем знать, как сервис устроен внутри.

## 8. Проверяем

Если `bunx bazis dev` запущен без `--watch`, перезапустите его.

```sh
curl http://127.0.0.1:3000/users/Anna
# 404 {"error":"User Anna not found"}

curl -i -X POST http://127.0.0.1:3000/users \
  -H 'content-type: application/json' -d '{"name":"Anna"}'
# HTTP/1.1 201 Created
# Location: /users/Anna
# {"name":"Anna"}

curl http://127.0.0.1:3000/users/Anna
# {"name":"Anna"}

curl http://127.0.0.1:3000/users
# [{"name":"Anna"}]
```

Теперь пошлём плохие данные. Пустое имя и число вместо имени:

```sh
curl -X POST http://127.0.0.1:3000/users \
  -H 'content-type: application/json' -d '{"name":""}'
# 400 {"error":"Validation failed","details":[{"property":"name",
#   "message":"Field \"name\" must be at least 1 characters long","code":"minLength"}]}

curl -X POST http://127.0.0.1:3000/users \
  -H 'content-type: application/json' -d '{"name":42}'
# 400 {"error":"Validation failed","details":[{"property":"name",
#   "message":"Field \"name\" must be of type string, got: number","code":"type"}]}
```

Оба запроса остановлены. Ни одной строчки проверок в нашем коде нет.

А теперь откройте в браузере <http://127.0.0.1:3000/docs>. Там уже описаны
все три адреса `/users`: что принимают и что отвечают. bazis строит эту
страницу из вашего кода, поэтому она всегда совпадает с API. В `production`
страница выключена. Подробнее — в [«OpenAPI»](../http/openapi.md).

## 9. Запускаем тесты

```sh
bunx bazis test
```

В проекте уже есть тест `src/app/test/health.test.ts`. Он запускает
приложение и проверяет `/health`. Свои тесты кладите рядом, в файлы
`*.test.ts`. Ничего дополнительно ставить не нужно.

## 10. Собираем один файл для сервера

```sh
bunx bazis build --bin
```

Получится файл `bin/my-app`, около 62 МБ. Внутри — ваше приложение и сам Bun.
На сервере больше ничего не нужно:

```sh
BAZIS_ENV=production ./bin/my-app
```

Сервер на Linux, а вы на Mac? Соберите файл для Linux прямо у себя:

```sh
bunx bazis build --bin --platform linux-x64
```

`BAZIS_ENV` — это окружение: `development`, `test` или `production`. Если его
не указать, файл работает как `production`.

> **Если у вас старый файл.** До версии 0.96.3 файл без `BAZIS_ENV` по ошибке
> работал как `development`: показывал подробности ошибок и страницу
> документации. Для таких файлов задавайте `BAZIS_ENV=production` явно.

## Что получилось

За десять шагов у вас готов сервис. Вы не регистрировали классы руками, не
писали проверки, не описывали API и не настраивали Docker. Это сделал bazis.
На сервер едет один файл.

## Что дальше

- [Основные понятия](essentials.md) — модули, сервисы, контроллеры и настройки
  подробнее.
- [Учебный проект](tutorial.md) — планировщик задач с базой данных, входом по
  паролю и двумя модулями.
