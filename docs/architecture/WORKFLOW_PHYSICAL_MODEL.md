# Физическая модель бизнес-процессов

Версия: 1.1. Дата: 2026-09-14. **Проект ORM-моделей; модуль не реализован.**

Таблицы описываются моделями существующего ORM Osnova. Ниже зафиксированы
колонки, физические типы, nullability, начальные значения, связи и индексы
для этих моделей. Созданием и обновлением схемы управляет ORM по метаданным.
Точные типы содержимого JSON:
[workflow_physical_contracts.ts](workflow_physical_contracts.ts).
Правила исполнения и восстановления:
[WORKFLOW_DATA_MODEL.md](WORKFLOW_DATA_MODEL.md).

Владелец — один планируемый атомарный `WorkflowModule`, хранилище — один
`WorkflowDbContext` на существующем provider Osnova. Размещение таблиц — `public`.
Это проект данных; каркас модуля и ORM-классы ещё не созданы.
При реализации действуют [архитектура модулей](MODULE_ARCHITECTURE.md)
и [шаблон паспорта](MODULE_SPEC_TEMPLATE.md).

## 1. Общие физические правила

- Идентификаторы сущностей — `@UUID()`, физически нативный `uuid`.
  Генерацией ключа и получением его значения после вставки управляет ORM.
- Идентификатор события — `@Key()` с `@Column({ type: "integer" })`, физически
  `bigint` IDENTITY. Счётчики — `integer` в ORM, `bigint` в БД, с `@Check` безопасного
  диапазона JS: 0…9007199254740991; номера версий, шагов и событий начинаются с 1.
  На границе приложения они преобразуются в `number` после проверки диапазона.
- Статусы и виды — `text` с закрытым `@Check`. Ключи — `text`, 1…128 символов,
  не только пробелы; имена — 1…200 символов, не только пробелы.
  `subject_key` — 1…256 символов, `start_key` — 1…512, сообщение ошибки — 1…2000.
- Время — `datetime` в ORM, физически `timestamptz`. Сервис получает время БД
  через `OrmTransaction.databaseTime()` и заполняет временные поля модели.
  created_at задаётся при вставке, updated_at — при каждой записи изменений.
- В таблицах ниже `NULL: да` означает `@Column({ nullable: true })`;
  `NULL: нет` — `nullable: false`. «—» означает отсутствие default:
  обязательное поле передаёт сервис, необязательное инициализируется null.
  Статические defaults ready / false / 0 задаются через `@Column({ default: ... })`.
  Начальный loop_stack=[] собирает сервис; это значение модели, не SQL DEFAULT.
- Все FK запрещают удаление используемых записей. Каскадного удаления истории нет.
  UUID, ключи и владельцы существующих сущностей не переименовываются.

## 2. `workflow_definition`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK процесса |
| `key` | `text` | нет | — | UNIQUE, стабильный ключ |
| `name` | `text` | нет | — | Название |
| `active_version_id` | `uuid` | да | — | Версия для новых запусков; NULL до первой сохранённой схемы |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Создание |
| `updated_at` | `timestamptz` | нет | Сервис: время БД | Последнее изменение |

`activeVersionId` получает `@ForeignKey(() => WorkflowVersion)`.
Принадлежность версии этому же процессу проверяет сервис в ORM-транзакции.
Сохранение новой версии и изменение указателя выполняются в ней атомарно.

## 3. `workflow_version`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK версии |
| `workflow_id` | `uuid` | нет | — | FK → `workflow_definition.id` |
| `number` | `bigint` | нет | — | Номер версии, начиная с 1 |
| `document` | `jsonb` | нет | — | `WorkflowDocument`, формат в §9 |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Сохранение версии |

Уникальный `@Index(["workflowId", "number"], { unique: true })`.
Сервис проверяет обязательные поля document, formatVersion=1, граф,
вложенные типы и ссылки. После сохранения запись неизменяема через публичные
операции модуля.

