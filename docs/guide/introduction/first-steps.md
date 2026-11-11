# Первые шаги

**15 минут — и у вас готовый API.**

Мы сделаем маленький сервис пользователей. Он умеет три вещи: добавить
пользователя, найти его по номеру и показать всех.

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
├── .env.example            пример настроек (BAZIS_ENV, BAZIS_HTTP__HOST, BAZIS_HTTP__PORT)
├── .gitignore
├── AGENTS.md               правила для AI-ассистентов, работающих с проектом
├── README.md
├── docs/architecture/MODULE_ARCHITECTURE.md
└── src/
    ├── index.ts            точка входа: запускает приложение
    └── app/
        ├── App.ts                  объявление приложения: модули и серверы
        ├── modules/App.module.ts   корневой модуль
        └── test/health.test.ts     тест: приложение стартует и отвечает на /health
```

Приложение объявлено в `src/app/App.ts`:

```ts
import { App } from "bazis/core/app";
import { AppModule } from "./modules/App.module";

@App({
  modules: [AppModule],
  http: { health: true },
})
export class Application {}
```

- `modules` — из чего состоит приложение. Здесь один корневой модуль.
- `http: { health: true }` — приложение поднимает HTTP-сервер с адресом `/health`.

**Где слушает сервер.** Адрес и порт в коде не пишут, их задают настройки:

| Режим | Адрес по умолчанию | Почему |
| --- | --- | --- |
| Разработка и тесты | `127.0.0.1:3000` | Приложение видно только с вашей машины |
| `production` | `0.0.0.0:3000` | Приложение принимает запросы со всех адресов сервера |

Поменять можно двумя переменными, `BAZIS_HTTP__HOST` и `BAZIS_HTTP__PORT`.
Задайте их прямо в команде:

```sh
BAZIS_HTTP__PORT=3100 bunx bazis dev
```

или один раз в файле `.env` в корне проекта. Пример есть в `.env.example`:

```sh
BAZIS_HTTP__HOST=127.0.0.1
BAZIS_HTTP__PORT=3100
```

Bun читает `.env` сам. Собранный для сервера файл его не читает: там те же
переменные задают в окружении, например в настройках службы.

Порт можно записать и в коде, `@App({ http: { port: 3100 } })`. Но тогда
переменная его уже не поменяет: на сервере понадобится правка кода. Поэтому
лучше оставить адрес настройкам.

Точка входа `src/index.ts` его запускает:

```ts
import { runApp } from "bazis/core/app";
import { Application } from "./app/App";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(Application);
```

Здесь две строки:

- `registerBazisGeneratedRuntime()` подключает код из папки `src/generated/`.
- `runApp(Application)` запускает объявленное приложение.

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
| Запустить на другом порту | `BAZIS_HTTP__PORT=3100 bunx bazis dev` |
| Слушать другой адрес | переменная `BAZIS_HTTP__HOST`, например `BAZIS_HTTP__HOST=0.0.0.0` |
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
  id: number;
  name: string;
}

export abstract class IUsersService {
  abstract getAll(): readonly User[];
  abstract find(id: number): User | undefined;
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

  find(id: number): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  create(name: string): User {
    const user = { id: this.users.length + 1, name };
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
import { Controller, Created, Get, NotFound, Post } from "bazis/core/http";
import { IUsersService } from "../services/IUsers.service";
import { CreateUserRequest } from "./contracts/Users.requests";

@Controller("users")
export class UsersController {
  constructor(private readonly users: IUsersService) {}

  @Get()
  getAll() {
    return this.users.getAll();
  }

  @Get(":id")
  getById(id: number) {
    return this.users.find(id) ?? NotFound({ error: `User ${id} not found` });
  }

  @Post()
  create(body: CreateUserRequest) {
    const result = this.users.create(body.name);
    return Created(result);
  }
}
```

Как это читать:

- `@Controller("users")` — все адреса начинаются с `/users`.
- `getAll()` отдаёт всех пользователей.
- `getById(id)` ищет одного по номеру. Нет такого — ответ 404 (`NotFound`).
- `create(...)` добавляет пользователя и возвращает его через `Created`. Это
  ответ 201 Created. Адрес нового пользователя, например `/users/1`, bazis сам
  положит в заголовок `Location`: он знает путь запроса и видит `id` в ответе.

Методы просто возвращают значение. bazis сам превратит его в ответ: объект или
массив уйдёт как JSON с кодом 200, а «ничего» — пустым ответом 204.

Откуда берутся аргументы? bazis смотрит на их имена и типы:

| Аргумент | Откуда bazis его берёт |
| --- | --- |
| `id: number`, в адресе есть `:id` | из адреса: `/users/1` → `1`, уже числом |
| `body: CreateUserRequest` | из тела запроса, сразу с проверкой |
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
  Остальное спрятано: если чужой модуль попросит неэкспортированный сервис,
  приложение не запустится и подскажет, что добавить в `exports`.

