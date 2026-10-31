# Identity: пользователи, стороны, пространства и права

Дизайн модуля идентичности и доступа для bazis. Итог обсуждения 10–23 октября
2026. Это проектный документ, а не руководство: API ниже — предложение, оно
уточнится при реализации.

## 1. Зачем

Одна модель, которая без изменения кода приложения закрывает:

- блог / CMS: редакция и читатели;
- интернет-магазин: продавец и покупатели-физлица;
- маркетплейс: много компаний, одна и та же компания в одном месте партнёр,
  в другом клиент, в третьем подрядчик;
- корпоративный портал: отделы, проекты, подрядчики, аудиторы, холдинг;
- форум и проектные трекеры: человек создаёт пространство и приглашает
  других;
- SaaS: независимые тенанты со своими администраторами.

Главный принцип: **разработчик пишет приложение против permissions и не
знает ни про роли, ни про компании, ни про пространства. Всё это настраивает
администратор в рантайме.** Для простого приложения настройка схлопывается
до «пользователи, роли, права» — как в WordPress.

## 2. Два независимых слоя

Ошибка, которую мы исправили в начале: «партнёры» и «клиенты» — не группы
пользователей. Это два разных слоя:

| Слой | Вопрос | Понятия |
|---|---|---|
| Безопасность | кто ты и как вошёл | realm, user, credential, session |
| Доступ | от чьего имени, где и что можно | party, space, participation, role, permission |

Realm — граница безопасности (свои перцы, стоимость хеша, JWT-ключи,
способы входа). Бизнес-отношение (партнёр, клиент, подрядчик) — свойство
*связи* стороны с пространством, а не стороны и не пользователя.

## 3. Модель данных

### Безопасность

```
Realm            staff | external | machine — сид, админ может добавить свои
  allowedCredentials   [password, sso] / [password, oauth, sms] / [clientSecret]
  hashPolicy           argon2id: memoryCost, timeCost      ← рантайм
  accessTtl, refreshTtl                                     ← рантайм
  status               active | disabled

RealmKey         перцы и JWT-ключи realm, зашифрованы мастер-ключом (KEK из env, позже KMS)
  realmId, purpose: pepper | jwt, version, material, status: active | retiring | retired

User             логин в realm
  id, realmId, email, status, partyId → Person (люди) | Company (сервисные аккаунты)
  unique(realmId, email)

Credential       способы входа одного пользователя
  userId, type: password | oauth | sms | passkey | clientSecret, data
  password: PHC-строка argon2id + pepperVersion
  oauth: provider + subjectId, unique(provider, subjectId)

Session          refresh-сессии; refresh одноразовый, с детекцией повторного использования
```

Пароль: `argon2id(HMAC(pepper_active, password))`. Соль — у каждого хеша
своя (внутри PHC), перец — у realm. Ротация перца через связку версий и
rehash при входе. Для неизвестного логина выполняется фиктивная проверка с
политикой realm (нет тайминг-оракула).

JWT: заголовок `kid` → `JwtKeyRing` realm (уже есть в
`bazis/library/jwt`). Ротация: новый ключ `active`, старый `retiring`
(только проверяет), через `accessTtl` — `retired`. Экстренная — `revoke()`.

### Доступ

```
Person           id, displayName                — человек; User'ы в разных realm → один Person
Company          id, name, inn, status          — справочник юрлиц, без меток «партнёр/клиент»

Space            пространство: где идёт работа и кому принадлежат данные
  id, name
  ownerPartyId     чьё: Person или Company (кто управляет в последней инстанции, кто платит)
  parentId?        где в дереве; задаёт наследование доступа; нет родителя — нет наследования
  visibility       private | public
  anonymousRoles[]       что может аноним           (каталог магазина, чтение форума)
  authenticatedRoles[]   что может вошедший без участия (покупатель)

Participation    кто, где, в каком качестве
  spaceId, partyId → Person | Company
  kind             partner | client | contractor | member | auditor … — каталог приложения/админа
  roles[], status: invited | active | suspended | ended, expiresAt?
  unique(partyId, spaceId)

Role             набор permissions
  scope            platform (создал админ CMS, доступна во всех пространствах данного kind)
                   | space (создал админ пространства, живёт только в нём)
  kind             для какого вида участия
  permissions[]

ParticipationKind  каталог видов участия: ceiling[] — потолок permissions, delegable[]
Permission         каталог прав — объявляет КОД, в БД не хранится
Invitation         spaceId, kind, roles[], адресат: email | inn, tokenHash, expiresAt
ShareLink          spaceId, roles[], tokenHash, expiresAt — доступ по ссылке без регистрации
```