## 4. `workflow_instance`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK запуска |
| `workflow_id` | `uuid` | нет | — | FK → workflow_definition.id; принадлежность version_id проверяет сервис |
| `version_id` | `uuid` | нет | — | Версия, закреплённая при создании запуска |
| `status` | `text` | нет | `'ready'` | Состояние запуска |
| `current_step_id` | `uuid` | да | — | Текущий Step; NULL при первой вставке внутри транзакции либо после completed |
| `input` | `jsonb` | нет | — | Неизменяемый объект входных данных |
| `variables` | `jsonb` | нет | — | Текущие значения собственных переменных |
| `loop_stack` | `jsonb` | нет | `[]`, задаёт сервис | Массив активных циклов |
| `start_kind` | `text` | нет | — | manual / event / schedule |
| `start_key` | `text` | нет | — | UNIQUE, ключ конкретного запроса запуска |
| `trigger_id` | `uuid` | да | — | Триггер для автоматического запуска |
| `source_event_id` | `bigint` | да | — | FK → `workflow_event.id`, только для event |
| `scheduled_for` | `timestamptz` | да | — | Плановый момент, только для schedule |
| `revision` | `bigint` | нет | `0` | Версия состояния для конкурентного обновления |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Создание |
| `updated_at` | `timestamptz` | нет | Сервис: время БД | Последнее изменение |
| `finished_at` | `timestamptz` | да | — | Заполнено только для completed / failed |

Статусы: `ready`, `running`, `waiting`, `completed`, `failed`, `unknown`.
Перед завершением ORM-транзакции сервис требует заполненного current_step_id
во всех состояниях кроме completed; при completed он равен NULL.
`unknown` сохраняет указатель на шаг без подтверждённого исхода.

Связи через `@ForeignKey` на соответствующих свойствах:

- workflowId → WorkflowDefinition.id.
- versionId → WorkflowVersion.id.
- triggerId → WorkflowTrigger.id.
- currentStepId → WorkflowStep.id.
- sourceEventId → WorkflowEvent.id.

Сервис под блокировками строк в ORM-транзакции проверяет принадлежность версии
и триггера процессу, совпадение kind триггера со startKind, принадлежность
текущего шага запуску. Обычный FK обеспечивает существование строки;
проверки владельца являются обязанностью сервиса. При manual triggerId=null.

| start_kind | trigger_id | source_event_id | scheduled_for |
| --- | --- | --- | --- |
| manual | NULL | NULL | NULL |
| event | обязательно | обязательно | NULL |
| schedule | обязательно | NULL | обязательно |

Эту таблицу сочетаний выражает `@Check` модели. Форматы ключа запуска:
`manual:<requestId UUID>`, `event:<triggerId UUID>:<eventId>`,
`schedule:<triggerId UUID>:<scheduledFor в UTC>`. Время в ключе нормализуется
к `YYYY-MM-DDTHH:mm:ss.sssZ`; расписание не создаёт субмиллисекундных моментов.
Повтор ключа возвращает прежний запуск после проверки совпадения запроса.

Для первой записи сервис создаёт Instance с currentStepId=null, сохраняет его
через ORM и получает id. Затем создаёт и сохраняет первый Step, присваивает
его id свойству currentStepId и сохраняет Instance. Все сохранения выполняются
в одной `transactionScope`; при любой ошибке откатывается весь набор.
Сервис проверяет заполненность и владельца указателя до выхода из транзакции.
Промежуточный NULL нужен только для этой последовательности вставок;
зафиксированный активный запуск всегда имеет текущий шаг.
При переходе вставка следующего Step, завершение предыдущего и смена указателя
также атомарны. Статусы Instance и текущего Step согласует сервис в этой транзакции.

