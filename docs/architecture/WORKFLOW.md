# Бизнес-процессы во фреймворке

Идентификатор: **WORKFLOW-001**. Версия: **1.1**. Дата: **2026-10-31**.
Статус: **принята; этап 1 реализован в bazis 0.124.0, этапы 2–5 — §12**.

Цель: разработчик на bazis получает бизнес-процессы целиком — модели, сервисы,
HTTP и фоновое исполнение — без CMS. UI во фреймворк не входит: дизайнер,
входящие задачи и формы строит приложение (например, bazis-cms) поверх
сервисов и HTTP этого модуля.

Модуль устроен по [MOD-ARCH-001](MODULE_ARCHITECTURE.md): составной модуль из
атомарных частей, у каждой свои модели, сервисы, контроллеры и паспорт. Шаги,
которые действуют, вызывают Tools по [TOOLS-001](TOOLS.md) как вызывающий
`workflow`.

Что изменилось с версии 1.0: вместо одного модуля-фабрики — составной модуль из
трёх частей; у частей есть HTTP; задачи сотрудникам и черновики процессов — во
фреймворке; настройки — через `config`; права HTTP — через порт
`WorkflowAccess`; формат документа — в `library`.

## 1. Состав

```text
src/bazis/library/workflow/            формат документа: чистые функции, без DI и базы
  ProcessDocument.ts                   типы документа bazis.workflow/v1
  nodeKinds.ts                         13 видов узлов: роль в графе, проверка config
  validateProcess.ts                   проверка графа, все замечания сразу
  paths.ts                             пути $input / $vars / $nodes, вход шага
  conditions.ts                        условия переходов
  formFields.ts                        поля входа и форм, их проверка

src/bazis/core/workflow/               составной модуль WorkflowModule
  MODULE.md                            паспорт пака и карта зависимостей
  Workflow.module.ts                   только imports / exports частей
  index.ts                             точка входа bazis/core/workflow
  access/WorkflowAccess.ts             порт прав HTTP (общий контракт частей)
  contracts/                           WorkflowError, WorkflowInputValidator, общие типы
  definitions_module/                  «какие процессы есть»
  runtime_module/                      «как процессы исполняются»
  tasks_module/                        «задачи сотрудникам»
```

Каждая часть — атомарный модуль со своим `MODULE.md` и раскладкой §4.2
MOD-ARCH-001 (`model/`, `services/`, `http/`, `background/`, `events/`,
`config/`, `errors/`, `internal/`, `test/` — только те, что нужны).

| Часть | Ответственность | Данные | Зависит от |
| --- | --- | --- | --- |
| Definitions | Каталог процессов, черновики, публикация неизменяемых версий | `WfProcess`, `WfVersion` | `library/workflow`, `ToolRunner` |
| Runtime | Исполнение версий: экземпляры, токены, задания, ожидания событий, история | `WfInstance`, `WfToken`, `WfJob`, `WfSubscription`, `WfHistory` | Definitions, `ToolRunner`, `EventBus` |
| Tasks | Задачи сотрудникам: кому, форма, взять, завершить | `WfTask` | Runtime |

Зависимости идут в одну сторону: Tasks → Runtime → Definitions. Части
связываются публичными контрактами (`IWorkflowDefinitions`, `IWorkflowRuntime`),
а не чужими `DbContext`.

```ts
// core/workflow/Workflow.module.ts — пак только собирает части
@Module({
  imports: [WorkflowDefinitionsModule, WorkflowRuntimeModule, WorkflowTasksModule],
  exports: [IWorkflowDefinitions, IWorkflowRuntime, IWorkflowTasks],
})
export class WorkflowModule {}

// приложение
@Module({ imports: [WorkflowModule, OrdersModule, PaymentsModule] })
export class AppModule {}
```

Приложение может подключить не весь пак, а нужные части: без задач —
`WorkflowDefinitionsModule` и `WorkflowRuntimeModule`.

## 2. Документ процесса (`bazis.workflow/v1`)

Формат bazis-cms (`cms.workflow/v1`) переходит во фреймворк под именем
`bazis.workflow/v1` без изменения смысла.

