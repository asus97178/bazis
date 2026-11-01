# Права модулей: `bazis/core/access`

Как раздать права так, чтобы модуль не знал про роли, а админ настраивал их
без программиста. Модуль объявляет, что у него можно разрешить. Система прав
приложения говорит, что дано человеку. Проверку и фильтр списков делает
фреймворк.

Все примеры проверены на bazis 0.129.0. Устройство целиком — в спецификации
[ACCESS-001](../../architecture/ACCESS.md).

## Три участника

| Кто | Что делает |
| --- | --- |
| Модуль с действиями («Заказы», процессы, дата-менеджер) | Объявляет права: `@Module({ permissions })` |
| Система прав приложения | Отвечает, что дано человеку по праву: гранты. По умолчанию — роли из токена, у CMS — свой модуль ролей |
| Фреймворк | Проверяет объект и строит условие списка по грантам |

Модулям без действий для раздачи (ORM, очереди) права не нужны: их маршруты
защищает обычный `@Authorize` из главы [Авторизация](../overview/authorization.md).

## Объявить права

```ts
import { definePermissions } from "bazis/core/access";

export const orderPermissions = definePermissions({
  "orders.read": {
    title: { ru: "Видеть заказы", en: "See orders" },
    scope: { column: "shopId" },          // раздел заказа — его магазин
    on: { status: { type: "string" } },   // по чему можно ставить условия
    owner: "customerId",                  // «свои» заказы
  },
  "orders.export": { title: "Выгружать заказы" },
});
```

- Ключ — `<модуль>.<объект>.<действие>`, один на приложение.
- `scope` — откуда у объекта раздел (магазин, пространство, арендатор):
  - колонка `{ column }`;
  - `"request"` — раздел приходит из запроса;
  - `{ lookup }` — его вычисляет класс модуля;
  - по умолчанию `"none"`: у права нет раздела.
- `on` — атрибуты для условий: `type` для простых значений, `ref` для
  ссылок (о них ниже). Атрибут не колонка строки — `lookup`.
- `owner` — колонка владельца, с ней работает условие «своё».

Права подключаются полем модуля, а `AccessModule` — один раз в приложении:

```ts
import { AccessModule } from "bazis/core/access";

@Module({ imports: [AccessModule], permissions: orderPermissions, controllers: [OrdersController] })
export class OrdersModule {}
```

Ошибка в объявлении останавливает старт, а не запрос: неверный ключ, слово
условия (`all`, `any`, `not`, `own`, `scope`) как имя атрибута, одно право в
двух модулях, `AccessModule` не подключён.

## Проверить маршрут

```ts
import { IAccess, can } from "bazis/core/access";

@Controller("orders")
export class OrdersController {
  @Get("export")
  @Authorize(can("orders.export"))
  exportAll() { … }

  @Get(":id")
  async get(ctx: HttpContext) {
    const order = await this.orders.find(ctx.params.id);
    const access = await ctx.services.resolve(IAccess).for(ctx);
    if (!(await access.can("orders.read", { ...order, scope: order.shopId }))) throw new NotFoundError();
    return order;
  }
}
```

- `can(право)` без объекта пропускает, если право есть хоть где-нибудь: так
  маршрут защищён до того, как объект загружен.
- Объект проверяет обработчик: атрибуты берутся из полей объекта, раздел —
  из `scope`.
- Нет человека — `401`, нет права — `403`. Чужой объект обработчик может
  скрыть как `404`.

## Отфильтровать список

```ts
import { grantsToWhere } from "bazis/core/access";

async list(ctx: HttpContext) {
  const access = await ctx.services.resolve(IAccess).for(ctx);
  const where = grantsToWhere(await access.filter("orders.read"));
  if (where === "none") return { data: [], meta: { total: 0 } };
  let query = this.db.orders.asNoTracking();
  if (where !== "all") query = query.where(() => where);
  …
}
```

Фильтр — одно условие ORM по всем грантам сразу: магазины, «свои», условия
на атрибутах. Клиент не перебирает магазины по одному.

## Роли по умолчанию