## 5. `workflow_step`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK прохождения узла; сохраняется при повторе |
| `instance_id` | `uuid` | нет | — | FK → `workflow_instance.id` |
| `number` | `bigint` | нет | — | Номер прохождения внутри запуска, начиная с 1 |
| `node_id` | `text` | нет | — | Узел внутри document закреплённой версии |
| `kind` | `text` | нет | — | Вид узла; проверяется на соответствие версии |
| `status` | `text` | нет | `'ready'` | Состояние прохождения |
| `input` | `jsonb` | нет | — | Объект сохранённых аргументов по §9 |
| `output` | `jsonb` | да | — | Результат; SQL NULL до подтверждённого завершения |
| `error_code` | `text` | да | — | Код ошибки для failed / unknown |
| `error_message` | `text` | да | — | Безопасное сообщение для failed / unknown |
| `attempt` | `bigint` | нет | `0` | Номер попытки, увеличивается до вызова |
| `worker_id` | `text` | да | — | Исполнитель текущей попытки |
| `lease_until` | `timestamptz` | да | — | Срок захвата работы исполнителем |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Создание прохождения |
| `started_at` | `timestamptz` | да | — | Регистрация первой попытки, повтор не изменяет |
| `finished_at` | `timestamptz` | да | — | Заполнено только для completed / failed |
| `wake_at` | `timestamptz` | да | — | Абсолютный момент продолжения delay |
| `wait_event_type` | `text` | да | — | Тип события для wait |
| `wait_subject_key` | `text` | да | — | Объект ожидания для wait |
| `wait_condition` | `jsonb` | да | — | Сохранённый WaitCondition; SQL NULL — без фильтра |
| `event_cursor` | `bigint` | да | — | Последнее рассмотренное событие для wait |
| `matched_event_id` | `bigint` | да | — | FK → `workflow_event.id`, завершившее wait событие |

Уникальный `@Index(["instanceId", "number"], { unique: true })`.
Виды: `start`, `activity`, `condition`, `loop`, `delay`, `wait`, `end`.
Статусы совпадают с набором Instance. Каждое прохождение тела цикла создаёт
новую строку Step; повтор одной попытки использует ту же строку и новый attempt.

`@Check` моделей фиксируют следующие сочетания:

- `running`: worker_id и lease_until заполнены; в остальных статусах оба NULL.
- attempt=0: status=ready и started_at=NULL; attempt>0: started_at заполнено.
- `completed`: output не SQL NULL, обе колонки ошибки NULL.
- `failed` / `unknown`: output SQL NULL, обе колонки ошибки заполнены.
- `ready` / `running` / `waiting`: output и обе колонки ошибки SQL NULL.
- `waiting` допустим только для delay / wait. У delay заполнен wake_at;
  у wait — wait_event_type, wait_subject_key и event_cursor.
- wake_at разрешён только для delay. Все event-поля разрешены только для wait.
  У завершённого wait обязательно matched_event_id; в остальных случаях оно NULL.

Для успешного метода с результатом `null` или `void` записывается
`output = JSON null` и status=completed. SQL NULL и JSON null различаются
в хранилище; статус остаётся основным признаком завершения при чтении через ORM.
У start / condition / loop / delay / end результат также JSON null.
У wait результат — payload найденного события. `running` означает зарегистрированную
попытку, но при аварии не доказывает сам факт входа в метод. Истечение lease
не разрешает автоматически повторять внешний эффект; восстановление описано в
[модели исполнения](WORKFLOW_DATA_MODEL.md).

### Изменение кодовой базы

WorkflowStep — одна общая ORM-модель для всех видов activity. Для выполнения
создаётся строка этой модели. Параметры методов сохраняются в типизированных
input/output внутри jsonb; добавление activity или изменение её параметров
само по себе не создаёт колонки или новую ORM-модель.

WorkflowVersion сохраняет граф, настройки и activityId. Исходный код методов
сервисов и сборка приложения в ней не сохраняются. После обновления приложения
реестр связывает activityId с методом установленной сборки; ORM не восстанавливает
прежнюю реализацию метода из записи Step.

