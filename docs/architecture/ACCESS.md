# Права: каталог permissions и система прав приложения

Идентификатор: **ACCESS-001**. Версия: **1.2**. Дата: **2026-11-01**.
Статус: **утверждено владельцем 2026-11-01** (согласовано агентами bazis и bazis-cms).
Основа: обсуждение прав процессов в [WORKFLOW-002](WORKFLOW_BUILDER.md) §6.2
(2026-10-31 — 11-01), проект `bazis/identity` (`docs/design/identity.md`),
модель ролей bazis-cms (согласована владельцем 2026-10-26).

## 1. Зачем

В v1.5 WORKFLOW-002 права процессов подключались отдельно: приложение
писало класс `WorkflowAccess` с условиями в коде. Владелец отклонил это как
императивное и как вторую систему прав рядом с системой приложения. Этот
документ делает права общим слоем фреймворка:

- **модуль объявляет**, что у него можно разрешить: каталог permissions;
- **система прав приложения** (модуль ролей CMS, `bazis/identity`, таблица
  в конфиге) решает, у кого что есть, и отдаёт это **данными** — грантами;
- **фреймворк** проверяет объект и фильтрует списки по грантам сам.

Ни модуль, ни система прав не пишут проверку и фильтр. Процессы — один из
модулей, особого порта прав у них нет.

## 2. Участники

| Кто | Что делает | Чего не знает |
| --- | --- | --- |
| Модуль с действиями (процессы, DM, файлы, «Заказы») | Объявляет permissions и атрибуты объектов; ставит `can(…)` на маршруты; фильтрует списки через `Access` | Ролей, пространств, организаций, кто админ |
| Система прав (одна на приложение) | Хранит роли и правила; по субъекту и праву отдаёт гранты; раскрывает деревья и «моё» | Как модуль проверяет объект и строит запрос |
| Фреймворк (`bazis/core/access`) | Собирает каталог; сопоставляет гранты с объектом; переводит гранты в условие запроса; кэширует на время запроса | Как устроены роли |
| Проверка маршрутов приложения | Кто сделал запрос: токен, сессия, блокировка; кладёт принципала | Прав на действия |

Модули без действий для раздачи (ORM, HTTP, JSON:API, очереди)
permissions не объявляют и защищают маршруты как сейчас:
`@Authorize(любая проверка)`.

## 3. Объявление прав

```ts
export const workflowPermissions = definePermissions({
  "workflow.instances.start": {
    title: { ru: "Запускать процессы", en: "Start processes" },
    scope: { lookup: ProcessPartitionsLookup },
    on: {
      process: { ref: "workflow.process", column: "processKey" },
      folder: { ref: "workflow.folder", lookup: ProcessFolderLookup },
    },
  },
  "workflow.instances.read": {
    title: { ru: "Видеть экземпляры", en: "See instances" },
    scope: { column: "partition" },
    on: { process: { ref: "workflow.process", column: "processKey" } },
    owner: "startedById",
  },
  "dm.records.read": {
    title: { ru: "Читать записи", en: "Read records" },
    scope: "request",
    on: { table: { ref: "dm.table", column: "tableId" } },
    owner: "createdById",
    fields: true,
  },
});

@Module({ permissions: workflowPermissions, … })
export class WorkflowModule {}
```

- **Ключ** — `<модуль>.<объект>.<действие>`, уникален в приложении;
  повтор — ошибка старта.
- **`title`** — `LocalizedText` для админки.
- **`on`** — атрибуты объекта, по которым система прав ставит условия.
  У атрибута:
  - `ref` — вид ссылки (§6): откуда админка берёт значения и названия;
    или `type: "string" | "number" | "boolean"` для простых значений;
  - источник для списков: `column` (колонка строки, по умолчанию имя
    атрибута) или `lookup` — класс модуля, который переводит условие на
    атрибут в условие по колонкам (`folder in [Продажи]` →
    `processKey in [ключи процессов папки]`). Атрибут без источника —
    ошибка каталога при старте.
