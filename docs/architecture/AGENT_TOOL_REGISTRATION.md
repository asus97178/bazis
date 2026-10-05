# Регистрация Tools и назначение агентам

Идентификатор: **AGENT-TOOLS-001**. Версия: **1.0**. Дата: **2026-10-02**.
Статус: реализовано; изолированные проверки и бинарная проба — PASS.
Область: native Tools из кода Osnova и назначение метаагентам через каталог.

## 1. Размещение и регистрация

Общий атомарный [ToolsModule](../../src/app/modules/agents/tools/MODULE.md)
расположен внутри существующей области агентов. Один инструмент — класс с
методом execute. Он может пользоваться публичными сервисами нескольких модулей.
Метаагенты остаются определениями в БД, инструмент не копируется для каждого агента.

```text
src/app/modules/agents/
  Agents.module.ts                  определения метаагентов, ORM, запуск и Admin UI
  services/
    Agents.service.ts
    Run.service.ts
  tools/
    Tools.module.ts                единый список зарегистрированных Tools
    Tools.service.ts               административный каталог
    Tools.controller.ts            защищённые HTTP-входы
    Tools.initializer.ts           проверка схем при старте
    Agents.tool.ts                 agents.getAll
    contracts/
      Agents.input.ts              входной DTO инструмента
      Tools.contracts.ts           поля каталога
    index.ts
    MODULE.md
    test/
```

Действующая регистрация:

```ts
import { Module, singleton } from "@osnova/core/di";
import { AuthModule } from "../../auth/Auth.module";
import { AgentsModule } from "../Agents.module";
import { AgentsTool } from "./Agents.tool";
import { ToolsController } from "./Tools.controller";
import { ToolsInitializer } from "./Tools.initializer";
import { ToolsService } from "./Tools.service";

@Module({
  imports: [AgentsModule, AuthModule],
  tools: [AgentsTool],
  providers: [singleton(ToolsService)],
  controllers: [ToolsController],
  background: [ToolsInitializer],
  exports: [],
})
export class ToolsModule {}
```

Новый инструмент добавляется в `tools` один раз. Его зависимости объявляются
в конструкторе; необходимые предметные модули подключаются через imports и
публичные DI exports. ToolsModule подключён к AppModule.

`tools` автоматически регистрирует класс как scoped. Прежняя точная регистрация
`scoped(ToolClass)` того же владельца остаётся совместимой и переиспользуется.
Несовместимый lifetime/factory/key, повторное имя и конфликт владельцев приводят
к ошибке сборки контейнера до создания Tool. Дополнительного декоратора регистрации,
второго DI-контейнера, defineTools и RunAppOptions.tools не вводится.

## 2. Общий каталог и зависимости

[AgentRegistry.fromContainer](../../src/osnova/core/agent/AgentRegistry.ts)
строит неизменяемый снимок из фактических вкладов Tools в DI. Каталог кэшируется
на контейнер; обычные providers без tools в него не попадают. Конструкторы
инструментов не вызываются. Разные контейнеры имеют независимые каталоги.
Горячего поиска исходников или исполнения кода из БД нет.

ToolsModule импортирует AgentsModule для публичного IAgentsService. AgentsModule
использует каталог ядра, поэтому обратного импорта ToolsModule и цикла DI нет.
Общая папка не делает каждый инструмент отдельным модулем и не превращает
AgentsModule в пустой составной корень. Его публичные IAgentsService/RunService,
таблица agents и существующие HTTP-входы сохраняются.

## 3. Объявление и контракты Tool

[AgentsTool](../../src/app/modules/agents/tools/Agents.tool.ts) объявляет имя,
описание, входной DTO, sideEffect, approval и timeout через существующий @Tool.
[AgentsToolInput](../../src/app/modules/agents/tools/contracts/Agents.input.ts)
содержит page: целое 1–10000, default 1. Штатный codegen получает JSON Schema
из класса и его валидаторов. Объявленный output DTO необязателен.
Если input/output объявлен, но generated schema отсутствует, ToolsInitializer
останавливает startup до HTTP. Та же проверка выполняется при prepare запуска.
Ограничения существующего resolver вложенных generated refs не расширялись.