Перед возобновлением сервис проверяет наличие регистрации и совместимость
сохранённых аргументов, привязок и результата с контрактом закреплённой версии.
Несовместимый шаг сохраняется и требует внимания с конкретной ошибкой;
автоматический вызов с подменой аргументов или запуск процесса с начала запрещён.
Уже завершённые шаги используют сохранённый результат. Прерванная попытка
с неизвестным исходом дополнительно проходит правила восстановления unknown.

Предлагаемое правило для разработчика: совместимый рефакторинг сохраняет
activityId; несовместимый контракт или изменение поведения, которое не должно
затронуть старые процессы, получает новый activityId, например sendSms.v2.
Прежняя регистрация и прежняя реализация сохраняются, пока старые запуски
могут к ним обратиться. Два ID, указывающие на один изменённый метод,
старое поведение не сохраняют. Совпадение типов не доказывает совместимость
смысла операции; автоматически проверить это по сигнатуре нельзя.

Изменение полей самой WorkflowStep — отдельное изменение схемы ORM. Переименование
колонки или смена её типа требует явного переноса сохранённых данных средствами
ORM и проверки совместимости перед возобновлением. Создание таблицы заново
с потерей прогресса не допускается.

## 6. `workflow_trigger`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK правила запуска |
| `workflow_id` | `uuid` | нет | — | FK → `workflow_definition.id`; ссылки на версию здесь нет |
| `kind` | `text` | нет | — | event / schedule |
| `enabled` | `boolean` | нет | `false` | Правило включено |
| `input_bindings` | `jsonb` | нет | — | Объект InputBindings для входа процесса |
| `event_type` | `text` | да | — | Обязательно для event |
| `subject_key` | `text` | да | — | Ограничение на объект; NULL — все объекты типа |
| `condition` | `jsonb` | да | — | Condition для event; SQL NULL — без фильтра |
| `event_cursor` | `bigint` | да | — | Последнее рассмотренное событие; обязательно для включённого event |
| `cron` | `text` | да | — | Расписание, 1…128 символов, обязательно для schedule |
| `time_zone` | `text` | да | — | Имя часового пояса, 1…128 символов, обязательно для schedule |
| `next_run_at` | `timestamptz` | да | — | Ближайший запуск включённого schedule |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Создание |
| `updated_at` | `timestamptz` | нет | Сервис: время БД | Последнее изменение |

workflow_id и kind после создания не меняются. Настройки фильтра и расписания
изменяемы через сервис с правилами обработки cursor из модели исполнения.

`@Check`: для event все поля расписания NULL; для schedule все поля события NULL.
У выключенного schedule next_run_at=NULL. У включённого schedule оно обязательно.
Для выключенного event курсор может храниться, но при включении устанавливается
по правилам подписки. Формат cron и существование time_zone проверяет выбранный
парсер; ограничение длины строки не проверяет корректность расписания.

Пропущенные после простоя новые запуски не создаются: next_run_at пересчитывается
на следующий будущий момент. Уже созданные Instance продолжаются с сохранённого
шага. Поля выбора политики пропусков в таблице нет.

## 7. `workflow_event`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `bigint` | нет | `@Key()` | PK; `@Check` диапазона 1…9007199254740991 |
| `event_key` | `uuid` | нет | — | UNIQUE; стабильный ключ события от производителя |
| `type` | `text` | нет | — | Тип события |
| `subject_key` | `text` | да | — | Ключ изменившегося объекта |
| `payload` | `jsonb` | нет | — | JSON-объект данных события |
| `occurred_at` | `timestamptz` | нет | — | Время события от производителя |
| `recorded_at` | `timestamptz` | нет | Сервис: время БД | Время записи в журнал |

У event_key намеренно нет генерации по умолчанию: повторная доставка должна
приносить тот же ключ. Сервис не заменяет его новым UUID. Дубликат с другим
содержимым отклоняется. Изменение объекта и запись его события в общей БД
должны входить в одну физическую транзакцию.