Кроме `singleton` есть ещё два варианта:

| Функция | Сколько живёт сервис | Когда брать |
| --- | --- | --- |
| `singleton` | Один на всё приложение | Кэши, клиенты, данные в памяти, как у нас |
| `scoped` | Свой на каждый запрос | Обычно для работы с базой |
| `transient` | Новый каждый раз, когда его просят | Лёгкие объекты без общего состояния |

Ошибки в этих списках не доживут до первого запроса. Забыли сервис в
`providers` или `singleton` зависит от `scoped`? Приложение не запустится и
скажет, что не так. Подробнее — в [«Провайдерах и DI»](../overview/providers.md).

## 8. Проверяем

Если `bunx bazis dev` запущен без `--watch`, перезапустите его.

```sh
curl http://127.0.0.1:3000/users/1
# 404 {"error":"User 1 not found"}

curl -i -X POST http://127.0.0.1:3000/users \
  -H 'content-type: application/json' -d '{"name":"Anna"}'
# HTTP/1.1 201 Created
# Location: /users/1
# {"id":1,"name":"Anna"}

curl http://127.0.0.1:3000/users/1
# {"id":1,"name":"Anna"}

curl http://127.0.0.1:3000/users
# [{"id":1,"name":"Anna"}]
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

И буквы вместо номера в адресе:

```sh
curl http://127.0.0.1:3000/users/abc
# 400 {"error":"Validation failed","details":[{"property":"id",
#   "message":"Field \"id\" must be of type number, got: string","code":"type"}]}
```

Все три запроса остановлены. Ни одной строчки проверок в нашем коде нет.

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
Копируете его на сервер и запускаете:

```sh
./bin/my-app
```

Больше на сервере ничего не нужно: ни Bun, ни Node.js, ни `node_modules`.

Сервер на Linux, а вы на Mac? Соберите файл для Linux прямо у себя:

```sh
bunx bazis build --bin --platform linux-x64
```

### Три режима: один код ведёт себя правильно везде

Пока вы пишете код, вам нужны подробные ошибки и страница `/docs`. На сервере
это опасно: подробности ошибки подсказывают злоумышленнику, как устроено
приложение. В тестах нужна своя база, чтобы не испортить рабочие данные.

Обычно для этого пишут `if (isProduction)` по всему коду, и рано или поздно
где-то забывают. В bazis это делает режим:

| Режим | Где включается | Что получаете |
| --- | --- | --- |
| `development` | `bunx bazis dev` | Подробные ошибки прямо в ответе, страница `/docs`, подробный журнал, пароли-заглушки из кода — можно начать без настроек |
| `test` | `bunx bazis test` | Свои настройки для тестов, например отдельная база, чтобы тесты не трогали рабочие данные |
| `production` | Собранный файл | Ошибки без подробностей, `/docs` закрыта. Без настоящих паролей и ключей файл не запустится и назовёт, какой переменной не хватает |

Переключать руками ничего не нужно: команда сама выбирает режим. Поэтому
на сервер не уедет режим разработки, даже если вы забыли что-то настроить.

Разные значения для режимов пишутся в одном месте, рядом с настройкой:

```ts
export const mailConfig = defineConfig("mail", {
  default: { host: "localhost", apiKey: secret("dev-key") },
  production: { apiKey: secret() },   // на сервере ключ обязателен
});
```

Любую настройку можно задать переменной окружения, без правки кода:
`BAZIS_` + имя + `__` + ключ. Для примера выше — `BAZIS_MAIL__APIKEY`.
Неверное значение тоже остановит запуск и назовёт переменную.

Если нужен другой режим, задайте его переменной `BAZIS_ENV`. Например, чтобы
посмотреть подробную ошибку в собранном файле на своей машине:

```sh
BAZIS_ENV=development ./bin/my-app
```

Подробнее — в [«Настройках»](../fundamentals/configuration.md) и
[«Одном исполняемом файле»](../deployment/single-executable.md).

## Что получилось

За десять шагов у вас готов сервис. Вы не регистрировали классы руками, не
писали проверки, не описывали API и не настраивали Docker. Это сделал bazis.
На сервер едет один файл.

## Что дальше

- Каждое понятие подробно: [модули](../overview/modules.md),
  [провайдеры и DI](../overview/providers.md),
  [контроллеры](../overview/controllers.md), [ответы](../overview/responses.md),
  [настройки](../fundamentals/configuration.md),
  [кодогенерация](../fundamentals/codegen.md) и
  [путь запроса через middleware](../overview/middleware.md#порядок-выполнения).
- Настоящий проект с базой данных и входом: планировщик задач в трёх
  рецептах. Начните с [«CRUD-модуля целиком»](../recipes/crud-module.md).