```json
{
  "schemaVersion": "bazis.workflow/v1",
  "input": { "fields": [{ "code": "amount", "type": "number", "required": true }] },
  "nodes": {
    "Start": { "kind": "manualStart", "title": "Старт" },
    "Pay": { "kind": "serviceTask", "title": "Оплата", "config": { "tool": "payments.charge", "input": { "amount": "$input.amount" }, "saveTo": "payment" } },
    "End": { "kind": "end", "title": "Конец" }
  },
  "flows": { "f1": { "source": "Start", "target": "Pay" }, "f2": { "source": "Pay", "target": "End" } },
  "diagram": { "shapes": {}, "edges": {} }
}
```

| Вид узла | Роль | `config` |
| --- | --- | --- |
| `manualStart` | старт | — |
| `scheduleStart` | старт | `cron` (пять полей) |
| `eventStart` | старт | `event` |
| `serviceTask` | шаг | `tool`, `input` (параметр → путь или литерал), `saveTo?`, `retry?` |
| `userTask` | шаг | `assignee` (`{ role }` или `{ user }`), `form?`, `dueIn?` |
| `timerCatch` | шаг | `duration` (ISO 8601 без месяцев и лет) или `at` (путь к дате) |
| `eventWait` | шаг | `event`, `correlation?` (путь), `saveTo?` |
| `exclusiveGateway` | шлюз | — |
| `parallelGateway` | шлюз | — |
| `boundaryError` | граничный (`attachedTo`) | `errorCode?` |
| `boundaryTimer` | граничный | таймер и `interrupting?` |
| `boundaryEvent` | граничный | `event`, `interrupting?` |
| `end` | конец | — |

- Пути: `$input.x`, `$vars.x`, `$nodes.<узел>.x`. Пути не читают `__proto__`,
  `constructor` и `prototype`.
- Условия переходов из `exclusiveGateway`: `all` / `any` / `not` и сравнения
  `eq, ne, gt, gte, lt, lte, in, contains, empty, notEmpty`; один переход
  `isDefault`. Кода в условиях нет.
- Поля входа и форм (`formFields.ts`): `string`, `text`, `number`, `integer`,
  `boolean`, `date`, `datetime`, `enum` (`values`), `required`. Проверку
  можно заменить портом `WorkflowInputValidator` (§9).
- `diagram` хранится и отдаётся как есть, фреймворк его не читает.
- `validateProcess(document, { tools })` возвращает все замечания сразу:
  `severity` (`error` не даёт опубликовать, `warning` — подсказка дизайнеру),
  код и узел или переход. Коды: `schema`, `too_large`, `input_invalid`,
  `id_invalid`, `unknown_kind`, `title_invalid`, `config_invalid`,
  `unknown_tool`, `flow_dangling`, `flow_self`, `flow_duplicate`, `no_start`,
  `no_end`, `start_incoming`, `start_outgoing`, `end_outgoing`, `end_incoming`,
  `activity_incoming`, `activity_outgoing`, `gateway_flows`, `boundary_attach`,
  `boundary_incoming`, `boundary_outgoing`, `condition_missing`,
  `condition_invalid`, `condition_not_allowed`, `default_invalid`,
  `unreachable`, `dead_end`, `diagram_missing`, `diagram_orphan`.
  `serviceTask` должен называть Tool, у которого в `callers` есть `workflow`.
- Пределы: 500 узлов, 1000 переходов, 1 МБ, глубина условий 8.

## 3. Definitions

### Модели (owned store `bazis.workflow.definitions`, префикс `bazis_wf_def_`)

**`WfProcess`** (`bazis_wf_def_processes`) — процесс в каталоге; меняется.

| Поле | Тип | Смысл |
| --- | --- | --- |
| `id` | uuid | |
| `key` | text, уникальный | `order`, `vacation`; `^[a-z][a-z0-9_.-]{0,63}$` |
| `title` | text | |
| `description` | text, null | |
| `draft` | json, null | черновик документа |
| `draftUpdatedAt`, `draftUpdatedByKind`, `draftUpdatedById` | null | кто и когда правил черновик |
| `latestVersion` | int, null | последняя опубликованная версия |
| `retentionDays` | int, null | срок хранения завершённых экземпляров |
| `archivedAt` | timestamp, null | архивный процесс не запускается |
| `createdAt`, `updatedAt` | timestamp | |

**`WfVersion`** (`bazis_wf_def_versions`) — опубликованная версия; не меняется.

