# Бизнес-процессы из коробки: конструктор

Идентификатор: **WORKFLOW-002**. Версия: **1.0**. Дата: **2026-10-31**.
Статус: **черновик на рецензии** (владелец, агент bazis-cms).
Основа: [WORKFLOW-001](WORKFLOW.md) (этапы 1–5, bazis 0.124.0–0.128.0),
[TOOLS-001](TOOLS.md), прототип дизайнера
<https://claude.ai/artifact/SZDPQ1N7xU7qLiyZ4siz5n>, обсуждение агентов
bazis и bazis-cms 2026-10-31.

## 1. Цель и правило границы

Разработчик ставит только фреймворк — бизнес-процессы работают целиком: всё,
что есть в прототипе как понятие процесса, исполняется, хранится и доступно по
HTTP. Он добавляет свои роли и доступы, свой UI и свои действия (Tools).
Разработчик ставит bazis-cms — всё работает без дописывания логики процессов.

Правило: **понятие процесса и его исполнение — во фреймворке; предметные
действия и данные — Tools приложения; права, ссылки и данные приложения —
через порты.** Два запрета:

- приложение не хранит документы, версии и экземпляры процессов и не пишет
  свой движок;
- фреймворк не знает о Data Manager, пространствах CMS и языках интерфейса.

Прототип — целевой конструктор. Его модель (шаги списком, ветки «Да/Нет»,
тело цикла) — вид редактора, а не формат исполнения (§3).

## 2. Решения обсуждения

Выбор, который сделан, и почему; отвергнутое — тоже.

| Вопрос | Решение | Отвергнуто и почему |
| --- | --- | --- |
| Формат исполнения | Граф (`bazis.workflow/v2` — развитие v1) | Список шагов как формат: теряет произвольные переходы и граничные события, движок пяти выпусков ушёл бы в переделку |
| Вид редактора | Структурное подмножество графа (§3.6); дизайнер CMS рисует его как в прототипе | — |
| Выражения | JSON-дерево с закрытым списком функций (§3.3); текст `{amount} * 1.2` — только в дизайнере | Текстовый язык с парсером: дорого, риск инъекций |
| Действия с данными, HTTP, уведомления | Только Tools | Порт `WorkflowDataSource`: второй путь действий, CRUD «наименьший общий знаменатель» |
| HTTP-запрос и секреты | Необязательный модуль стандартных Tools `bazis/core/tools` (§7), закрытый по умолчанию | В ядре движка: фреймворк стал бы продуктом; только в приложении: на одном фреймворке «из коробки» не работает |
| Настройки процесса | Внутри версии документа (§3.5) | Колонками: каждое новое поле — новое хранилище |
| Карточка процесса | Во фреймворке: локализованные названия, папка-путь, владелец-id (§4.1) | В CMS: у приложения на фреймворке нет каталога «как в прототипе» |
| Названия | `LocalizedText` — язык → текст, язык по умолчанию из настроек | Пара `{ru, en}`: зашивает языки CMS |
| Задачи сотрудникам | Остаются (`userTask`, часть Tasks) | Убрать как отсутствующие в прототипе: «ждать решения менеджера» и есть задача |
| Списки HTTP | JSON:API (`bazis/library/jsonapi`) | `limit`/`offset`: второй стиль в одной админке |
| Аудит | События после успешных действий (§4.4); журнал пишет приложение | Свой журнал аудита во фреймворке |
| Актор шага | `context.actor` в Tool (§6.1); «от имени» — настройка процесса | Поле `author` в данных процесса |

## 3. Документ `bazis.workflow/v2`

Тот же граф v1 (`nodes`, `flows`, `diagram`), плюс то, что ниже. Все 13 видов
узлов v1 остаются с тем же смыслом.

### 3.1 Корень

```ts
interface ProcessDocument {
  schemaVersion: "bazis.workflow/v2";
  variables?: VariableSpec[];          // §3.4, вместо input v1
  settings?: ProcessSettings;          // §3.5
  nodes: Record<string, ProcessNode>;  // title: LocalizedText
  flows: Record<string, ProcessFlow>;  // title?: LocalizedText, condition?: Expr
  diagram?: ProcessDiagram;
}
type LocalizedText = string | Record<string, string>; // строка — язык по умолчанию
```

