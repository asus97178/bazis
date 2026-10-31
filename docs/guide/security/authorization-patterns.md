# Шаблоны авторизации

Как устроены `@Authorize` и проверки, рассказано в главе
[Авторизация](../overview/authorization.md), а токены — в
[Аутентификации через JWT](jwt.md). Здесь — готовые решения частых задач:
текущий пользователь в сервисах, роли и права, «или» из нескольких
проверок, владелец записи, арендаторы и ключи API.

Все примеры проверены на bazis 0.109.1.

## Текущий пользователь в сервисах

`HttpContext` в сервисы не внедряется. Пользователя запроса держит
scoped-сервис, а заполняет его проверка входа:

```ts
export interface User { readonly subject: string; readonly role: "viewer" | "editor" | "admin"; readonly tenantId: string }

/** Кто делает этот запрос. */
export class CurrentUser {
  #user?: User;
  set(user: User) { this.#user = user; }
  get(): User {
    if (!this.#user) throw new UnauthorizedError();
    return this.#user;
  }
}

export const signedIn: AuthorizeCheck = async (ctx) => {
  const { payload } = await ctx.services.resolve(AuthTokens).issuer.verifyAccess(bearerToken(ctx) ?? "");
  const user: User = { subject: String(payload.sub), role: payload.role as User["role"], tenantId: String(payload.tenant) };
  ctx.state.set(PRINCIPAL_STATE_KEY, user);       // для кэша ответов и проверок
  ctx.services.resolve(CurrentUser).set(user);    // для сервисов
  return true;
};

@Module({ providers: [scoped(CurrentUser), scoped(NotesService)] })
```

`ctx.services` — scope этого запроса, поэтому сервис, внедривший
`CurrentUser`, получит тот же экземпляр:

```ts
export class NotesService {
  constructor(private readonly db: NotesDb, private readonly current: CurrentUser) {}

  async create(text: string) {
    const { subject, tenantId } = this.current.get();
    // …
  }
}
```

