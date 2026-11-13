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
  ссылок (о них ниже). Атрибут не колонка строки — `lookup`. Класс
  `lookup` модуль регистрирует сам, в `providers` его не повторяют (с версии
  0.138.0); общий для нескольких модулей регистрирует и экспортирует его
  владелец.
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

### Ключи проверяет компилятор

`bazis codegen` собирает права всех модулей в один тип (`src/generated/bazis/permissions.ts`), поэтому
`can`, `access.can`, `access.filter` и `defineRoles` принимают только объявленные ключи:

```ts
@Authorize(can("orders.raed"))                       // ошибка сборки: такого права нет
defineRoles({ customer: ["orders.export:own"] })     // ошибка сборки: у права нет owner
```

- Права пакетов фреймворка (`workflow.*`, `access.catalog.read`) в типе уже есть.
- Объявление должно быть экспортированной константой, а в модуле стоит её имя: `permissions: orderPermissions`.
  `definePermissions({...})` прямо в `@Module` останавливает codegen с ошибкой `BAZIS_ACCESS_PERMISSIONS_FORM`.
- Новое право видно компилятору после перегенерации; `bazis dev`, `bazis build` и `bazis test` делают её сами.
- Гранты, которые отдаёт своя система прав, остаются строками: они приходят из базы.