- **`scope`** — откуда у объекта раздел:
  - `{ column }` — колонка строки (экземпляр: `partition`);
  - `{ lookup }` — класс модуля даёт разделы объекта, их может быть
    несколько (процесс каталога подключён к нескольким пространствам);
    объект подходит, если хоть один его раздел есть в гранте;
  - `"request"` — раздел задаёт вызывающий из запроса
    (`/spaces/:space/data/…`: запись DM видна во всех пространствах, где
    подключена таблица); фильтр строк по разделу не накладывается;
  - `"none"` (по умолчанию) — право без раздела: подходят гранты со
    `scopes: "all"` или с `null`.
- **`owner`** — колонка владельца: делает возможным условие «своё» (§4.2).
- Имена `all`, `any`, `not`, `own` в `on` запрещены (это слова условий) —
  ошибка старта.
- **`fields: true`** — право поддерживает списки полей (§4.4).

Раздел — строка или `null`; у CMS раздел — пространство. В `on` его не
объявляют: у него свой источник `scope`.

Каталог собирается при старте из `@Module({ permissions })` всех модулей
(канал метаданных модуля `access.permission/v1`, как `processes`) и доступен
сервису `AccessCatalog` и по HTTP (§7).

## 4. Гранты

### 4.1 Контракт системы прав

```ts
export interface AccessSubject {
  readonly sub: string;     // "<вид учётки>:<id>" — учётки из разных таблиц не склеиваются
  readonly act?: string;    // от чьего имени (организация), если есть
}

export abstract class AccessPolicy {
  /** Кто делает запрос: обычно читает принципала, которого положила проверка маршрутов. */
  abstract subject(ctx: HttpContext): AccessSubject | undefined;

  /** Что субъекту дано по праву. */
  abstract grants(subject: AccessSubject, permission: string): Grants | Promise<Grants>;

  /** Значения колонки владельца, которые считаются «мной»: обычно голый id учётки. */
  abstract ownerIds(subject: AccessSubject): readonly string[] | Promise<readonly string[]>;

  /** Адресаты субъекта по разделам: `user:<id>`, `role:<код>`, свои виды приложения. */
  abstract principals(subject: AccessSubject, scopes: readonly (string | null)[]):
    Promise<readonly { scope: string | null; principals: readonly string[] }[]>;
}

type Grants = "all" | readonly Grant[];

interface Grant {
  readonly scopes: "all" | readonly (string | null)[];
  readonly where?: Condition;
  readonly fields?: { readonly read?: readonly string[] | "all"; readonly write?: readonly string[] | "all" };
}
```

- `"all"` — суперпользователь: всё по праву, без условий. Ответ `"all"` на
  каждое право — администратор CMS.
- `[]` — права нет.
- Несколько грантов складываются через «или».
- Субъект — `{ sub, act }`: права зависят и от того, от чьего имени
  действует человек.

### 4.2 Условия

```ts
type Condition =
  | { all: readonly Condition[] }
  | { any: readonly Condition[] }
  | { not: Condition }
  | { own: true }
  | { [attribute: string]: { eq: Value } | { in: readonly Value[] } | { notIn: readonly Value[] } | { isNull: boolean } };
```

- Атрибуты — только объявленные в `on` права; другой атрибут — грант
  отклоняется с ошибкой в журнале (права нет).
- `{ own: true }` — лист дерева: колонка `owner` объекта входит в
  `ownerIds(subject)`. Колонки владельца хранят голый id (`startedById`,
  `createdBy`), поэтому с `sub` (`<вид>:<id>`) их не сравнивают. «Своё» —
  только сам субъект; «объекты моей организации» — обычное условие
  `{ org: { eq: <act> } }`, которое подставляет система прав. Так выражается
  «своё ИЛИ публичное».
- Значения готовые. «Моя организация», «моё подразделение», «пространство,
  где выдана роль и ниже» система прав раскрывает сама и отдаёт
  конкретные id и разделы. Фреймворк не знает деревьев и организаций.