Для [gRPC](../realtime/grpc.md#авторизация) это тоже работает: там
`ctx.services` — scope вызова, и те же проверки защищают gRPC-методы.

Вне HTTP-запроса (фоновая задача, скрипт) пользователя нет, и
`current.get()` бросит ошибку — это лучше, чем молча работать «от
никого».

## Роли и права

Роль — проверка по одному полю:

```ts
export const hasRole = (...roles: User["role"][]): AuthorizeCheck =>
  (ctx) => roles.includes(currentUser(ctx).role);

/** Пользователь, которого сохранила проверка signedIn. */
export const currentUser = (ctx: AuthorizeContext) => ctx.state.get(PRINCIPAL_STATE_KEY) as User;
```

Когда ролей больше двух, удобнее права: роль — это набор прав, а маршрут
требует право, а не роль. Добавить роль — поправить одну таблицу:

```ts
const PERMISSIONS = {
  viewer: ["notes:read"],
  editor: ["notes:read", "notes:write"],
  admin:  ["notes:read", "notes:write", "notes:delete", "users:manage"],
} as const;
type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number];

export const can = (permission: Permission): AuthorizeCheck =>
  (ctx) => (PERMISSIONS[currentUser(ctx).role] as readonly string[]).includes(permission);

@Controller("notes")
@Authorize(signedIn)
export class NotesController {
  @Get()  @Authorize(can("notes:read"))  list() { … }
  @Post() @Authorize(can("notes:write")) create(body: NoteRequest) { … }
}
```

Зритель (`viewer`) читает, а на `POST /notes` получает `403`.

Когда права нужно раздавать в админке, ставить условия («только свои»,
«только магазин 1») и фильтровать по ним списки, вместо своей таблицы
подключите [права модулей](access.md) (`bazis/core/access`).

## «Или»: `anyOf`

`@Authorize(a, b)` требует **обе** проверки. Если подходит любая —
`anyOf`:

```ts
import { anyOf } from "bazis/core/http";

@Get("staff")
@Authorize(anyOf(hasRole("admin"), hasRole("editor")))
staff() { … }
```

| Что вернули проверки | Ответ |
| --- | --- |
| Хотя бы одна — `true` | Запрос идёт дальше; остальные не вызываются |
| Все упали как «не вошёл» (`UnauthorizedError`, `JwtError`) | `401` |
| Хотя бы одна — `false` или `ForbiddenError` | `403` |
| Какая-то бросила другую ошибку | Эта ошибка (ошибка в коде проверки, а не отказ) |

> [!NOTE]
> `anyOf` — с версии 0.98.27. Самодельный вариант с `try/catch` обычно
> отвечает `403` клиенту без учётных данных и прячет настоящие ошибки
> проверок.

## Владелец записи

«Редактировать может только автор» зависит от самой записи, а её
загружает сервис. Поэтому проверка — в сервисе, после загрузки:

```ts
async update(id: number, text: string) {
  const me = this.current.get();
  const note = await this.db.notes.find(id);
  if (!note) throw new NotFoundError();
  if (note.ownerId !== me.subject && me.role !== "admin") throw new ForbiddenError();
  note.text = text;
  await this.db.saveChanges();
  return note;
}
```

| Запрос | Ответ |
| --- | --- |
| Автор правит свою заметку | `200` |
| Другой редактор — чужую | `403` |
| Администратор — любую | `200` |

Чужой записи **другой организации** лучше отвечать `404`, а не `403`:
`403` подтверждает, что запись с таким номером существует. Как сделать это
автоматически — в следующем разделе.

## Арендаторы

В приложении для многих организаций (арендаторов) каждая видит только свои
данные. Забытый `where` в одном запросе — и чужие данные утекли. Поэтому
условие ставится один раз, на сущность, и берёт арендатора текущего
запроса:

```ts
import { Column, DbContext, DbContextOptions, Entity, Key, QueryFilter } from "bazis/core/orm";

@Entity({ table: "notes" })
@QueryFilter<Note, NotesDb>((n, db) => n.tenantId.eq(db.tenantId))
export class Note {
  @Key() id = 0;
  @Column({ type: "text" }) tenantId = "";
  @Column({ type: "text" }) ownerId = "";
  @Column({ type: "text" }) text = "";
}

export class NotesDb extends DbContext {
  readonly notes = this.set(Note);

  constructor(options: DbContextOptions, private readonly current: CurrentUser) {
    super(options);
  }

  /** Арендатор этого запроса. */
  get tenantId(): string { return this.current.get().tenantId; }
}
```

- У контекста могут быть свои зависимости после `DbContextOptions`: их
  подставляет `ormBazis` из scope запроса, как у любого сервиса.
- Фильтр с двумя параметрами получает контекст **каждого запроса** и
  вычисляется заново. Он действует в запросах, `find`, `count`, `include` и
  [немедленных изменениях](../database/immediate.md).
- Сервису больше не нужно помнить про арендатора:

  ```ts
  list() { return this.db.notes.orderBy((n) => n.id).toList(); }
  ```

  ```text
  SELECT … FROM "notes" WHERE "tenantId" = $1 ORDER BY "id" ASC   ["acme"]
  ```

- Чужая заметка не находится вовсе: `find(id)` вернёт `null`, и сервис
  ответит `404`.
- Если арендатора нет — запрос вне HTTP, `current.get()` бросает, —
  запрос **падает**, а не уходит без условия.
- Администратору, которому нужны все организации, —
  `ignoreQueryFilters()`:

  ```ts
  @Get("all") @Authorize(hasRole("admin"))
  all() { return this.db.notes.ignoreQueryFilters().count(); }
  ```

Остальное о фильтрах — несколько условий, `ignoreQueryFilters()` и
`include` — в главе [Фильтры запросов и мягкое удаление](../database/filters.md).

Фоновым задачам и скриптам, у которых нет пользователя, нужен отдельный
контекст без этого фильтра или явный `ignoreQueryFilters()` с собственным
условием.

> [!NOTE]
> Зависимости в конструкторе `DbContext` и фильтры с контекстом — с
> версии 0.98.28. Фильтр с одним параметром
> (`@QueryFilter<Note>((n) => n.archived.eq(false))`) по-прежнему
> вычисляется один раз при объявлении класса.

## Ключ API для сервисов

Сервису-клиенту (отчёты, интеграция) удобнее постоянный ключ, чем вход.
Сравнивайте ключ за постоянное время, чтобы его нельзя было подобрать по
времени ответа:

```ts
import { timingSafeEqual } from "bazis/library/jwt";

export const apiKey = (keys: readonly string[]): AuthorizeCheck => (ctx) => {
  const given = new TextEncoder().encode(ctx.header("x-api-key") ?? "");
  const known = keys.some((key) => {
    const expected = new TextEncoder().encode(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!known) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject: "service:reports" });
  return true;
};

@Controller("reports")
@Authorize(anyOf(apiKey(config.get("reportKeys")), signedIn))   // ключ или вход
export class ReportsController { … }
```

| Запрос | Ответ |
| --- | --- |
| С верным `x-api-key` | `200` |
| С токеном пользователя | `200` |
| Без ключа и токена, или с неверным ключом | `401` |

Ключи храните в настройках как секреты
([Конфигурация](../fundamentals/configuration.md)), а не в коде; для
ротации держите в списке старый и новый ключ одновременно.

## Кэш ответов

Ответы, которые зависят от пользователя, кэшируйте только с
`varyByUser` или не кэшируйте вовсе — иначе один пользователь увидит
данные другого. Кэш узнаёт пользователя по тому же `PRINCIPAL_STATE_KEY`
([Кэширование ответов](../http/output-cache.md)).

## Сводка ответов

| Ситуация | Ответ |
| --- | --- |
| Нет токена, он истёк или испорчен | `401` |
| Вошёл, но нет роли или права | `403` |
| Запись есть, но принадлежит другому пользователю | `403` |
| Запись другой организации | `404` |

## Дальше

- [Авторизация](../overview/authorization.md)
- [Права модулей](access.md)
- [Аутентификация через JWT](jwt.md)
- [Запросы](../database/queries.md)