| Поле | Тип | Смысл |
| --- | --- | --- |
| `id` | uuid | |
| `processId` | uuid, FK → `WfProcess` | |
| `version` | int | 1, 2, 3…; уникально с `processId` |
| `document` | json | снимок документа |
| `documentHash` | text | sha-256 документа: та же публикация не создаёт версию |
| `publishedAt`, `publishedByKind`, `publishedById` | | |

Пространств и прав запуска здесь нет: кто что может, решает `WorkflowAccess`.

### Сервис `IWorkflowDefinitions`

```ts
list(query: { archived?: boolean; search?: string; limit?; offset? }): Promise<Page<ProcessSummary>>
get(key): Promise<ProcessDetails>                                  // WorkflowError not_found
create({ key, title, description?, retentionDays? }, actor)        // conflict, если ключ занят
update(key, { title?, description?, retentionDays?, archived? }, actor)
saveDraft(key, document, actor): Promise<{ issues: ProcessIssue[] }> // сохраняет и с замечаниями
publish(key, actor): Promise<VersionDetails>                       // invalid_document с issues
version(key, n) / latest(key) / versions(key)
tools(): readonly WorkflowToolInfo[]                               // каталог Tools для дизайнера
```

### HTTP (`/workflow/processes`)

| Метод и путь | Право | Ответ |
| --- | --- | --- |
| `GET /workflow/processes` | `processes.read` | список |
| `POST /workflow/processes` | `processes.manage` | 201 / 409 |
| `GET /workflow/processes/:key` | `processes.read` | процесс с черновиком |
| `PATCH /workflow/processes/:key` | `processes.manage` | 200 |
| `PUT /workflow/processes/:key/draft` | `processes.manage` | 200 `{ issues }` |
| `POST /workflow/processes/:key/publish` | `processes.publish` | 201 версия / 422 `invalid_document` |
| `GET /workflow/processes/:key/versions` | `processes.read` | список версий |
| `GET /workflow/processes/:key/versions/:version` | `processes.read` | версия с документом |
| `GET /workflow/tools` | `processes.read` | Tools для процессов со схемами входа и выхода |

## 4. Runtime

### Модели (owned store `bazis.workflow.runtime`, префикс `bazis_wf_run_`)

**`WfInstance`** (`bazis_wf_run_instances`) — запуск процесса.

| Поле | Тип | Смысл |
| --- | --- | --- |
| `id` | uuid v7 | порядок id — порядок создания |
| `versionId` | uuid | версия (ссылка без FK: таблица Definitions) |
| `processKey`, `version` | text, int | копия для фильтров |
| `partition` | text, null | область приложения: пространство, организация |
| `status` | `running`, `completed`, `cancelled`, `failed` | |
| `input`, `vars`, `nodes` | json | вход; переменные `saveTo`; результат шагов по id узла |
| `businessKey` | text, null | `order:42` |
| `startedVia` | `manual`, `event`, `schedule` | |
| `startedByKind`, `startedById` | | от чьего имени идут шаги |
| `error` | json, null | `{ node, code, message }` |
| `createdAt`, `endedAt` | | |

Индексы: `(partition, status)`, `(processKey, status)`, `businessKey`, `(status, endedAt)`.

**`WfToken`** (`bazis_wf_run_tokens`) — положение исполнения: `id` (uuid v7,
он же ключ идемпотентности вызова Tool), `instanceId` (FK, cascade), `nodeId`,
`viaFlowId`, `status` (`active`, `waiting`, `done`, `cancelled`, `failed`),
`output` (json, null), `createdAt`, `endedAt`. Индекс `(instanceId, status)`.

**`WfJob`** (`bazis_wf_run_jobs`) — отложенная работа: `id`, `kind` (`tool`,
`timer`, `retry`, `schedule`), `instanceId`, `tokenId` (null у `schedule`),
`versionId` (для `schedule`), `dueAt`, `attempts`, `lockedUntil`, `lastError`.
Индекс `dueAt` (частичные индексы owned store не принимает); воркер берёт задания по `id`, как требует `SKIP LOCKED` в ORM.

**`WfSubscription`** (`bazis_wf_run_subscriptions`) — ожидание события: `id`,
`instanceId`, `tokenId`, `eventKey`, `correlation`, `partition`, `createdAt`.
Индекс `(eventKey, correlation)`.