IDENTITY сам по себе не задаёт порядок COMMIT. Для чтения по event_cursor
сохраняется протокол из модели исполнения: все писатели одного type получают
одну транзакционную advisory-блокировку до выделения id и держат её до COMMIT;
постановка нового wait использует ту же блокировку для начального курсора.
Это требование к порядку ORM-операций сервиса записи. Поддержка необходимой
блокировки должна быть обеспечена публичным ORM-контрактом при реализации;
наличие самой таблицы порядок COMMIT не гарантирует.
События, на которые ссылается история или которые ещё нужны потребителям,
не удаляются.

## 8. `workflow_global_value`

| Колонка | PostgreSQL | NULL | Начальное значение / источник | Назначение |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | нет | `@UUID()` | PK общего значения |
| `key` | `text` | нет | — | UNIQUE во всём каталоге |
| `name` | `text` | нет | — | Отображаемое имя |
| `kind` | `text` | нет | — | variable / constant |
| `contract` | `jsonb` | нет | — | BoundarySchemaV1, описывающий value |
| `value` | `jsonb` | нет | — | Само значение, включая JSON null при допускающем его контракте |
| `revision` | `bigint` | нет | `0` | Номер изменения для защиты от потери конкурентной записи |
| `created_at` | `timestamptz` | нет | Сервис: время БД | Создание |
| `updated_at` | `timestamptz` | нет | Сервис: время БД | Последнее изменение |

БП может изменять только kind=variable. kind=constant меняется вручную в настройках.
key, kind и contract неизменяемы через публичные операции после создания записи.
Эти права и неизменяемость обеспечивает сервис-владелец. `@Check` проверяет kind,
а валидатор — форму contract, весь контракт и соответствие ему value.

Запись выполняется при совпадении ожидаемой revision и увеличивает её на 1.
Изменение глобальной переменной из локальной activity и завершение Step
фиксируются одной физической транзакцией. Конфликт revision не перезаписывается
молча. Если глобальное значение читается при подготовке шага, его конкретное
значение попадает в сохранённый Step.input.

## 9. Что именно находится внутри `jsonb`

| Колонка / путь | Контракт сохранённых данных |
| --- | --- |
| `workflow_version.document` | WorkflowDocument из файла типов |
| `document.inputContract` | FieldsContract: object с properties, required и additionalProperties=false |
| `document.variablesContract` | VariablesContract: тот же object; у каждой переменной явный default |
| `document.constants` | Объект `key → { contract: BoundarySchemaV1, value: JsonValue }` |
| `workflow_instance.input` | Объект, проверенный по inputContract закреплённой версии |
| `workflow_instance.variables` | Объект, проверенный по variablesContract закреплённой версии |
| `workflow_instance.loop_stack` | Массив `{ nodeId: Key, iteration: целое >= 1 }`; внешний цикл первым |
| `workflow_step.input` | StepInputsByKind: точная форма для сохранённого kind |
| `workflow_step.output` | StepOutputsByKind после completed; до этого SQL NULL |
| `workflow_step.wait_condition` | WaitCondition: дерево сравнения, только literal и event |
| `workflow_trigger.input_bindings` | Объект `имя входного поля → ValueRef` |
| `workflow_trigger.condition` | Condition: compare / all / any; SQL NULL — без фильтра |
| `workflow_event.payload` | JSON-объект по контракту типа события |
| `workflow_global_value.contract` | BoundarySchemaV1 |
| `workflow_global_value.value` | JsonValue, прошедший проверку по contract |

`BoundarySchemaV1` уже существует в
[boundary/schema/types-v1.ts](../../src/osnova/library/boundary/schema/types-v1.ts).
Это конкретный формат Osnova, а не обещание поддержки произвольного JSON Schema.