Проверка ключей — с версии 0.137.0.

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
  видом учётки), `maxInList` (до 1000 значений в одном списке условия),
  `sourcePollSeconds` (опрос [источников прав](#права-которые-появляются-во-время-работы)).
- Роли называют только объявленные права. Права источников роль получает
  целиком: `"all"`.

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

### Сравнения чисел

С версии 0.140.0 число можно сравнивать: `gt`, `gte`, `lt`, `lte`.

```ts
// менять статус можно, пока сумма не больше 100 000
{ scopes: "all", where: { total: { lte: 100000 } } }

// диапазон — два условия
{ scopes: "all", where: { all: [{ total: { gte: 1000 } }, { total: { lte: 100000 } }] } }
```

- Сравнивать можно только атрибут `type: "number"`, который лежит в колонке.
  Строку, ссылку и атрибут с `lookup` сравнить нельзя: такой грант
  отбрасывается.
- Значение — число. Пустое значение (`null`) и отсутствующий атрибут ничего
  не доказывают: и «больше», и «не больше» дают отказ, как в SQL.
- Число сравнивается как число, а не как текст. Колонка `decimal` отдаёт
  строку `"100000.00"`, и она равна `100000`. Это верно и для `eq`, `in`,
  `notIn`.
- Сравнение точное, без перевода в `double`. Проверка объекта и фильтр
  списка дают один ответ на одной записи. Для `decimal` это верно всегда.
  Для `integer` фильтр точен при любом размере числа, но ORM читает целое
  больше 2⁵³ округлённым: такое значение передавайте в `can` строкой или
  `bigint`. `real` — это `double` и в базе, и в коде.

### Проверить правило при сохранении

Система прав хранит правила в базе. Правило с ошибкой во время запроса
просто не сработает, а администратор об этом не узнает. Проверьте его при
сохранении:

```ts
const problem = await catalog.grantProblem("orders.read", { scopes: "all", where: rule });
if (problem !== undefined) throw new HttpError(422, problem);
```

`IAccessCatalog.grantProblem` делает те же проверки, что и запрос:
неизвестный атрибут, `own` без `owner`, сравнение строки, слишком длинный
список. Ответ — текст причины или `undefined`.

### Объяснить решение

С версии 0.141.0. Экрану «почему человеку можно или нельзя» нужно знать,
какое правило сработало. Не повторяйте расчёт у себя: спросите `explain`.

```ts
// система прав отдаёт грант с меткой своего правила
{ id: "rule:42", scopes: ["shop-1"], where: { total: { lte: 100000 } } }

const why = await access.as(subject, scope).explain("orders.update", { ...order, scope: order.shopId });
// {
//   allowed: false,
//   kind: "grants",
//   grants: [
//     { id: "rule:42", scope: true, where: false, applies: false },
//     { id: "rule:57", scope: false, where: true, applies: false },
//   ],
// }
```

- `allowed` — тот же ответ, что у `can` на этом объекте.
- `kind: "all"` — система прав ответила `"all"`, это суперпользователь.
  `kind: "absent"` — права источника сейчас нет.
- `grants` — все гранты в том порядке, в каком их отдала система прав.
  `scope` — подошёл ли раздел. `where` — итог условия: `true`, `false` или
  `"unknown"`, когда у объекта нет значения атрибута. `applies` — грант
  подошёл целиком.
- У отброшенного гранта вместо `scope` и `where` — `problem` с причиной.
  Та же причина и `id` гранта пишутся в предупреждение в журнале.
- У подошедшего гранта права с `fields: true` есть `fields`: что дал
  именно он.
- `id` в гранте необязателен. Роли по умолчанию ставят `role:<роль>`.

Маршрута у `explain` нет. Ответ раскрывает правила другого человека, поэтому
экран и право на него делает ваша система прав.

### Поля в списке

`fields(permission, object)` считает поля для одной записи. В списке у разных
строк поля разные: считайте их в цикле, гранты уже лежат в кэше запроса.

```ts
const my = await access.for(ctx);
const rows = await Promise.all(orders.map(async (order) =>
  maskFields(order, (await my.fields("orders.read", { ...order, scope: order.shopId })).read)));
```

Фильтр и сортировка по закрытому полю выдают его значения, даже если само
поле из ответа убрано. Разрешайте их только по полям, которые человек читает
по каждому своему гранту:

```ts
import { optionsFromSchema, parseListQuery, restrictListOptions } from "bazis/library/jsonapi";

const fields = await my.filterableFields("orders.read");   // "all" или список полей
const query = parseListQuery(params, restrictListOptions(optionsFromSchema(OrderList), fields));
```

- Запрос с закрытым полем получает обычный ответ `400`:
  `filtering by "total" is not allowed`.
- Сортировка по умолчанию с закрытым полем снимается: список идёт по
  первичному ключу.
- У права со `scope: "request"` передайте раздел запроса:
  `filterableFields("dm.records.read", { scope: space })`.
- Правило с запасом: поле, закрытое хотя бы в одном гранте, закрыто для
  всего списка.

### Объект проверки

`can` и `explain` читают значения объекта по именам атрибутов, а фильтр
списка — по колонкам. Владелец читается по имени колонки `owner`, раздел —
из `scope`.

```ts
// атрибут назван как колонка: строка из базы подходит как есть
"orders.read": { scope: { column: "shopId" }, on: { status: { type: "string" } }, owner: "customerId" }
await my.can("orders.read", { ...order, scope: order.shopId });

// атрибут с другим именем: значение нужно положить под имя атрибута
on: { buyer: { ref: "crm.client", column: "buyerId" } }
await my.can("orders.read", { ...order, buyer: order.buyerId, scope: order.shopId });
```

Значения под именем атрибута нет — условие «неизвестно», и проверка
откажет, хотя фильтр списка эту строку покажет. Атрибут может лежать и на
колонке раздела: раздел гранта говорит, где он действует, условие по
атрибуту сужает дальше.

## Права, которые появляются во время работы

Таблицы дата-менеджера создаёт администратор, а не программист. Право на
таблицу и условия по её полям нужны сразу, без пересборки. Для этого модуль
объявляет **источник прав** (с версии 0.140.0):

```ts
import { PermissionSource, type PermissionDeclarations } from "bazis/core/access";

export class DataPermissionSource extends PermissionSource {
  constructor(private readonly db: DataDbContext) { super(); }

  // меняется в одной транзакции с таблицами и полями; число или непустая строка
  async version() {
    return (await this.db.settings.first()).schemaVersion;
  }

  async load(keys?: readonly string[]): Promise<PermissionDeclarations> {
    const tables = await this.db.tables.toList();
    return Object.fromEntries(tables.map((table) => [`data.${table.code}.read`, {
      title: { ru: `${table.title}: читать` },
      scope: "request",
      on: { total: { type: "number" }, status: { type: "string" } },   // поля таблицы
      owner: "createdById",
    }]));
  }
}

@Module({
  imports: [AccessModule],
  permissionSources: { data: DataPermissionSource },   // префикс → класс
})
export class DataModule {}
```

- Источник отдаёт права того же вида, что `definePermissions`. Все его ключи
  начинаются с префикса: `data.…`.
- Префикс принадлежит источнику целиком. Объявленное право под ним или
  второй источник с тем же префиксом останавливают старт.
- Класс источника регистрирует поле модуля. Зависимости конструктора
  собирает codegen, как у контроллера.
- Поле пишется объектом прямо в модуле: из него codegen берёт префиксы для
  типа ключей. Иначе он останавливается с ошибкой `BAZIS_ACCESS_SOURCES_FORM`.
- `lookup` и вид ссылки в правах источника должны быть уже известны
  приложению: `lookup` — в `providers` модуля, вид — в `references`.

Ключ источника проверяется так же, как объявленный:

```ts
@Authorize(can("data.orders.read"))
await access.can(`data.${table.code}.update`, { ...record, scope: space });
await access.filter(`data.${table.code}.read`, { scope: space });
```

Компилятор принимает любой ключ под префиксом: какие таблицы есть, он не
знает. Ключа нет в источнике — права нет ни у кого, даже у администратора:
`can` отвечает «нет», `filter` — «ничего».

### Что проверяет фреймворк

- Источники читаются до первого запроса.
- Каждое право проходит проверки объявленного. Право с ошибкой попадает в
  журнал и не существует; остальные права источника работают.
- Источник не прочитался при старте — приложение стартует, прав префикса
  нет, чтение повторяется. Состояние видно в `/health`.
- Чтение сорвалось позже — действуют права, прочитанные раньше. Один сбой
  `/health` не портит; три подряд — портят.
- На один ответ у источника 10 секунд (`access.sourceTimeoutSeconds`).
  Зависшая база не держит ни старт, ни запрос.
- `version()` должна вернуть число или непустую строку. `undefined` или
  `null` — это ошибка чтения, а не версия.

### Когда данные меняются

Модуль сообщает каталогу после фиксации транзакции:

```ts
await this.db.saveChanges();                                  // таблица создана, версия выросла
await catalog.changed("data", [`data.${table.code}.read`]);   // или changed("data") — весь префикс
```

Этот экземпляр приложения видит право сразу. Остальные узнают по версии:
раз в `access.sourcePollSeconds` (по умолчанию 5 секунд) каждый спрашивает
`version()` и при новой версии читает права заново.

- Новая таблица опроса не ждёт: по незнакомому ключу каталог сначала сверяет
  версию и только потом отказывает.
- Удалённая таблица или удалённое поле живут на других экземплярах до
  `sourcePollSeconds`.
- Один экземпляр — опрос можно выключить: `sourcePollSeconds: 0`. Источник,
  у которого чтение сорвалось, всё равно спрашивают снова раз в 5 секунд.
- `changed` с ключами показывает изменение сразу, но чтение не экономит:
  при следующей сверке версий префикс читается целиком.
- Версию меняйте в той же транзакции, что и данные. Иначе другие
  экземпляры изменения не заметят.

## Ссылки и каталог для админки

Экрану ролей нужен список прав и значения для условий («какие процессы»).
Модуль объявляет виды ссылок, которыми владеет:

```ts
@Module({
  imports: [AccessModule],
  permissions: orderPermissions,
  references: { "orders.process": ProcessReferences },
})
```

`ProcessReferences` наследует `References`: `exists`, `describe`, `search`. Поле само регистрирует
класс, в `providers` его повторять не нужно (с версии 0.137.0).
Каталог читается по HTTP с правом `access.catalog.read`:

- `GET /access/catalog` — права всех модулей и источников с атрибутами. У
  права источника есть `source` (его префикс). У атрибута, который можно
  сравнивать, — `compare: true`: экран предлагает для него `>`, `≥`, `<`, `≤`;
- `GET /access/references/orders.process?search=сч` — значения для выбора.

## Тесты

```ts
import { StaticAccessPolicy } from "bazis/core/access/testing";

const policy = new StaticAccessPolicy({
  grants: { "user:7": { "orders.read": [{ scopes: "all", where: { own: true } }] } },
});
const app = await startTestApp(Application, {
  overrides: [singletonValue(AccessPolicy, policy)],
});
```

`otherwise: "all"` даёт всё, чего нет в таблице; тесту не про права хватит
`overrides: [allowAll()]` — см. [«Права в тестах»](../fundamentals/testing.md#права-в-тестах).

Без HTTP — в своей области DI:

```ts
const scope = app.container.createScope();
const access = scope.resolve(IAccess).as({ sub: "user:7" }, scope);
```

## Дальше

- [Шаблоны авторизации](authorization-patterns.md) — проверки входа, `anyOf`, ключи API
- [Спецификация ACCESS-001](../../architecture/ACCESS.md)