- Запрет важнее разрешения — это правило системы прав: она отдаёт итог
  (`{ all: [A, { not: B }] }`).
- Пределы: глубина 8, 200 узлов, 1000 значений в `in`/`notIn`; больше —
  грант отклоняется с ошибкой в журнале.

### 4.3 Как фреймворк применяет гранты

- **Объект** (`can`): право есть, если хоть один грант подходит: раздел
  объекта (по источнику `scope`, хоть один из нескольких) в `scopes` и
  `where` истинно на атрибутах объекта.
- **Список** (`Access.filter`): гранты переводятся в условие запроса —
  раздел через его источник (`scope in (…)`; при `"request"` раздел
  запроса проверяется до запроса, строки по нему не фильтруются) и `where`
  через источники атрибутов. Для ORM —
  `grantsToWhere(filter, Entity)`. `lookup` может дать длинный `in`
  (папка → тысячи процессов): свыше `access.maxInList` (по умолчанию 1000)
  он должен отдавать подзапрос, иначе ошибка `access_filter_too_large`.
- Гранты кэшируются только на время запроса. Долгий кэш и его сброс
  (выдали роль, сменили организацию) — дело системы прав.

### 4.4 Поля

Для права с `fields: true` грант может нести `fields.read` / `fields.write`.
Применяет модуль: `Access.fields(permission, object)` → итоговые списки,
`maskFields(record, fields)` убирает лишнее из ответа, запись чужого поля —
403 с именем поля. Без `fields` в гранте — все поля.

## 5. Проверка

```ts
// маршрут: право где-нибудь; объект проверяет обработчик, когда загрузит его
@Authorize(can("workflow.instances.read"))
@Get("instances/:id") get(…) { … }

// маршрут, где объект известен из запроса
@Authorize(can("orders.create", (ctx) => ({ scope: ctx.header("x-shop") ?? null })))

// код (scoped-сервис Access)
const my = await access.for(ctx);                            // субъект запроса; нет — 401
await my.can("workflow.instances.read", { ...instance, scope: instance.partition }); // false → 403 или 404 решает вызывающий
const filter = await my.filter("workflow.instances.read");   // для списков → grantsToWhere
await my.filter("dm.records.read", { scope: space });        // право с scope: "request"
await access.as(subject).can(…);                             // без HTTP: сервисы, агенты
```

- Субъекта `can` берёт у `AccessPolicy.subject(ctx)`; нет субъекта — 401.
- `can` без объекта отвечает, есть ли право хоть где-нибудь (хоть один
  грант): так защищается маршрут до загрузки объекта.
- Проверка маршрутов приложения (`runApp(…, { http: { authorize } })`)
  стоит на всех маршрутах до `can`: вид токена, живая сессия, блокировка.
- **Фон не проверяется.** Задания, расписания, события, шаги процесса:
  право дал тот, кто настроил задание или опубликовал процесс. Tools внутри
  процесса `can` не вызывают; Tool, вызванный агентом от имени
  пользователя, проверяет `access.as(subject)`.

## 6. Виды ссылок

Админке для условий нужен выбор значения («какие таблицы», «какие
процессы»), процессам — проверка ссылок `x-ref` (WORKFLOW-002 §6.3). Это один
механизм: модуль объявляет виды ссылок, которыми владеет.

```ts
@Module({
  permissions: workflowPermissions,
  references: { "workflow.process": ProcessReferences, "workflow.folder": FolderReferences },
})
```

```ts
abstract class References {
  exists(ids: readonly string[], ctx): Promise<ReadonlySet<string>>;
  describe(ids: readonly string[], ctx): Promise<readonly { id: string; title: LocalizedText }[]>;
  search(text: string, ctx, page): Promise<readonly { id: string; title: LocalizedText }[]>;
}
```

Контекст — `{ scope, language }`. Вид без владельца в `ref` — ошибка старта.
Порт `WorkflowReferences` из WORKFLOW-002 заменяется этим механизмом.

## 7. HTTP каталога

