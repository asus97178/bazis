import type { ModuleNaming } from "../naming";
import type { ModuleTemplateProfile } from "./module";

export function modulePassport(n: ModuleNaming, profile: ModuleTemplateProfile): string {
  const header = `# ${n.moduleClass}

Версия паспорта: 1.0. Тип: атомарный. Профиль CLI: ${profile}.
Статус: сгенерирован каркас; предметная реализация и проверки не завершены.
Точка подключения: [${n.entity}.module.ts](${n.entity}.module.ts), класс ${n.moduleClass} без аргументов.

До изменения прочитать AGENTS.md и docs/architecture/MODULE_ARCHITECTURE.md.
Область паспорта — файлы этого каркаса. Автор уточняет ответственность и поля
до реализации предметной функции и обновляет паспорт вместе с кодом.
`;
  if (profile === "empty") return `${header}
## Ответственность и состав

Предметная ответственность ещё не определена. Каркас предназначен для одной
самостоятельной функции; владелец данных и инвариантов определяется при реализации.
Состав: этот паспорт и ${n.entity}.module.ts. imports: []; exports: [].
Публичный TypeScript-вход — класс ${n.moduleClass}; фабрика и аргументы отсутствуют.
DI providers, ORM, HTTP, config, background, UI, AI и события не используются:
предметная реализация ещё не добавлена. Не создавать каталоги заранее.

## Входы, выходы и эффекты

Подключение класса через imports host-модуля. Входные поля отсутствуют.
Публичных операций, ошибок предметной области и внешних эффектов пока нет.
После добавления операции описать сигнатуру, каждый вход (тип, источник,
обязательность, null, default, валидация, пример), выход и ошибки.

## Проверки

Не запускались для нового модуля. Генерация файлов не подтверждает готовность
предметной функции; требуются проверка состава, codegen и применимые тесты.
`;

  const e = n.entity;
  return `${header}
## Ответственность и компоненты

Учебный CRUD ${e} с полями name/email. Это пример схемы, а не требования к
домену ${n.input}; заменить поля перед использованием в предметной функции.
Один модуль владеет entity, инвариантами сервиса и адаптерами доступа к ней.

| Компонент | Файл | Вход / зависимость | Выход / эффект |
| --- | --- | --- | --- |
| ${n.moduleClass} | [${e}.module.ts](${e}.module.ts) | imports host | ORM, DI, HTTP${profile === "full" ? ", background, AI" : ""} |
| ${e} | [model/${e}.model.ts](model/${e}.model.ts) | Поля ниже | Таблица ${n.route} |
| ${e}DbContext | [model/${e}DbContext.ts](model/${e}DbContext.ts) | Общий ORM provider host | DbSet ${n.collection} |
| I${e}Service / ${e}Service | [services/${e}.service.ts](services/${e}.service.ts), [token](services/I${e}.service.ts) | ${e}DbContext${profile === "full" ? ", ICache" : ""} | CRUD, count, summary |
| ${e}Controller | [http/${e}Controller.ts](http/${e}Controller.ts) | I${e}Service, HTTP request | HTTP-операции ниже |
| Create${e}Request / Update${e}Request | [requests](http/contracts/${e}Requests.ts) | JSON body | RequestModel + Validator |
| ${e}Response / ${e}Summary / to${e}Response | [responses](http/contracts/${e}Responses.ts) | ORM entity | Публичная проекция данных |
| ${e}ListQuery | [list](http/contracts/${e}ListQuery.ts) | Query string | ListQuery, фильтры/сортировка/страницы |
${profile === "full" ? `| ${e}StatsReporter | [background](background/${e}StatsReporter.ts) | ServiceProvider, Logger, AbortSignal | Запрос count и запись в лог |
| ${e}SummaryTool | [tool](ai/tools/${e}SummaryTool.ts) | I${e}Service, input, context | Сводка для агента |
| ${e}AnalystAgent | [agent](ai/agents/${e}AnalystAgent.ts) | Prepare${e}BriefRequest | ${e}BriefDocument через AgentRuntime |
| AI DTO | [contracts](ai/contracts/${e}Brief.ts) | topic, audience | title, bullets |
` : ""}

## Подключение, DI и данные

imports отсутствуют: функциональные зависимости каркаса предоставляет host.
exports: [I${e}Service]. TypeScript-контракт: services/I${e}.service.ts;
HTTP-доступ задаётся контроллером и политикой host отдельно от DI exports.
I${e}Service → ${e}Service, lifetime scoped. Контекст и DbSet принадлежат ORM.
${profile === "full" ? `${e}SummaryTool указан в tools: [${e}SummaryTool]; scoped-регистрацию создаёт фреймворк, Tool не экспортируется.
Сервис использует cachedScoped; ICache предоставляет cacheModule host.
Background получает отдельный scope на tick и закрывает его в finally.
Host также обеспечивает auth из src/app/modules/auth (TokenKind.Admin/Client),
AgentRuntime и modelProfile reasoning. CLI не создаёт эти зависимости.
` : ""}Зависимости конструкторов, включая ${e}DbContext, связывает codegen.
Ручные массивы deps не требуются. UI, события и собственная конфигурация не используются.

ORM: context ${e}DbContext, entities [${e}], общий provider host.
Таблица ${n.route}${profile === "full" ? `, схема ${n.dbSchema}` : ""}; entity участвует в миграциях.
Startup-флаги создания/обновления схемы не заданы. Host обеспечивает готовность
схемы до запросов. CLI и codegen базу данных не создают.

| Поле модели / ответа | Тип | null | Начальное значение / владелец |
| --- | --- | --- | --- |
| id | string UUID | нет | Пустая строка до сохранения; значение назначает ORM |
| name | string | нет | Пустая строка модели, при create приходит из body |
| email | string | нет | Пустая строка модели, при create из body; уникальный индекс БД |
| createdAt | Date / ISO string в JSON | нет | Date(0) до сохранения; createdAt ORM |
| updatedAt | Date / ISO string в JSON | нет | Date(0) до сохранения; updatedAt ORM |

## Публичные входы и поля

Префикс HTTP задаёт host; локальный маршрут /${n.route}.
${profile === "full" ? "Чтение: Admin или Client. Запись: Admin. Проверки выполняет HTTP Authorize.\n" : "Локальные Authorize-проверки отсутствуют; доступ определяет политика host.\n"}
| Операция HTTP / сервиса | Вход | Результат / эффект |
| --- | --- | --- |
| GET /${n.route}, контроллер list(query, ctx) → сервис getAll(query) | ListQuery | Сервис: PageResult<${e}Response> (items, total); контроллер: ListDocument<${e}Response>, HTTP 200 |
| GET /${n.route}/:id, getById(id) | id | ${e}Response или null; HTTP 200 / 404 |
| POST /${n.route}, create(body) | Create${e}Request | ${e}Response; HTTP 201, Location из текущего пути и id; INSERT |
| PUT /${n.route}/:id, update(id, body) | id, Update${e}Request | ${e}Response или null; HTTP 200 / 404; изменение только переданных полей |
| DELETE /${n.route}/:id, delete(id) | id | boolean; HTTP 204 / 404; физическое удаление |
| count() | Нет | Promise<number>; SELECT count |
| summary() | Нет | Promise<${e}Summary>: count — общее количество; names — до 20 имён, порядок по id; SELECT count и ограниченная проекция |

| Поле | Тип / источник | Обязательно | null | Default | Валидация | Пример |
| --- | --- | --- | --- | --- | --- | --- |
| id | string / route или DI аргумент | Для чтения/изменения/удаления одной записи | нет | нет | UUID в HTTP route; сервис сам не валидирует | 123e4567-e89b-42d3-a456-426614174000 |
| body.name | string / JSON body | create: да; update: нет | нет | нет; отсутствующее поле update не меняет запись | Validator, 2–100 символов | Example |
| body.email | string / JSON body | create: да; update: нет | нет | нет; отсутствующее поле update не меняет запись | Validator, email, 3–120 символов; уникальность БД | guest@example.com |
| ctx | HttpContext / сервер | Для create и list контроллера | нет | HTTP pipeline | Не из JSON, содержит фактический path; в сервис не передаётся | /v1/${n.route} |
| query | ListQuery / query string или DI аргумент getAll | Да | нет | ListRequest defaults | name: eq/contains/startsWith, email: eq/contains; сортировка name/email/createdAt; HTTP размер страницы 20, максимум 100 | page[size]=20&sort=name |

Контроллер задаёт basePath для JSON:API-ссылок из ctx.path. Сервис возвращает
только items и total, без ссылок и HTTP-формата. getAll читает без tracking,
выполняет count и SELECT с LIMIT/OFFSET. Прямой DI-вызов передаёт разобранный
ListQuery; общий ORM paginate ограничивает limit значением 1000.

Пример body create: {"name":"Example","email":"guest@example.com"}.
Пример body update: {"name":"Updated"}. Неизвестные поля не копируются сервисом
в entity; гидратация и обработка неизвестных полей следуют RequestModel host.
HTTP проверяет DTO. Прямые DI-вызовы должны передавать корректные значения:
сервис не повторяет Validator. Невалидный HTTP body получает 400; некорректный
UUID не соответствует route; отсутствующая запись — 404. Ошибки уникального
индекса и другие ошибки ORM передаются в общий error handler, отдельного
предметного перевода в 409 в каркасе нет.
Сохранение выполняет ${e}DbContext.saveChanges() для всех накопленных изменений
контекста, а не только текущего entity. IRepository.saveChanges() сохраняет ту же
область и остаётся совместимым API. Внешней транзакции, повторов и отдельного
протокола отмены у CRUD нет. Изменение данных и последующие эффекты не объединены
в общую транзакцию. Перед production автор определяет нужные инварианты.
${profile === "full" ? fullPassport(n) : ""}
## Проверки и граница готовности

Для нового модуля codegen, DI/HTTP/ORM и бизнес-сценарии ещё не квалифицированы.
Заполнить результаты после адаптации каркаса: PASS / FAIL / SKIP с командами.
Отдельно проверить ошибки входов, контракт exports, готовность схемы и
${profile === "full" ? "инвалидацию кэша, auth, background scope, AI metadata и " : ""}CRUD.
Наличие файлов не подтверждает работоспособность инфраструктуры host.
`;
}