### 3.2 Новые виды узлов

| Вид | Роль | `config` |
| --- | --- | --- |
| `assign` | шаг | `assignments: { var, value: Expr }[]` — переменные процесса |
| `loop` | контейнер | `over?: Expr` (коллекция) \| `while?: Expr` \| `times?: number`; `item`, `index` (имена), `maxIterations` (обязателен, ≤ 10 000), `parallel?: { limit }`, `onItemError: "stop" \| "skip"`, `collect?: { from: Expr, to: var }` |
| `callProcess` | шаг | `process` (ключ), `input` (параметр → `Expr`), `saveTo?`; ждёт конца дочернего экземпляра, результат — его выходные переменные |

Тело цикла — узлы с `parent: "<id цикла>"`: свой подграф с одним входом и без
выходов наружу; переходы через границу контейнера запрещены. Итерация — свой
набор токенов в том же экземпляре; переменные итерации видны только телу.

### 3.3 Выражения

`Expr` — JSON-дерево, проверяется проверкой документа, исполняется без `eval`:

```json
{ "op": "mul", "args": [{ "path": "$vars.amount" }, 1.2] }
{ "op": "concat", "args": ["https://api/orders/", { "path": "$input.orderId" }] }
{ "op": "gt", "args": [{ "path": "$event.record.amount" }, 100000] }
```

- Листья: литерал JSON или `{ "path": "…" }`.
- Функции — закрытый список с типами: арифметика (`add` `sub` `mul` `div`
  `mod` `round`), сравнение (`eq` `ne` `gt` `gte` `lt` `lte` `in` `contains`
  `empty` `notEmpty`), логика (`and` `or` `not` `if` `coalesce`), строки
  (`concat` `lower` `upper` `trim` `length` `format`), даты (`now` `dateAdd`
  `dateDiff` `toDate`), списки (`length` `first` `pluck`).
- Новая функция — новая минорная версия формата. Условия v1 (`all`/`any`/`not`
  и сравнение) переводятся в выражения один в один.
- Пределы: глубина 16, 200 узлов на выражение.

Пути (`$` и имя):

| Путь | Что |
| --- | --- |
| `$input.x`, `$vars.x`, `$nodes.Node.x` | Как в v1 |
| `$item`, `$index` (имена из цикла) | Элемент цикла |
| `$event` | Данные события, запустившего или продолжившего процесс |
| `$trigger` | `{ via, at, actor, eventKey?, cause? }` — как запущен |
| `$run` | `{ id, processKey, version, partition, test }` |
| `$now` | Время по часам движка (`WorkflowClock`) |
| `$secrets.NAME` | Только во входе Tool; подставляет исполнитель (§7.2) |

### 3.4 Переменные

```ts
interface VariableSpec {
  name: string;                         // ^[a-z][A-Za-z0-9_]{0,39}$
  type: "string" | "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum" | "object" | "list" | "ref";
  direction: "in" | "local" | "out";
  title?: LocalizedText;
  default?: unknown;
  required?: boolean;                   // для in
  ref?: string;                         // для ref: вид ссылки, например "dm.record:orders" (§6.3)
  extra?: Record<string, unknown>;      // для порта проверки полей: правила, enumValues и т. п.
}
```

`in` — вход запуска (форма ручного запуска и тело `start`), `out` — что
процесс возвращает вызвавшему (`callProcess`, ответ API). Поля форм задач —
тот же `VariableSpec` без `direction`. Порт `WorkflowInputValidator` получает
`extra` и проверяет его: так правила Data Manager живут в документе без того,
чтобы фреймворк их знал.

### 3.5 Настройки процесса (в версии документа)

```ts
interface ProcessSettings {
  runAs?: "starter" | "process";        // от инициатора (по умолчанию) или от системного актора процесса
  runTimeout?: string;                  // ISO-длительность на весь запуск, ожидания входят
  stepTimeout?: string;                 // по умолчанию для шагов с Tool
  maxConcurrent?: number;               // одновременных running-экземпляров процесса
  sameKey?: "allow" | "skip" | "queue"; // новый запуск с тем же businessKey, пока старый идёт
  errorHandler?: string;                // ключ процесса, который запускается при failed/timedOut с $event = сведения об ошибке
}
```