Корневое пространство создаётся при установке и не удаляется. У каждой
Company — домашнее пространство (через него считаются права сотрудников).
У Person домашнее пространство — по политике приложения.

## 4. Как считаются права на запрос

Токен: `sub` = user, `act` = party (сам или компания, где я `member`).
Пространство — из маршрута; нет в маршруте — корневое. В токен
пространство не кладём: на маркетплейсе человек ходит по десяткам сделок.

```
0. ищем участие act в space; нет — вверх по parentId (не глубже 5)
1. нет участия: public? → anonymousRoles / authenticatedRoles, иначе 403
2. потолок = permissions ролей участия ∩ ceiling(kind)
3. act — компания?  итог = потолок ∩ permissions моей роли в домашнем space компании
4. :own — объект.partyId == act (в списках → where partyId = :act)
5. policy("x", (actor, obj) => …) — условие на данных, вторая ступень после роли
6. @Authorize(can("orders.pay"))
```

Шаги 0–3 кэшируются в памяти; кэш сбрасывается по событиям изменения
участий, ролей, статусов пространств и компаний. БД на горячем пути не
трогаем.

## 5. Делегированное администрирование

Управление доступом — тоже permissions, отдельной опции нет:

```
roles.assign    выдавать существующие роли участникам пространства
roles.compose   собирать новые роли из permissions
```

| Владелец пространства имеет | Где |
|---|---|
| ничего | CMS, магазин — ролями рулит админ CMS |
| `roles.assign` | маркетплейс — продавец раздаёт готовые роли |
| `roles.assign + roles.compose` | корпоративный портал, SaaS |

Правила:

- **запрет эскалации**: выдать можно только роль, все permissions которой
  есть у тебя в этом пространстве; это же правило разрешает передавать
  `roles.assign` дальше (со-владелец) — если для kind право не помечено
  неделегируемым;
- потолок kind, платформенные роли и смена владельца — только у админа CMS;
- каждая выдача в аудит: кто выдал, в каком пространстве.

Админ CMS — не отдельная сущность, а участник корня с нужными правами.

## 6. Уровни сложности (progressive disclosure)

Схема данных полная с первого дня (`spaceId` в сущностях есть всегда),
но в админке, API и документации видно только включённое:

```
0  пользователи, роли, права                 CMS, блог        ≈ WordPress
1  + компании, :own                          магазин
2  + пространства, участия, приглашения      маркетплейс, портал, форум
3  + политики, иерархия пространств          сложные случаи
```

Пресеты при установке: `cms`, `shop`, `marketplace`, `forum`, `corporate`.
Критерий: если для блога нужно больше трёх понятий — перемудрили.

## 7. Как это выглядит на bazis

### Пакет и модуль

`bazis/identity` — библиотечный модуль фреймворка (не код приложения).
Подключается одним импортом:

```ts
@Module({
  imports: [
    IdentityModule.forRoot({
      masterKey: identityConfig.get("masterKey"),   // KEK для RealmKey
      preset: "shop",                               // сид realm'ов, ролей, корня
      level: 1,                                     // что показывать админу
    }),
  ],
})
export class AppModule {}
```

Внутри: `ormBazis` со своим `IdentityDbContext`, контроллеры
`/auth/:realm/*` и `/identity/*`, `uiProfiles` для админки (вкладки
появляются по уровню), background для ротации ключей и чистки сессий.

### Контракт разработчика — четыре вещи