function fullPassport(n: ModuleNaming): string {
  return `
## Cache, background и AI

GET list кэшируется на 30 секунд, с query и user в ключе. getById сервиса —
60 секунд, ключ ${n.route}:id. Общий тег ${n.route} сбрасывается через
ICache.evictByTag после успешного saveChanges в create/update/delete.
Кэш находится в памяти процесса; согласованность нескольких процессов требует
отдельного решения приложения.

Background: intervalMs 60000, runImmediately false. Каждый tick получает
AbortSignal от runtime, создаёт scope, вызывает count и пишет лог, если сигнал
ещё не отменён; dispose выполняется всегда. Сам SQL этим сигналом не отменяется.

Tool ${n.route}.summary: execute(input, context), sideEffect read.
Агент ${n.route}-analyst: prepareBrief(input), task prepare-${n.route}-brief;
modelProfile reasoning, maxSteps 3. Метод agentOutput — декларация для runtime.
Прямой вызов prepareBrief не запускает LLM.

| Поле AI-входа | Тип / источник | Обязательно | null | Default | Проверка | Пример |
| --- | --- | --- | --- | --- | --- | --- |
| topic | string / tool input или Prepare${n.entity}BriefRequest | Да | нет | нет | Validator required, minLength 3 | Сводка за день |
| audience | string / Prepare${n.entity}BriefRequest | Да по Validator | нет | операторы при создании DTO | Validator required, minLength 3 | операторы |
| context | AgentToolExecutionContext / runtime | Для tool | нет | runtime | agentName берётся из серверного контекста | agentName: ${n.route}-analyst |

Tool output: topic string, count number, names string[], agentName string
(пустая строка, если контекст не содержит имени). Agent output: title string,
bullets string[]. Валидацию и ошибки AI-входов обеспечивает AgentRuntime;
каркас не добавляет собственные проверки полномочий для прямого DI/tool вызова.
Host определяет допуск инструментов. Повторных попыток tool в каркасе нет.
`;
}