**`WfHistory`** (`bazis_wf_run_history`) — журнал, только добавление: `id`
(uuid v7), `instanceId`, `tokenId`, `nodeId`, `type` (`started`, `entered`,
`left`, `tool`, `timer`, `event`, `error`, `retried`, `cancelled`,
`completed`), `data` (json), `actorKind`, `actorId`, `at`.

Пять таблиц — одна часть, потому что шаг движка меняет их в одной транзакции:
закрыть токен, создать следующий, поставить задание или подписку, записать
`vars` и историю. У каждой таблицы один владелец (MOD-ARCH-001 §3.6).

### Сервис `IWorkflowRuntime`

```ts
start(processKey, { input, partition?, businessKey?, actor }): Promise<InstanceDetails> // invalid_input с issues
cancel(instanceId, { reason?, actor })                     // wrong_status, если уже завершён
retry(instanceId, { actor })                               // wrong_status, если не failed
emit(eventKey, payload, { correlation?, partition? })      // этап 3: старт, продолжение ожидания, граничное событие
completeToken(tokenId, output, actor)                      // для userTask; проверяет output по форме
instances(query: { partition?, status?, processKey?, businessKey?, startedById?, limit?, offset? })
instance(instanceId): Promise<InstanceDetails>             // с токенами
history(instanceId): Promise<readonly HistoryEntry[]>
```

### Движок (`internal/`)

- **Состояния в памяти нет.** Каждое изменение — транзакция со строкой
  экземпляра под `FOR UPDATE`; перезапуск и второй экземпляр приложения ничего
  не теряют. Графы версий кэшируются: версии неизменяемы.
- **Токены** идут по переходам, пока не встанут в ожидание или не закончатся;
  экземпляр `completed`, когда живых токенов нет.
- **Задания** создаются в той же транзакции, что и ждущий токен. Воркер берёт их
  `FOR UPDATE SKIP LOCKED` с арендой, выполняет вне транзакции, результат
  применяет в транзакции шага; если токен за это время закрыли, результат
  отбрасывается.
- **`serviceTask`:** `ToolRunner.as("workflow").run(tool, input, { actor,
  idempotencyKey: tokenId, metadata: { instanceId, partition, processKey, nodeId } })`.
  `actor` — кто запустил экземпляр (`system` для запусков по событию и
  расписанию). Подтверждение и аудит — по `TOOL_EXECUTION_OPTIONS`, без
  скрытого обхода; ход вызова пишется в историю (`tool`).
- **Повторы:** `config.retry` (`maxAttempts`, `backoff` ISO 8601) узла; затем
  `boundaryError` с подходящим `errorCode`, иначе экземпляр `failed` и ждёт
  `retry` или `cancel`.
- **Шлюзы:** выбор — первое истинное условие в порядке документа, иначе
  `isDefault`, иначе `failed` (`no_branch`); параллельный — разделение и
  слияние.
- **Таймеры** (`timerCatch`, `boundaryTimer`) — задания с `dueAt`.
- **События:** `emit` стартует процессы с `eventStart`, продолжает токены в
  `eventWait` и запускает `boundaryEvent`; сопоставление — по `WfSubscription` в
  той же транзакции.
- **Расписание:** `scheduleStart` — задание `schedule` на последнюю версию;
  следующее планируется при срабатывании.
- **`userTask`:** токен ждёт, публикуется `WORKFLOW_TASK_REQUESTED`;
  `completeToken` двигает процесс дальше; при отмене —
  `WORKFLOW_TOKEN_CLOSED`.
- **Отмена** закрывает токены, задания и подписки.

### Фон

| Служба | Что делает |
| --- | --- |
| `WorkflowWorker` | раз в `worker.intervalMs` берёт до `worker.batchSize` заданий; пришла полная пачка — сразу берёт следующую |
| `WorkflowRetention` | раз в `retention.intervalMs` удаляет `completed` и `cancelled` экземпляры старше `retentionDays` процесса пачками по `retention.batchSize`; `failed` не трогает |

### Настройки (`config/Runtime.config.ts`)

```ts
export const workflowRuntimeConfig = defineConfig("workflow", {
  default: {
    "worker.enabled": true, "worker.intervalMs": 1000, "worker.batchSize": 10,
    "retention.enabled": true, "retention.intervalMs": 3_600_000, "retention.batchSize": 500,
  },
});
```