| type | Поля типа, кроме общих |
| --- | --- |
| null | enum из null |
| boolean | enum из boolean |
| string | enum, minLength, maxLength, format |
| number / integer | enum, minimum, maximum, exclusiveMinimum, exclusiveMaximum |
| array | items обязательно; minItems, maxItems, uniqueItems=true |
| object | properties, required, minProperties, maxProperties, additionalProperties=false либо схема значений |

Общие необязательные поля: title, description, nullable, readOnly, writeOnly,
secret, default. Допустимые string.format: date, time, date-time, uuid, email,
decimal, int64-string. Неизвестные поля контракта отклоняются существующим декодером.
readOnly в схеме не заменяет правило kind=constant и права сервиса.

Корни inputContract и variablesContract — ненулевые закрытые объекты с явно
записанными properties / required / additionalProperties. В variablesContract
required содержит все ключи properties, у каждой переменной есть корректный default.
Пустой набор задаётся properties={}, required=[], additionalProperties=false.
Это выбранное правило проекта физической модели, позволяющее всегда создавать
полный начальный объект переменных.

Например, сохранённый variablesContract:

```json
{
  "type": "object",
  "properties": {
    "approved": { "type": "boolean", "default": false },
    "attempts": { "type": "integer", "minimum": 0, "default": 0 }
  },
  "required": ["approved", "attempts"],
  "additionalProperties": false
}
```

При создании запуска сервис соберёт `variables = {"approved":false,"attempts":0}`.
Сам [validateBoundaryValueV1](../../src/osnova/library/boundary/schema/validateBoundaryValueV1.ts)
только проверяет данные и defaults не вставляет. Сначала сервис собирает значения
по defaults; затем проверяет целый объект. Для входных данных defaults заполняют
отсутствующие поля с объявленным default; обязательное поле без default должно
быть передано при запуске. Перед записью схемы применяется
[decodeBoundarySchemaV1](../../src/osnova/library/boundary/schema/decodeBoundarySchemaV1.ts).

WorkflowDocument всегда содержит formatVersion, entryNodeId, inputContract,
variablesContract, constants, nodes, layout. Поля nullable-узлов condition и
resultVariable присутствуют явно, даже когда равны null. Значения по умолчанию
редактора нормализуются до INSERT, а не возникают неявно внутри jsonb.
В одном документе ровно один start; nodeId уникальны, ссылки указывают на узлы
этой версии. SQL не умеет использовать обычный FK для ссылок внутрь такого JSON;
эту целостность и допустимые источники ValueRef проверяет сервис.

Для activity Step.input — объект именованных параметров метода, output — его
результат. Метаданные обоих типов извлекаются из сигнатуры при codegen.
Отдельной таблицы activity и ручного повторения её входной/выходной схемы нет.
После сохранения аргументы шага не пересчитываются при повторе. В wait_condition
все ссылки, кроме event, уже превращены в literal; изменение настройки не меняет
сохранённый критерий ожидания. Точное дерево ссылок, условий и узлов задаёт
[файл типов](workflow_physical_contracts.ts).

Размещение четырёх областей данных:

- Переменные процесса: объявления/defaults в Version.document.variablesContract,
  значения каждого запуска в Instance.variables.
- Константы процесса: тип и значение в Version.document.constants;
  работающий запуск использует закреплённую версию.
- Глобальные переменные: строки workflow_global_value с kind=variable.
- Глобальные константы: строки той же таблицы с kind=constant, изменение в настройках.

Предлагаемое правило чтения глобальных значений: актуальные данные берутся из БД
при подготовке нового шага; готовые input и критерий ожидания сохраняются.
Повтор того же прохождения использует сохранённые значения. Это правило чтения
является предложением проекта; хранение всех четырёх областей в БД согласовано.

## 10. Индексы и интеграция с ORM

