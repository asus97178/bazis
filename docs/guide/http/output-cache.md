# Кэширование ответов

`@OutputCache` сохраняет готовый HTTP-ответ и отдаёт его повторно, не
вызывая метод контроллера. Подходит для данных, которые читают часто, а
меняют редко: каталог, справочники, публичная статистика.

Все примеры проверены на bazis 0.98.10.

## Подключение

Кэш — отдельный модуль, его подключают в `runApp`:

```ts
import { memory } from "bazis/core/cache";

await runApp(AppModule, {
  cache: memory({ maxEntries: 1000 }),
  http: { port: 3000 },
});
```

```ts
import { OutputCache } from "bazis/core/cache";

@Controller("tasks")
export class TasksController {
  @Get()
  @OutputCache({ seconds: 60, tags: ["tasks"] })
  getAll(page = 1) {
    return this.tasks.getAll(page);
  }
}
```

```text
GET /tasks → метод вызван, ответ сохранён
GET /tasks → из кэша, метод не вызван   Age: 1
...через 60 секунд
GET /tasks → метод вызван снова
```

`Age` — сколько секунд ответ пролежал в кэше. По нему видно, что ответ
пришёл из кэша.

Если модуль кэша не подключён, декоратор ничего не делает, и при
запуске об этом будет предупреждение:

```text
warn: [cache] @OutputCache on TasksController.getAll has no effect: no cache module is installed,
so every request runs the action. Add `cache: memory()` to the runApp options.
```

> [!NOTE]
> Заголовок `Age` и предупреждение — с версии 0.98.10. Раньше
> `@OutputCache` без модуля кэша молча не работал.

## Что отличает один ответ от другого

Ключ записи по умолчанию — метод, путь и **вся** строка запроса:
`/tasks/7` и `/tasks/8`, `?page=1` и `?page=2` — разные записи.

| Настройка | Что меняет |
| --- | --- |
| `varyByQuery: ["page"]` | Учитывать только перечисленные параметры: `?page=1&debug=true` и `?page=1&debug=false` — одна запись |
| `varyByQuery: []` | Строку запроса не учитывать вовсе |
| `varyByHeader: ["accept-language"]` | Отдельная запись на каждое значение заголовка |
| `varyByUser: true` | Отдельная запись на пользователя |
| `varyByClaim: "role"` | Отдельная запись на значение утверждения, например роль |

Ограничивайте `varyByQuery`, если в адрес попадают случайные параметры
(метки рекламы, `?_=timestamp`): иначе каждый такой запрос создаст свою
запись.

## Что не кэшируется

| Ответ | Почему |
| --- | --- |
| С кодом не `200` | По умолчанию `statusCodes: [200]` — ошибки и `404` всегда свежие |
| На `POST`, `PUT`, `DELETE` | По умолчанию `methods: ["GET", "HEAD"]` |
| С `Set-Cookie` | Ответ, создающий сессию, нельзя раздавать другим |
| С `Cache-Control: private` или `no-store` от метода | Метод сам запретил общий кэш |
| Тело больше 16 МиБ или не прочитанное за 5 секунд | Пределы `maxBodyBytes`, `bodyReadTimeoutMs` |

## Сброс при изменении данных

Кэш не знает, когда данные изменились. После записи сбросьте записи по
тегу:

```ts
import { ICache } from "bazis/core/cache";

export class TasksService {
  constructor(private readonly db: AppDb, private readonly cache: ICache) {}

  async create(input: CreateTaskRequest) {
    const task = await this.db.tasks.add(input);
    await this.cache.evictByTag("tasks");   // все записи с tags: ["tasks"]
    return task;
  }
}
```

Следующий `GET /tasks` вызовет метод и сохранит свежий ответ. Без сброса
клиенты видят старые данные до конца `seconds`.

## Кэш браузера и CDN

`clientCache` добавляет `Cache-Control`, чтобы ответ кэшировали и
браузер или CDN:

```ts
@OutputCache({ seconds: 60, clientCache: { public: true, maxAge: 30 } })
```

```text
Cache-Control: public, max-age=30
```

| Поле | Директива |
| --- | --- |
| `maxAge: 30` | `max-age=30` |
| `public: true` | `public` — можно хранить в общих кэшах (CDN) |
| `private: true` | `private` — только браузер пользователя |
| `noCache: true` | `no-cache` — браузер должен перепроверять ответ |