Значения — из конфигурации приложения: `bazis.config.json` или
`BAZIS_WORKFLOW__WORKER__ENABLED=false` (например, веб-экземпляры без
воркера). Аренда задания (5 минут) — внутренняя константа.

### События (`events/`)

| Событие | Когда | Данные |
| --- | --- | --- |
| `WORKFLOW_TASK_REQUESTED` | токен дошёл до `userTask` | `instanceId`, `tokenId`, `processKey`, `nodeId`, `partition`, `title`, `assignee`, `form`, `dueAt` |
| `WORKFLOW_TOKEN_CLOSED` | ждущий токен закрыт не завершением задачи | `instanceId`, `tokenId`, `reason` |
| `WORKFLOW_INSTANCE_FINISHED` | экземпляр завершён | `instanceId`, `processKey`, `partition`, `status` |

События публикуются в транзакции шага (`afterCommit`).

### HTTP

| Метод и путь | Право | Ответ |
| --- | --- | --- |
| `POST /workflow/instances` | `instances.start` | 201 экземпляр / 404 / 422 `invalid_input` |
| `GET /workflow/instances` | `instances.read` | список с фильтрами |
| `GET /workflow/instances/:id` | `instances.read` | экземпляр с токенами |
| `GET /workflow/instances/:id/history` | `instances.read` | история |
| `POST /workflow/instances/:id/cancel` | `instances.manage` | 200 / 409 `wrong_status` |
| `POST /workflow/instances/:id/retry` | `instances.manage` | 200 / 409 `wrong_status` |
| `POST /workflow/events/:eventKey` | `events.emit` | 202 |

## 5. Tasks

### Модель (owned store `bazis.workflow.tasks`, префикс `bazis_wf_task_`)

**`WfTask`** (`bazis_wf_task_items`): `id`, `tokenId` (уникальный; ссылка без
FK), `instanceId`, `processKey`, `nodeId`, `partition`, `title`, `assignee`
(`user:<id>` или `role:<код>`), `form` (json), `dueAt`, `status` (`open`,
`claimed`, `completed`, `cancelled`), `claimedById`, `claimedAt`,
`completedById`, `completedAt`, `output` (json), `createdAt`. Индексы
`(assignee, status)`, `(partition, status)`.

### Сервис `IWorkflowTasks`

```ts
list({ assignees: string[], status?, partition?, limit?, offset? })
get(taskId)
claim(taskId, actor)        // conflict, если взята другим
release(taskId, actor)
complete(taskId, output, actor)  // invalid_input по форме; вызывает IWorkflowRuntime.completeToken
```

Обработчики событий: `WORKFLOW_TASK_REQUESTED` создаёт задачу,
`WORKFLOW_TOKEN_CLOSED` отменяет её.

### HTTP (`/workflow/tasks`)

| Метод и путь | Право | Ответ |
| --- | --- | --- |
| `GET /workflow/tasks` | `tasks.work` | задачи для `WorkflowAccess.assignees(ctx)` |
| `GET /workflow/tasks/:id` | `tasks.work` | задача с формой |
| `POST /workflow/tasks/:id/claim` | `tasks.work` | 200 / 409 |
| `POST /workflow/tasks/:id/release` | `tasks.work` | 200 |
| `POST /workflow/tasks/:id/complete` | `tasks.work` | 200 / 422 `invalid_input` |

## 6. Права: порт `WorkflowAccess`

Контроллеры фреймворка не знают, как в приложении устроен вход. Права и
«кто делает запрос» даёт порт — абстрактный класс, он же DI-токен:

```ts
export abstract class WorkflowAccess {
  /** Кто делает запрос; undefined — 401. */
  abstract actor(ctx: HttpContext): ToolActor | undefined;
  /** Можно ли действие над целью; false — 403. */
  abstract can(ctx: HttpContext, action: WorkflowAction, target: WorkflowAccessTarget): boolean | Promise<boolean>;
  /** Кому адресованы задачи этого пользователя: user:<id>, role:<код>. */
  assignees(ctx: HttpContext): readonly string[] { … `user:${actor.id}` … }
}

type WorkflowAction =
  | "processes.read" | "processes.manage" | "processes.publish"
  | "instances.start" | "instances.read" | "instances.manage"
  | "events.emit" | "tasks.work";

interface WorkflowAccessTarget { processKey?: string; partition?: string; instanceId?: string; taskId?: string }
```