Если своей системы прав нет, работают роли из токена. Права ролей
объявляются полем модуля:

```ts
import { defineRoles } from "bazis/core/access";

export const appRoles = defineRoles({
  admin: "all",
  clerk: ["orders.read:own"],
  auditor: ["orders.read", "orders.export"],
});

@Module({ imports: [AccessModule, OrdersModule], roles: appRoles })
export class AppModule {}
```

- Человек — принципал, которого положила проверка входа
  (`ctx.state` под `PRINCIPAL_STATE_KEY`), роли — из claim `role` через
  пробел или запятую.
- `"orders.read:own"` — только свои заказы. Нужны условия — вместо строки
  грант: `{ permission: "orders.read", where: { status: { in: ["new", "paid"] } } }`.
- Без ролей всё запрещено. Роль с несуществующим правом останавливает старт.
- Настройка `access`: `roleClaim` (по умолчанию `role`), `kindClaim` (claim с
  видом учётки), `maxInList` (до 1000 значений в одном списке условия).

## Своя система прав

Модуль ролей CMS, учётки из своей таблицы, внешний сервис — всё это
реализация `AccessPolicy`:

```ts
import { AccessPolicy, type AccessSubject, type Grants, type Scope } from "bazis/core/access";

export class AppAccessPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext) {
    const user = ctx.state.get(PRINCIPAL_STATE_KEY) as User | undefined;
    return user && { sub: `user:${user.id}`, act: user.companyId };
  }

  async grants(subject: AccessSubject, permission: string): Promise<Grants> {
    if (await this.roles.isAdmin(subject.sub)) return "all";
    return await this.roles.grantsOf(subject.sub, permission); // [{ scopes: ["shop-1"], where: { status: { eq: "new" } } }]
  }

  ownerIds(subject: AccessSubject) { return [subject.sub.slice("user:".length)]; }

  async principals(subject: AccessSubject, scopes: readonly Scope[]) {
    return scopes.map((scope) => ({ scope, principals: [`user:${subject.sub.slice(5)}`] }));
  }
}

// в модуле приложения: своя система прав вместо ролей по умолчанию
singleton(AccessPolicy, AppAccessPolicy)   // или scoped, если ей нужен DbContext
```

Грант — где (`scopes`: список разделов или `"all"`) и при каком условии
(`where`). Условие — дерево `all` / `any` / `not` и проверок атрибутов
`eq`, `in`, `notIn`, `isNull`, плюс `{ own: true }`. Значения готовые:
«моя организация» система прав подставляет сама. Грант, который право не
может принять (неизвестный атрибут, `own` без `owner`), отбрасывается с
предупреждением в журнале и никогда не расширяет доступ.

## Ссылки и каталог для админки

Экрану ролей нужен список прав и значения для условий («какие процессы»).
Модуль объявляет виды ссылок, которыми владеет:

```ts
@Module({
  imports: [AccessModule],
  permissions: orderPermissions,
  references: { "orders.process": ProcessReferences },
  providers: [singleton(ProcessReferences)],
})
```

`ProcessReferences` наследует `References`: `exists`, `describe`, `search`.
Каталог читается по HTTP с правом `access.catalog.read`:

- `GET /access/catalog` — права всех модулей с атрибутами;
- `GET /access/references/orders.process?search=сч` — значения для выбора.

## Тесты

```ts
import { StaticAccessPolicy } from "bazis/core/access/testing";

const policy = new StaticAccessPolicy({
  grants: { "user:7": { "orders.read": [{ scopes: "all", where: { own: true } }] } },
});
const app = await startTestApp(AppModule, {
  overrides: [singletonValue(AccessPolicy, policy)],
});
```

Без HTTP — в своей области DI:

```ts
const scope = app.container.createScope();
const access = scope.resolve(IAccess).as({ sub: "user:7" }, scope);
```

## Дальше

- [Шаблоны авторизации](authorization-patterns.md) — проверки входа, `anyOf`, ключи API
- [Спецификация ACCESS-001](../../architecture/ACCESS.md)
