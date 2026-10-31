# Права: каталог permissions и система прав приложения

Идентификатор: **ACCESS-001**. Версия: **1.0**. Дата: **2026-11-01**.
Статус: **направление согласовано агентами bazis и bazis-cms; ждёт утверждения владельца**.
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
    on: {
      process: { ref: "workflow.process", column: "processKey" },
      folder: { ref: "workflow.folder", lookup: ProcessFolderLookup },
    },
  },
  "workflow.instances.read": {
    title: { ru: "Видеть экземпляры", en: "See instances" },
    on: { process: { ref: "workflow.process", column: "processKey" } },
    owner: "startedById",
  },
  "dm.records.read": {
    title: { ru: "Читать записи", en: "Read records" },
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
- **`owner`** — колонка владельца: делает возможным условие «своё» (§4.2).
- **`fields: true`** — право поддерживает списки полей (§4.4).

Раздел (`scope`) у всех прав один и тот же: строка или `null` (без раздела).
У CMS раздел — пространство. Отдельно в `on` его не объявляют.

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
- `{ own: true }` — лист дерева: объект принадлежит субъекту (колонка
  `owner` = `sub` или `act`). Так выражается «своё ИЛИ публичное».
- Значения готовые. «Моя организация», «моё подразделение», «пространство,
  где выдана роль и ниже» система прав раскрывает сама и отдаёт
  конкретные id и разделы. Фреймворк не знает деревьев и организаций.
- Запрет важнее разрешения — это правило системы прав: она отдаёт итог
  (`{ all: [A, { not: B }] }`).
- Пределы: глубина 8, 200 узлов, 1000 значений в `in`/`notIn`; больше —
  грант отклоняется с ошибкой в журнале.

### 4.3 Как фреймворк применяет гранты

- **Объект** (`can`): право есть, если хоть один грант подходит: раздел
  объекта в `scopes` и `where` истинно на атрибутах объекта.
- **Список** (`Access.filter`): гранты переводятся в условие запроса —
  `scope in (…)` и `where` через источники атрибутов. Для ORM —
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
// маршрут
@Authorize(can("workflow.instances.start", (ctx) => ({
  scope: ctx.body.partition, process: ctx.body.processKey,
})))
@Post("instances") start(…) { … }

// код (scoped-сервис)
await access.can("workflow.instances.read", instance);       // false → 403 решает вызывающий
const filter = await access.filter("workflow.instances.read"); // для списков
await access.as(subject).can(…);                             // без HTTP: сервисы, агенты
```

- Субъекта `can` берёт у `AccessPolicy.subject(ctx)`; нет субъекта — 401.
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

## 8. По умолчанию: `ConfigAccessPolicy`

Приложение без своей системы прав получает работающий адаптер:

- субъект — принципал `@Authorize`: `sub` = `<вид>:<subject>` (вид из claim
  `access.kindClaim`), без вида — `subject`;
- роли — claim `access.roleClaim` (по умолчанию `role`);
- права — таблица в конфиге:

```json
{
  "access": {
    "roles": {
      "admin": "all",
      "manager": ["workflow.instances.start", "workflow.instances.read", "workflow.tasks.work"],
      "user": ["workflow.instances.read:own", "workflow.tasks.work"]
    }
  }
}
```

  `<право>:own` — сокращение для гранта `{ where: { own: true } }`;
- адресаты — `user:<id>` и `role:<роль>`;
- без настройки всё запрещено.

Раздел у `ConfigAccessPolicy` — любой (`scopes: "all"`). Это ступень до
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
   `grantsToWhere`, `maskFields`, `ConfigAccessPolicy`,
   `StaticAccessPolicy`, HTTP каталога. Эталонное приложение
   `examples/workflow` (WORKFLOW-002 §1.1) получает права через него.
2. **Процессы на ACCESS-001** — этап 0 WORKFLOW-002.
3. **bazis-cms**: `AccessPolicy` поверх токенов, затем модуль ролей.
4. **`bazis/identity`** уровня 0 (identity §9 п. 3) — реализация
   `AccessPolicy`.

## 11. Открыто

- Подзапрос для длинного `lookup` (§4.3): нужна поддержка подзапроса в
  условии ORM; до неё — предел `access.maxInList`.