Общие поля `config` шага с Tool: `timeout`, `retry: { maxAttempts, backoff,
growth: "fixed" | "exponential", factor? }` (v1 — `exponential`, множитель 2),
`onError: "fail" | "skip"` (`skip` — шаг пропущен, выход `{ skipped: true,
error }`; граничный `boundaryError` важнее `onError`).

Системный актор процесса — `{ kind: "system", id: "process:<key>" }`. Кто
может так запускать, решает право на публикацию (`WorkflowAccess`).

### 3.6 Структурное подмножество

`isStructured(document)` в `bazis/library/workflow` говорит, рисуется ли граф
как список прототипа: последовательности, развилка `exclusiveGateway` с
одним слиянием, `parallelGateway` со слиянием, контейнер `loop`, граничные
события на шагах. Дизайнер CMS редактирует такие процессы; остальные
(например, из кода) показывает только для чтения. Проверка структурности —
предупреждение, не ошибка.

### 3.7 Переход с v1

`upgradeDocument(v1) → v2` — чистая функция: `input` → переменные `in`,
условия → выражения, `title` как есть. Движок читает опубликованные версии v1
через неё; сохранять можно только v2. Чтение v1 удаляется в выпуске после
перехода bazis-cms (данных v1 в проде нет).

## 4. Каталог (Definitions)

### 4.1 Карточка

`title`, `description` — `LocalizedText`; `folder` — строка-путь
(`Продажи/Заказы`), без сущности «папка»; `owner` — непрозрачный id;
`retentionDays` — как в v1. Язык по умолчанию — `workflow.language` в
настройках (`en`). Схема хранилища меняется → новое owned store
`bazis.workflow.definitions.v2` (префикс `bazis_wf_def2_`) с переносом данных
(§9).

### 4.2 Палитра как данные

`GET /workflow/palette`: виды узлов с ролью и JSON Schema их `config`, список
функций выражений с типами, системные пути, контракты Tools с `callers`
`workflow` (вход и выход в JSON Schema, `sideEffect`, `dryRun`, ссылки
`x-ref`). Дизайнер строит формы шагов по ней: новый Tool приложения
появляется в дизайнере без выпуска фреймворка.

### 4.3 HTTP

Маршруты v1 сохраняются; списки — JSON:API (`filter[folder]`, `filter[search]`,
`page[size]`, `page[number]`, `sort`). Добавляются: `POST /workflow/validate`
(проверка без сохранения), `GET /workflow/palette`, удаление процесса
(`DELETE`, только архивный без живых экземпляров). Оптимистичная блокировка
черновика: `saveDraft(key, document, actor, { expected? })`, где `expected` —
`draftUpdatedAt` прочитанного черновика; иначе `409 conflict`.

### 4.4 События для аудита

После успешного действия, после коммита: `WORKFLOW_PROCESS_CHANGED`
(`created` / `updated` / `draftSaved` / `published` / `archived` /
`restored` / `deleted`), `WORKFLOW_INSTANCE_STARTED`, `WORKFLOW_INSTANCE_CANCELLED`,
`WORKFLOW_INSTANCE_RETRIED`, `WORKFLOW_TASK_COMPLETED` — с актором и целью.
Журнал аудита пишет приложение.

## 5. Исполнение (Runtime)

### 5.1 Запуски

- **Ручной**: `start(key, { input, partition, businessKey, actor, test? })`;
  `sameKey` и `maxConcurrent` проверяются в той же транзакции под
  блокировкой процесса (advisory lock по ключу).
- **Расписание**: `cron`, `timezone` (IANA, по умолчанию UTC), `from?`,
  `until?`, `overlap: "skip" | "queue" | "parallel"`, `catchUp: boolean`
  (по умолчанию `false`, как в 0.128.0). Запуски — по каждому разделу из
  порта `WorkflowPartitions` (§6.4), со своим часовым поясом раздела, если он
  задан.
- **Событие**: `eventStart` с `filter?: Expr` над `$event`,
  `debounce?: { key: Expr, window }` (частые события одного ключа сливаются в
  последнее), `delay?`, `ignoreOwn?: boolean` (не запускать, если событие
  вызвал экземпляр этого же процесса: `emit(…, { cause: { instanceId } })`).