Tool использует IAgentsService и доверенный clientUserId из контекста хоста.
Выход: до 20 включённых агентов с id, name и description до 240 символов,
номер страницы и hasMore. Инструкции и настройки модели не выдаются.
Исполнение по-прежнему проходит через AgentToolExecutor: проверка назначения,
входа, прав/policies, approval, hooks, timeout/abort, output и освобождение scope.
Назначение Tool не отменяет предметные проверки и не изолирует native код в sandbox.

## 4. Каталог и назначение

[ToolsService](../../src/app/modules/agents/tools/Tools.service.ts) предоставляет:

| Операция | HTTP | Вход | Результат |
| --- | --- | --- | --- |
| getAll(query?) | GET /api/agent-tools | search до 120 символов; page 1–10000; size 1–100; defaults "", 1, 20 | items, page, size, total |
| getById(name) | GET /api/agent-tools/:name | имя длиной 1–128 | описание и inputSchema/outputSchema; DI null или HTTP 404 при отсутствии |

Все HTTP-входы требуют Admin; ответы 200 и 404 возвращают no-store. Числовые query-параметры
преобразует HTTP binder, границы проверяет сервис также для прямого DI-вызова.
null запрещён; неверный ввод — 400. Поиск без учёта регистра по имени и описанию,
порядок по имени. Элемент списка содержит name, description, tags, sideEffect,
approval, timeoutMs; исполняемые классы и зависимости наружу не выходят.
Схемы выдаются только в детальном ответе; null означает необъявленный контракт.

В форме агента widget `agent-tools` показывает постраничный каталог с описаниями,
поиском и выбором до 128 инструментов. Назначенные имена отображаются отдельно;
смена страницы, поиск и ошибка загрузки не очищают выбор. Сохраняется прежнее
поле Agent.toolNames, новая таблица или миграция не нужны.

[AgentsService](../../src/app/modules/agents/services/Agents.service.ts) проверяет
все новые назначения по общему каталогу до записи. При update под row lock сначала
проверяется revision, затем новые имена. Историческое отсутствующее имя можно
сохранить или удалить; новое неизвестное имя отклоняется с issue toolNames.
Main при старте не перезаписывается. Уже подготовленный запуск сохраняет свой снимок.

## 5. Как инструменты получает модель

[RunService](../../src/app/modules/agents/services/Run.service.ts) берёт toolNames
из определения, разрешает их через общий каталог и создаёт AgentRegistry.fromDefinition
только с назначенным набором. Ручного списка hostTools в сервисе больше нет.
Неизвестное назначение или недоступная объявленная схема дают 409 до pending-хода
и обращения к модели. Попытка модели вызвать неназначенный инструмент отклоняется.

Обычный OpenAI-compatible адаптер передаёт описания через поле tools в API-запросе.
Модель возвращает имя и аргументы; наш executor выполняет вызов и возвращает
результат через тот же адаптер. Codex получает dynamicTools с безопасными wire-именами
и вызывает тот же executor. DTO, DI, идентичность и секреты остаются у Osnova.
Транспортные адаптеры и настройки strict этим изменением не менялись.

Контракт остаётся стандартным: параметры описываются JSON Schema, обмен с моделью —
function/tool calling провайдера. Выходную схему Osnova можно объявить дополнительно.
Обзоры протокола: [OpenAI](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
Интеграция Anthropic, MCP и поиск инструментов моделью в этот модуль не добавляются.

## 6. Проверка и поставка

Команда создания CLI и подробные поля закреплены в
[паспорте ToolsModule](../../src/app/modules/agents/tools/MODULE.md).
Статические импорты и штатный codegen поддерживают исходники и бинарную сборку.
Каталог собирается один раз; сортировка O(N log N), поиск O(N), выдача ограничена size.
Дополнительных запросов к БД для чтения каталога нет; замеры ускорения не заявлены.

Проверены регистрация и владение, scoped identity, независимость каталогов,
Admin/no-store и query binding, схемы, назначения и исторические ссылки,
фильтрация набора модели, обычный и Codex-запуск, CLI/codegen, TypeScript,
Admin build и бинарная проба. БД и внешний LLM для этих проверок заменяются
управляемыми портами; живые PostgreSQL и провайдер в этой задаче не запускались.
Результат: 471 тест без ошибок, TypeScript/Admin build и сборка app/CLI — PASS.
Браузерная проверка формы и запуск бинарной пробы вне checkout — PASS.
Команды и границы — в [отчёте](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agent-tools-module-2026-10-02.md).