Серверный кэш и кэш браузера независимы: сброс по тегу на сервере не
очищает то, что уже сохранил браузер на `maxAge` секунд.

## Защищённые маршруты

Ответ защищённого маршрута нельзя отдавать другому пользователю. Поэтому
`@OutputCache` под `@Authorize` без разделения по пользователю — ошибка
при запуске:

```text
[cache] @OutputCache on UsersController.list is on an authorized route without varyByUser or
unlessAuthenticated — responses may leak between users. Add varyByUser: true or unlessAuthenticated: true.
```

| Вариант | Что получится |
| --- | --- |
| `varyByUser: true` | Своя запись у каждого пользователя; `Cache-Control` всегда `private` |
| `varyByClaim: "role"` | Одна запись на роль: все администраторы получают общий ответ |
| `unlessAuthenticated: true` | Кэш только для анонимных запросов; вошедшие всегда получают свежий ответ |

Пользователя кэш берёт из `ctx.state` по ключу `PRINCIPAL_STATE_KEY` —
его кладёт ваша проверка в `@Authorize` (см. [Авторизацию](../overview/authorization.md)).
`subject` нужен для `varyByUser`, `findFirst(type)` — для `varyByClaim`.

`clientCache: { public: true }` вместе с `varyByUser` или `varyByClaim` —
ошибка при запуске `personalized output cache cannot use clientCache.public`:
персональный ответ нельзя отдавать в CDN.

Персональные данные надёжнее кэшировать в сервисе через `@Cacheable` с
явным ключом — об этом глава «Кэширование» *(в работе)*.

## Именованные политики

Одинаковые настройки для многих маршрутов задайте один раз:

```ts
await runApp(AppModule, {
  cache: memory({
    policies: {
      catalog: { seconds: 60, varyByQuery: ["page"], tags: ["catalog"], clientCache: { public: true, maxAge: 30 } },
    },
  }),
  http: { port: 3000 },
});
```

```ts
@Get()
@OutputCache({ policy: "catalog" })
getAll(page = 1) { ... }

@Get("featured")
@OutputCache({ policy: "catalog", seconds: 300 })   // поля декоратора важнее политики
featured() { ... }
```

> [!NOTE]
> `memory({ policies })` — с версии 0.98.10. Раньше политики задавались
> только через внутренний `buildCacheModule`.

## Все настройки

| Поле | По умолчанию | Что задаёт |
| --- | --- | --- |
| `seconds` | — | Сколько секунд хранить запись; обязательно (в декораторе или политике) |
| `policy` | — | Имя политики из `memory({ policies })` |
| `tags` | — | Теги для `evictByTag` |
| `varyByQuery` | `"*"` — все параметры | Какие параметры строки запроса входят в ключ |
| `varyByHeader` | — | Какие заголовки входят в ключ |
| `varyByUser`, `varyByClaim` | — | Разделение по пользователю или утверждению |
| `unlessAuthenticated` | `false` | Не кэшировать для вошедших |
| `methods` | `GET`, `HEAD` | Для каких методов работает кэш |
| `statusCodes` | `[200]` | Какие коды сохранять |
| `clientCache` | — | `Cache-Control` для браузера и CDN |
| `when` | — | `(ctx) => boolean`: `false` — запрос идёт мимо кэша |
| `enabled` | `true` | `false` — декоратор отключён |
| `noStore` | `false` | `true` — не читать и не писать кэш |
| `maxBodyBytes`, `bodyReadTimeoutMs` | 16 МиБ, 5000 мс | Пределы тела для сохранения |

Кэш на `@Controller` действует на все методы класса; кэш на методе
важнее.

## Память и несколько экземпляров

`memory()` хранит записи в памяти процесса: они пропадают при
перезапуске, а у каждого экземпляра приложения кэш свой. Размер
ограничивает `maxEntries` — при переполнении удаляются самые давно не
использованные записи. Общий кэш для нескольких экземпляров —
`@OutputRedisCache` с Redis *(глава в работе)*.

## Дальше

- [Ограничение частоты запросов](rate-limit.md)
- [Авторизация](../overview/authorization.md)
- [HTTP-клиент](http-client.md)