- **Надёжная доставка события**: `emitLater(eventKey, payload, options)` пишет
  задание `event` в `bazis_wf_run_jobs` в текущей транзакции приложения
  (outbox); воркер доставляет его как `emit`. Условие: общее подключение и
  общая транзакция ORM — проверить до этапа 4 (§11).

### 5.2 Ожидание

`eventWait` получает `until?: Expr` над `$event` — продолжить, только когда
условие истинно (ждать, пока запись станет «Одобрен»); остальные события
ключа оставляют шаг ждать. Срок ожидания — `boundaryTimer`, как в v1.

### 5.3 Экземпляр и журнал запусков

К экземпляру добавляются `test`, `parentInstanceId`, `status: "timedOut"`
(срок `runTimeout` вышел; `errorHandler` запускается), `failedNode`,
`durationMs` в ответах. Шаг с `timeout` — ошибка с причиной `timeout`. Список
экземпляров — JSON:API. Схема меняется → `bazis.workflow.runtime.v2`
(`bazis_wf_run2_`), задачи → `bazis.workflow.tasks.v2` (`bazis_wf_task2_`).

### 5.4 Пробный запуск

`start(…, { test: true })`. Tool с `dryRun: "supported"` вызывается с
`context.dryRun = true` и сам ничего не меняет; Tool без поддержки не
вызывается, шаг получает заглушку `{ dryRun: true }` и запись в истории.
Пробные экземпляры не публикуют события приложения (`WORKFLOW_TASK_REQUESTED`
и др.), задачи создаются с пометкой `test`, хранятся сутки.

## 6. Порты для приложения

| Порт | Что даёт приложение | По умолчанию |
| --- | --- | --- |
| `WorkflowAccess` | Личность, права, адресаты задач (как в v1) | Всё запрещено |
| `WorkflowInputValidator` | Проверка значений и `extra` полей (правила Data Manager) | Типы §3.4 |
| `WorkflowReferences` | `exists(ref, ctx)` и `describe(ref)` для ссылок `x-ref`; обратный ход — `IWorkflowDefinitions.referencing(ref)` | Ссылки не проверяются |
| `WorkflowPartitions` | Разделы процесса (пространства): `of(processKey)` → `{ partition, timezone?, enabled }[]` | Один раздел `null` |
| `SecretStore` (`bazis/core/tools`) | Значения секретов по имени | Из конфигурации `secrets.*` |

Все порты получают контекст `{ partition, language, actor }`.

### 6.1 Контракт Tool (TOOLS-001, дополнение)

- `context.actor` в `execute(input, context)` — от чьего имени шаг (по
  `runAs`); поле `author` в данных процесса больше не нужно.
- `dryRun: "supported" | "unsupported"` в `@Tool` (по умолчанию
  `unsupported`).
- Ссылки во входе: `x-ref: "<вид>"` в JSON Schema поля (например,
  `dm.table`, `dm.field` с `x-ref-scope: "table"`).
- `context.metadata` содержит `instanceId`, `processKey`, `nodeId`,
  `partition`, `test` — чтобы Tool мог передать `cause` в свои события.

### 6.2 Проверка ссылок

При публикации и в `bazis workflow check`: каждое литеральное значение поля с
`x-ref` проверяется портом; нет — замечание `broken_ref` с узлом. Выражения
проверяются только при исполнении (причина ошибки `ref_not_found`).
`referencing(ref)` по последним опубликованным версиям отвечает, кто
ссылается на поле или таблицу, — CMS запрещает или предупреждает при
архивации.

## 7. Стандартные Tools: `bazis/core/tools`

Необязательный модуль `StandardToolsModule`; `callers` задаются настройкой
(процессы, агенты).

### 7.1 `http.request`

Метод, URL, заголовки, тело JSON, авторизация (`none`, `bearer`, `basic`,
`apiKey` — значения из `$secrets`), коды успеха, `saveTo`. Защита закрыта по
умолчанию: пустой `tools.http.allow` — запросы никуда; после DNS проверяется
IP, частные, loopback и link-local адреса запрещены; редиректы — только
внутри списка; лимиты на размер ответа (1 МБ) и время; `dryRun: "supported"`
только для `GET` и `HEAD`.