Каждая таблица соответствует одному классу с `@Entity({ table: ... })`.
Имена свойств — camelCase; snake_case колонок задаётся `@Column({ name: ... })`.
Все семь классов явно перечисляются в `ormOsnova.entities` одного WorkflowDbContext.
Создание схемы выполняется в режиме ORM, выбранном host-композицией по
[архитектуре модулей](MODULE_ARCHITECTURE.md). Отдельный SQL-файл и ручная миграция
Workflow не являются частью проекта.

| Данные модели | Объявление средствами ORM | Физический результат |
| --- | --- | --- |
| UUID PK | `@UUID()` | uuid, генерация ключа ORM/БД |
| event.id | `@Key()` и `@Column({ type: "integer", nullable: false })` | bigint IDENTITY |
| Связь на UUID PK | `@ForeignKey(() => Target)` и `@Column({ type: "text", nullable: ... })` | UUID наследуется от PK целевой модели |
| Счётчик | `@Column({ type: "integer", nullable: false })` | bigint |
| Строка / статус | `@Column({ type: "text", nullable: ... })` | text |
| Флаг | `@Column({ type: "boolean", nullable: false })` | boolean |
| Момент времени | `@Column({ type: "datetime", nullable: ... })` | timestamptz |
| Документ / данные | `@Column({ type: "json", nullable: ... })` | jsonb |
| Уникальность | `@Index([...], { unique: true })` | Уникальный индекс |
| Диапазон / набор / сочетание полей | `@Check(name, fields => ...)` | CHECK из поддерживаемого выражения |

Длины строк, содержимое JSON и связи владельцев проверяет сервис и существующие
валидаторы. Эти проверки не объявляются автоматически обеспеченными БД.

Уникальные индексы:

| Модель | Свойства |
| --- | --- |
| WorkflowDefinition | key |
| WorkflowVersion | workflowId, number |
| WorkflowInstance | startKey |
| WorkflowStep | instanceId, number |
| WorkflowEvent | eventKey |
| WorkflowGlobalValue | key |

Остальные индексы также описываются `@Index([...])`; используются обычные
составные индексы, поддерживаемые текущим ORM. Фильтры по status/kind включаются
в запрос и в ключ индекса.

| Модель | Индексируемые свойства; отдельные индексы разделены точкой с запятой |
| --- | --- |
| WorkflowDefinition | activeVersionId |
| WorkflowInstance | status, updatedAt, id; workflowId, createdAt, id; versionId, createdAt, id; triggerId; sourceEventId; currentStepId |
| WorkflowStep | status, leaseUntil, id; kind, status, wakeAt, id; kind, status, waitEventType, waitSubjectKey, id; matchedEventId |
| WorkflowTrigger | enabled, kind, nextRunAt, id; enabled, kind, eventType, id; workflowId, enabled, id |
| WorkflowEvent | type, id; type, subjectKey, id |

Источники текущих возможностей:
[декораторы](../../src/osnova/library/orm/Metadata/decorators.ts),
[выражения Check](../../src/osnova/library/orm/Schema/CheckExpression.ts),
[физические UUID](../../src/osnova/library/orm/Schema/physicalColumnTypes.ts),
[PostgresDialect](../../src/osnova/library/orm/Providers/PostgresDialect.ts).

Для output и WorkflowGlobalValue.value требуется корректное сохранение и чтение
любого JSON-скаляра, включая JSON null и строку "123", через ORM. Текущий
PostgresDialect преобразует входной null в SQL NULL и повторно разбирает некоторые
строковые значения; требуемое поведение пока не подтверждено. При реализации
этот случай необходимо проверить и при необходимости исправить в существующем
ORM. Прямые SQL-запросы внутри Workflow для обхода этого ограничения не вводятся.

В этом документе зафиксирована физическая структура. Синтаксические лимиты cron,
поведение часовых поясов и пределы размера workflow-документа относятся к остающимся
контрактам исполнения. Они не подменяются проверкой длины text или фактом типа jsonb.
ORM-модели, восстановление процесса и сохранение данных будут проверяться
при реализации. В рамках этой правки изменено только описание проекта.