```ts
// 1. Сущности: живёт в пространстве, имеет владельца
@Entity({ scope: "space" })            // колонка spaceId + автофильтр по текущему пространству
export class Order {
  @Key() id = 0;
  @Owner() partyId = "";               // для :own
}

// 2. Permissions — единственное знание кода о доступе
export const shopPermissions = definePermissions({
  "catalog.read":     "Смотреть каталог",
  "orders.create":    "Оформлять заказы",
  "orders.read":      "Видеть все заказы",
  "orders.read:own":  "Видеть свои заказы",
  "orders.process":   "Обрабатывать заказы",
});

// 3. Проверка в контроллере; пространство берётся из маршрута или корень
@Controller("orders")
export class OrdersController {
  @Authorize(can("orders.process"))
  @Post(":id/process") process(id: number) { … }
}

// 4. Actor в сервисах (scoped, как CurrentUser в гайде)
export class OrdersService {
  constructor(private readonly orders: IRepository<Order>, private readonly actor: Actor) {}
  create(dto: CreateOrderRequest) {
    const order = Object.assign(new Order(), { partyId: this.actor.party.id, … });
  }
}
```

Расширения, когда ролей не хватает:

```ts
// условие на данных — вторая ступень can()
policy("orders.approve", (actor, order: Order) => order.amount <= actor.limit("orders.approve"));

// явный выход из скоупа пространства (поиск по маркетплейсу, отчёты)
this.orders.query().withoutSpaceScope()
```

Модуль объявляет permissions декларативно:

```ts
@Module({ permissions: shopPermissions, … })
export class ShopModule {}
```

При старте фреймворк сверяет роли из БД с каталогом и пишет в лог роли,
ссылающиеся на несуществующие права.

События для подписки: `identity.user.registered`,
`identity.company.created`, `identity.participation.changed`,
`identity.space.transferred`.

### CLI

```
bazis identity:install --preset shop        сид + первый админ
bazis identity:export > identity.json       realm'ы (без ключей), kind'ы, роли — для переноса между стендами
bazis identity:import identity.json
bazis identity:rotate jwt --realm staff     плановая ротация; --emergency — revoke
bazis identity:rotate pepper --realm external
```

### Что делает администратор

В кабинете по уровню: realm'ы и их политики, ротация ключей; виды участия
и их потолки; роли; пространства и их публичность; компании, приглашения,
слияние дублей; передача владения.

## 8. Чего модель не покрывает (границы)

Сознательно:

- **жёсткая изоляция тенантов** (своя БД, свои JWT-ключи на тенанта) — одна
  БД, ключи на realm;
- **workflow**: цепочки согласования, разделение обязанностей — отдельный
  модуль, identity даёт `Actor` и `policy`;
- **оргструктура** (кто чей руководитель) — отдельная модель (штатное
  расписание), ссылается на `User`.

Запланировано, дорога не закрыта:

- **ResourceGrant** — точечный доступ к объекту («поделиться темой с
  тремя»); пока единица доступа — пространство; `can()` сразу принимает
  второй аргумент под будущий `resource`;
- **права на поля** (HR видит зарплату) — поддержка в сериализации
  контрактов;
- **Group** как третий тип стороны («поделиться с командой»);
- **делегирование** (замещение в отпуске) — запись, ссылающаяся на чужие
  права, а не копирующая их;
- **гость, владеющий объектом** (заказ без регистрации) — гостевые учётки
  + слияние при регистрации;
- **provisioning из внешнего IdP** (группы AD → роли) — SCIM/маппинг;
  корпоративный кейс упрётся сразу.

Риск реализации: кэш прав (пользователь в 10 000 пространств, дерево
глубиной 5, пересечения) проектировать с первого дня.

## 9. Порядок реализации

1. **Крипто-ядро**: Realm, RealmKey, KEK, перцы, `Passwords`, `JwtKeyRing`
   на realm, тесты ротации и rehash.
2. **Вход**: User, Credential(password), Session; login/refresh/logout;
   `identity:install` с первым админом. Система уже рабочая.
3. **Доступ уровня 0**: каталог permissions, Role, корневое пространство,
   `can()`, `Actor`, `@Owner` + `:own`.
4. **Уровень 1–2**: Person, Company, Space, Participation, kind, потолки,
   приглашения, наследование, `anonymousRoles`/`authenticatedRoles`,
   делегирование (`roles.assign/compose`, запрет эскалации).
5. **Уровень 3**: `policy()`, иерархия, `withoutSpaceScope()`.
6. **Credential** oauth/sms/passkey/clientSecret, машинные аккаунты.
7. Export/import, пресеты, admin UI по уровням, аудит.