### 7.2 Секреты

`$secrets.NAME` подставляет исполнитель Tools, а не Tool. Значение
регистрируется в редакции вызова (`bazis/library/redaction`) и вырезается
из истории, выхода шага, журнала и ошибок. В документ попадает только имя.

### 7.3 Уведомления

Стандартный Tool только для каналов, которые есть во фреймворке; иначе —
событие процесса, доставку делает приложение.

## 8. Что делает bazis-cms

- Tools Data Manager: `data.record-get/create/update` (есть),
  `data.records-find/update-many/delete` с фильтром DM `filter[field][op]`,
  лимитом и защитой от массовых изменений; `dryRun: "supported"`; `x-ref` на
  таблицы и поля.
- События записей DM через `emitLater` в транзакции записи, с `cause` из
  `context.metadata`; защита от лавины — `ignoreOwn` и `debounce` процесса.
- Порты: `CmsWorkflowAccess` (есть), `DmWorkflowInputValidator` (есть,
  переходит на `extra`), `WorkflowReferences` (таблицы и поля DM),
  `WorkflowPartitions` (`wf_space_processes`: пространства, часовой пояс,
  включённость), секреты — своё хранилище или конфигурация.
- Дизайнер-конструктор по палитре; места кнопок запуска (карточка записи,
  список, массовое действие); свой аудит по событиям §4.4.
- Убирает: поле `author` в Tools записей.

## 9. Хранилища и переход

Схемы трёх частей меняются, поэтому три новых owned store (`…definitions.v2`,
`…runtime.v2`, `…tasks.v2`). Выпуск переносит процессы и версии v1 при
старте: документы через `upgradeDocument`, карточки (`title` → язык по
умолчанию). Экземпляры v1 не переносятся: в проде их нет; живые тестовые
экземпляры завершают на старом выпуске. Старые таблицы `bazis_wf_def_`,
`bazis_wf_run_`, `bazis_wf_task_` удаляются вручную по `upgrading.md`.
Процессы в коде (`defineProcess`) принимают v2; v1 переводится
`upgradeDocument`.

## 10. Этапы

Каждый — минорный выпуск фреймворка с тестами на PostgreSQL, главой
руководства и проверкой в CMS.

1. **Контракт Tool и HTTP**: `context.actor`, `dryRun`, `x-ref`,
   `context.metadata`; списки JSON:API; события аудита §4.4; блокировка
   черновика.
2. **Документ v2**: выражения, `LocalizedText`, переменные, `assign`,
   настройки шага (`timeout`, `growth`, `onError: skip`), `isStructured`,
   `upgradeDocument`, палитра, `/workflow/validate`; хранилища v2 и перенос;
   карточка (`folder`, `owner`).
3. **Цикл и подпроцесс; настройки исполнения**: `loop`, `callProcess`,
   `runAs`, `runTimeout`, `maxConcurrent`, `sameKey`, `errorHandler`,
   `timedOut`.
4. **Запуски и ожидания**: часовой пояс, период, `overlap`, `catchUp`;
   `filter`, `debounce`, `delay`, `ignoreOwn`; `eventWait.until`;
   `WorkflowPartitions`; `emitLater`.
5. **Пробный запуск и ссылки**: `test`, `WorkflowReferences`, `broken_ref`,
   `referencing`; журнал запусков (длительность, шаг ошибки).
6. **`bazis/core/tools`**: `http.request`, `SecretStore`, редакция секретов.

bazis-cms идёт следом за каждым этапом (§8); дизайнер — после этапа 2.

## 11. Открытые вопросы

1. `emitLater` в транзакции приложения: работает ли общая транзакция ORM для
   разных `DbContext` на одном подключении. Если нет — outbox на стороне
   приложения с повторной доставкой и ключом идемпотентности события.
2. Часовой пояс раздела против часового пояса узла расписания: что важнее,
   если заданы оба (предложение: узел, если задан явно).
3. `queue` у `sameKey` и `overlap`: очередь в заданиях (новый вид `pending`
   экземпляра) или отказ с причиной — уточнить на этапе 3.
4. Сколько хранить пробные экземпляры и показывать ли их в общем журнале.