- `GET /access/catalog` — права всех модулей: ключ, название, атрибуты с
  видами ссылок, `owner`, `fields`. Право `access.catalog.read`.
- `GET /access/references/:kind?search=…` — значения вида для выбора.
  Право `access.catalog.read`.

Только чтение: роли и их правила хранит и редактирует система прав
приложения своими экранами.

## 8. По умолчанию: `RolesAccessPolicy`

Приложение без своей системы прав получает работающую:

- субъект — принципал проверки маршрутов: `sub` = `<вид>:<subject>` (вид из
  claim `access.kindClaim`), без вида — `subject`;
- роли — claim `access.roleClaim` (по умолчанию `role`), через пробел или
  запятую;
- права ролей — декларативно, полем модуля (конфиг фреймворка хранит только
  простые значения, таблицу ролей туда не положить):

```ts
export const appRoles = defineRoles({
  admin: "all",
  manager: ["workflow.instances.start", "workflow.instances.read", "workflow.tasks.work"],
  user: ["workflow.instances.read:own", "workflow.tasks.work"],
});

@Module({ imports: [AccessModule, …], roles: appRoles })
export class AppModule {}
```

  `<право>:own` — сокращение для гранта `{ where: { own: true } }`; вместо
  строки можно дать грант с условиями `{ permission, scopes, where, fields }`.
  Роль с несуществующим правом или неверным условием останавливает старт;
- «я» для `own` — `subject` без вида;
- адресаты — `user:<id>` и `role:<роль>`;
- без ролей всё запрещено; роль, которой нет в `roles`, ничего не даёт.

Раздел у ролей по умолчанию — любой (`scopes: "all"`). Это ступень до
`bazis/identity`: когда он появится, он станет системой прав по умолчанию.

Для тестов — `StaticAccessPolicy` в `bazis/core/access/testing`: гранты по
субъекту задаются прямо в тесте.

## 9. Потребители

- **Процессы** (WORKFLOW-002 §6.2): порт `WorkflowAccess` удаляется; модуль
  объявляет каталог `workflow.*` и виды ссылок `workflow.process`,
  `workflow.folder`; списки экземпляров и задач фильтрует `Access.filter`;
  адресаты задач — `principals` по разделам, считаются при просмотре.
- **bazis-cms**: модуль ролей реализует `AccessPolicy` по согласованной
  модели (роль в пространстве пользователю, организации или подразделению,
  «и ниже», правило «сущность × операция × разрешить/запретить/условие»,
  списки полей) и показывает каталог администратору. Админ CMS — `"all"`.
  `CmsWorkflowAccess` удаляется; `starters` пространства — грант с
  `where: { process: { in: […] } }`. Пока модуля ролей нет, CMS отдаёт
  гранты по видам токена, как сегодня.
- **`bazis/identity`**: реализует `AccessPolicy`; шаги 0–3 расчёта прав
  (identity §4) дают гранты, `:own` — лист `own`. Условия кодом
  (`policy()`) в контракт не входят: это вторая ступень в коде модуля после
  `can`.

## 10. Этапы

1. **`bazis/core/access`**: `definePermissions`, `@Module({ permissions,
   references })`, каталог и его проверки при старте, `AccessPolicy`,
   условия и их пределы, `can`, `Access` (`can`, `filter`, `fields`, `as`),
   `grantsToWhere`, `maskFields`, `RolesAccessPolicy` и `@Module({ roles })`,
   `StaticAccessPolicy`, HTTP каталога. Эталонное приложение
   `examples/workflow` (WORKFLOW-002 §1.1) получает права через него.
2. **Процессы на ACCESS-001** — этап 0 WORKFLOW-002.
3. **bazis-cms**: `AccessPolicy` поверх токенов, затем модуль ролей.
4. **`bazis/identity`** уровня 0 (identity §9 п. 3) — реализация
   `AccessPolicy`.

## 11. Открыто

- Подзапрос для длинного `lookup` (§4.3): нужна поддержка подзапроса в
  условии ORM; до неё — предел `access.maxInList`.