- По умолчанию всё запрещено: пока приложение не зарегистрировало свою
  реализацию, HTTP модуля отвечает 403. Сервисы порт не проверяют: их вызывает
  код приложения, который сам решает, что можно.
- Приложение регистрирует реализацию в любом модуле:
  `DI.singleton(DI.classProvider(WorkflowAccess, AppWorkflowAccess, []))`.
  Так же подключается свой `WorkflowInputValidator`.
- Списки фильтруются тем же портом: `instances.read` проверяется на
  `partition` из запроса.

## 7. Tools

Шаг `serviceTask` — Tool модуля-владельца операции (`tools/X.tool.ts`, поле
`tools` его `@Module`) с `callers`, где есть `workflow`. Workflow-модуль Tools
не регистрирует, а вызывает через `ToolRunner.as("workflow")`. Каталог для
дизайнера — `GET /workflow/tools` (`listTools` и `describe`). `write`-Tools
обязаны соблюдать `idempotencyKey`: после сбоя между вызовом и транзакцией
шага вызов может повториться (TOOLS-001 §7).

## 8. Хранилища

Каждая часть владеет своим [owned store](../guide/database/owned-stores.md):
фреймворк сам создаёт и проверяет таблицы в базе приложения.

- Схема части фиксируется целиком, когда часть выходит: Definitions и Runtime —
  на этапе 1 (включая `WfSubscription` и поля для этапов 2–3), Tasks — на
  этапе 4. Следующие этапы схему не меняют.
- Owned store не меняется на месте. Если схему всё же придётся изменить,
  выпуск объявляет новое хранилище с новым префиксом и даёт в
  `upgrading.md` перенос данных.

## 9. Точки расширения

- `WorkflowAccess` — права и личность в HTTP (§6).
- `WorkflowInputValidator` — проверка входа процесса и форм задач (по
  умолчанию — поля §2; bazis-cms подставляет правила дата-менеджера).
- Виды узлов закрыты в v1: новый вид — новая версия документа, а не плагин
  приложения, чтобы опубликованные версии не меняли смысла.

## 10. Ошибки

`WorkflowError` с кодами и HTTP-статусами: `not_found` (404), `conflict`
(409), `wrong_status` (409), `invalid_document` (422, `issues`),
`invalid_input` (422, `issues`), `archived` (409).

## 11. Надёжность и безопасность

- Задание применяет ровно один воркер (аренда и `SKIP LOCKED`); Tool может
  выполниться повторно после сбоя — поэтому ключ идемпотентности.
- Процесс вызывает только Tools с `callers: ["workflow"]`; проверяют и
  публикация, и `ToolRunner`.
- Экземпляр помнит, кто его запустил; Tools выполняются от его имени.
- Условия без кода, пути без доступа к прототипу; размер документа ограничен.

## 12. Этапы

Каждый этап — минорный выпуск с тестами на PostgreSQL и главой руководства.

1. `library/workflow`; Definitions целиком; Runtime: старт и конец,
   `serviceTask`, оба шлюза, `userTask` как ожидание с событиями и
   `completeToken`, отмена и повтор, история, воркер, чистка, HTTP;
   `WorkflowAccess`.
2. Повторы и `boundaryError`; таймеры (`timerCatch`, `boundaryTimer`).
3. События (`eventStart`, `eventWait`, `boundaryEvent`, `emit`, HTTP) и
   расписание.
4. Часть Tasks.
5. Процессы в коде — **решение позже**: файл `processes/X.process.ts` в
   модуле-владельце и поле `processes` в `@Module` (публикация при старте,
   ошибка конфигурации при неизвестном Tool), помощник тестов
   `testWorkflow` (`drain`, управляемое время), команды CLI `g process`,
   `workflow check`, `workflow diagram`.

## 13. Переход bazis-cms

CMS убирает свои `wf_processes`, `wf_process_versions`, `wf_instances`,
`wf_tokens`, `wf_jobs`, `wf_history`, движок, воркер, проверку документа и
контроллеры процессов и экземпляров. Оставляет дизайнер и UI; пространства
передаёт как `partition`; права — своей реализацией `WorkflowAccess`; правила
полей — `WorkflowInputValidator`; подключение процессов к пространствам и
«кто запускает» — своей таблицей, которую читает её `WorkflowAccess`.
Документы переходят с `cms.workflow/v1` на `bazis.workflow/v1` (то же
содержимое).
