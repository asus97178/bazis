# Kernel: lifecycle и исправления аудита

Версия паспорта: 1.6. Дата: 2026-10-04.
Статус: исправления аудита реализованы; проверки перечислены в разделе 6.
Изоляция конфигурации каждого kernel реализована; проверки и границы в §7,
входы зафиксированы в [контрактах config](config/README.md).
Тип: существующая атомарная инфраструктурная ответственность — жизненный цикл host.
Точка подключения: `KernelBuilder.build()` / `Osnv.run()`.
Область паспорта: K01–K08 из [аудита](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-2026-09-13.md)
и принятое решение о разделении объявления конфигурации и представления kernel.
Это частичный паспорт: полные контракты config sources, health, корреляции,
модульных подписчиков и ORM admission здесь не переопределяются.

### Повторные health-запросы

В одном `HealthService` для одной инстанции `HealthCheck` одновременно выполняется
не более одной операции. Конкурентные отчёты разделяют её результат, сохраняя
собственные deadline и отмену. Signal самой операции отменяется, когда уходят все
ожидающие отчёты. Если операция игнорирует отмену, последующие отчёты возвращают
unhealthy до её фактического завершения; повторного запуска и накопления работ нет.
После завершения следующий отчёт выполняет новую проверку. Позднее отклонение
Promise обработано. Check должен быть зарегистрирован singleton, как встроенные
Infra checks. Лимит `concurrency` остаётся лимитом одного отчёта; разные экземпляры
HealthService и разные проверки не получают общего глобального лимита.
Сигнатуры `HealthCheckOptions` и результата сохранены. Обоснование и приёмка:
[план](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/PLAN.md).

## 1. Ответственность и структура

Kernel запускает и останавливает зарегистрированные DI-службы, управляет
тайм-аутами, уведомлениями и завершением процесса. Деление на новые подмодули
не требуется. Существующая host-композиция в `KernelBuilder` сохраняется:
`OsnvKernelModule` импортирует `OsnvKernelInfraModule` и пользовательский root.
Данные предметных модулей, HTTP-авторизация и изменение схемы БД находятся вне области.

## 2. Компоненты

| Компонент | Файл | Изменяемый контракт |
| --- | --- | --- |
| Kernel | [Kernel.ts](Kernel.ts) | Общий startup deadline, отмена, общий `run`, ошибки очистки |
| LifecycleCoordinator | [LifecycleCoordinator.ts](LifecycleCoordinator.ts) | Фактическое завершение async hooks перед rollback; сохранение тайм-аута и ошибок очистки |
| ApplicationLifetime | [ApplicationLifetime.ts](ApplicationLifetime.ts) | Отмена ожидания started callbacks; пропуск оставшихся после отмены |
| EventBus | [events/EventBus.ts](events/EventBus.ts) | Опциональный signal для остановки dispatch |
| SupervisedHostedService | [SupervisedHostedService.ts](SupervisedHostedService.ts) | Передача signal, отмена повторов/backoff |
| KernelBuilder | [KernelBuilder.ts](KernelBuilder.ts) | Проверка тайм-аутов; разрешение объявлений для своего окружения до создания DI-клиентов |
| ConsoleLogger | [logging/ConsoleLogger.ts](logging/ConsoleLogger.ts) | Безопасное представление несериализуемых полей |
| Configuration | [config/Configuration.ts](config/Configuration.ts) | Копия входной Map |
| defineConfig / ConfigRegistry | [config/defineConfig.ts](config/defineConfig.ts), [config/ConfigRegistry.ts](config/ConfigRegistry.ts) | Неизменяемое объявление и отдельные представления kernel; контракт в §7 |

Внутренние утилиты отмены и диапазона таймеров не являются публичными TS-входами.
Проверки размещаются в `test/kernel.audit-regressions.test.ts` и `test/fixtures/`.

## 3. DI и публичные поверхности

TypeScript-вход: [index.ts](index.ts), alias `osnv/core/kernel`.
Публичных HTTP/AI-входов у описываемой области нет.
Kernel регистрирует инфраструктуру и разрешённые представления конфигурации:

| provide | Реализация | Зависимости | Lifetime / видимость |
| --- | --- | --- | --- |
| Environment | value из builder | kernel options / process env | singleton, global |
| Configuration | value из builder | config sources | singleton, global |
| ConfigRegistry | value из builder | объявления из графа, Environment, Configuration | singleton, global |
| `definition.token` | ConfigView из реестра | одно объявление и снимок источников kernel | singleton, global |
| ApplicationLifetime | value из builder | нет | singleton, global |
| LOGGER | выбранное value | пользовательский Logger либо ConsoleLogger | singleton, global |
| EventBus | существующая resolver factory | ServiceResolver текущего контейнера | singleton, global |
| HealthService | существующая resolver factory | ServiceResolver текущего контейнера | singleton, global |

У исторического `OsnvKernelInfraModule` поле `exports` отсутствует; его открытая
global-поверхность сохраняется. Реестр и представления регистрируются значениями;
обычные классовые зависимости связывает существующий codegen.
Явные зависимости диагностических фабрик относятся только
к синтетическим тестовым службам, а не к альтернативной привязке классов.

## 4. Данные и lifecycle

Собственные ORM-сущности, миграции, UI и AI не используются. С 2026-10-02 проверки
плана принадлежат соответствующей capability через `HostedService.planValidator`.
Kernel получает неизменяемый массив настоящих hosted-служб, вызывает каждый уникальный
validator один раз на версию плана и передаёт startup signal. `validate(services,
signal?)` возвращает void либо Promise<void>; исключение/отмена прерывает старт.
Поле optional, без default и без null. Реализации ORM автоматически предоставляют
свой stateless validator; Kernel не знает таблиц, ORM-фаз или видов AI-коннекторов.
Тип `HostedServicePlanValidator` опубликован DI рядом с HostedService, новых
DI-регистраций нет. Лёгкие Application и startHostedServices применяют ту же проверку.
Начальный план проверяется до onInit/start. Валидатор — чистая повторяемая проверка
конфигурации: retry может вызвать его снова для плана с уже запущенными службами.
Простой Kernel без валидаторов сохраняет обычный порядок.
Проверки: `lifecycle-plan.test.ts` и прежние ORM/Agent hosting регрессии.

SupervisedHostedService поддерживает службы с собственным planValidator и
вложенные supervised-оболочки. Общая подготовка DI сначала вызывает все factories
и сохраняет первые экземпляры, затем проверяет полный план настоящих служб до
onInit и любого start. Factory только конструирует объект; соединения и работа
принадлежат start. Повторная проверка и первый start используют тот же экземпляр.
Ошибка factory при подготовке прекращает запуск без повторов. Собственный
`planValidator` оболочки сохранён и делегирует общей подготовке; при раскрытии
оболочек он не подменяет валидаторы реальных служб.

Без policy.phase оболочка наследует фазу реальной службы после подготовки;
до неё getter возвращает 0 без вызова factory. Явный override сохраняется для
планов без validators. Если validator есть у любой службы плана, несовпадающий
override отклоняется до проверки и запуска: старый контракт validator читает
service.phase и должен видеть фактическую фазу. Реальные службы не изменяются.
Kernel сохраняет порядок регистрации внутри фазы; Application/helpers по-прежнему
используют порядок регистрации без сортировки фаз.

После ошибки start supervisor сначала успешно останавливает попытку, затем
применяет maxAttempts/backoff и вызывает factory снова. Общий координатор DI
сериализует замены, повторно проверяет полный текущий план и атомарно принимает
кандидата до его start; фаза root-позиции не может измениться. Проверка включает
новые validators кандидата и сохраняет реальные identity остальных служб.
Ошибка factory/admission, цикл, дублирование или отмена прекращают эту замену.
Повторное использование того же экземпляра после успешного stop разрешено;
готовность экземпляра к новому start принадлежит реализации службы. Ошибка stop
не скрывается: AggregateError содержит исходную ошибку start и cleanup, новая
попытка запрещена. Внешний stop сохраняет возможность очистить удержанный экземпляр.
Одновременные start/stop каждого вида разделяют свою операцию; start после
успешного stop создаёт новый запуск, после неудачного stop не допускается.

Прямой supervised.start использует тот же механизм с одноэлементным планом.
Уже отменённый signal не вызывает factory; отмена async validator не публикует
кандидата и не разрешает поздний start. Первая проверка до любых эффектов и
повторяемость validators — разные гарантии; неизвестные будущие retry-кандидаты
проверяются непосредственно перед их запуском. Проверки:
[supervised-plan.test.ts](test/supervised-plan.test.ts).

Отмена прекращает ожидание и запуск следующих
callbacks/handlers; произвольный уже выполняющийся пользовательский код нельзя
принудительно остановить. Его Promise наблюдается, чтобы поздний отказ не стал
unhandled rejection. Hosted services получают существующий `AbortSignal`.
Coordinator проверяет уже отменённый signal до разрешения плана, затем повторно
непосредственно перед `onInit`, `start` и `onBootstrap` внутри их microtask.
Отмена между планированием и исполнением поэтому не запускает callback.
Успешно завершившийся после отмены пользовательский `start`, который уже начал
работу и игнорирует signal, по-прежнему получает один `stop`.
Регрессии: [lifecycle-cancellation.test.ts](test/lifecycle-cancellation.test.ts).

Отмена уже начатого `onInit` или `onBootstrap` не запускает `onDestroy` параллельно
с ним. Coordinator сохраняет исходный Promise и сначала дожидается его фактического
завершения, затем в обратном порядке останавливает запущенные службы и очищает hooks.
Kernel освобождает контейнер после этой последовательности, поэтому незавершённый
hook сохраняет доступ к своим зависимостям. `shutdownTimeoutMs` ограничивает всё
ожидание rollback и освобождения контейнера одним бюджетом; 0 отключает предел.
Исчерпание бюджета даёт `ShutdownTimeoutError`, а не успешный `stop`/`run`. Позднее
завершение продолжает реальную очистку; повторный `stop` сохраняет исходный timeout.
Бесконечно зависший hook не считается очищенным: `Osnv.run` выполняет предусмотренный
принудительный выход. Произвольный Promise не прерывается принудительно.

Поздний отказ hook и ошибки `stop`/`onDestroy` собираются, остальные доступные шаги
очистки выполняются; startup и cleanup ошибки возвращаются через `AggregateError`
с исходной ошибкой старта в `cause`. Если срок уже истёк, последующий отказ cleanup
сообщается фиксированным `[osnv] startup.cleanup failed.` без содержимого ошибки.
Внутренние `waitForRollback`, `rollbackFailure`, `rollbackElapsedMs` связывают
Coordinator с Kernel, не регистрируют новые DI-сервисы. Подписчики `onStarted`
и EventBus сохраняют прежнее поведение; они не являются resource lifecycle hooks.

`RestartPolicy.onRetry` — диагностическое уведомление перед повтором, не управляющий
callback. Синхронное исключение, отклонение Promise/thenable и ошибка чтения `then`
не прекращают повтор и не заменяют исходную ошибку запуска. Promise наблюдается,
но не задерживает recovery. Сбой виден как `[osnv] supervised.onRetry failed.`;
исходная ошибка не сериализуется, сбой самого diagnostic sink изолирован.

Собранный Kernel хранит независимую копию уникальных `signals`. Повтор значения
в массиве не создаёт второй обработчик; изменение исходного массива после build
не меняет Kernel. Первая доставка сигнала запускает graceful shutdown; следующая
отдельная доставка во время остановки сохраняет немедленный `exit(130)`.
Проверки перечисленных случаев:
[kernel.repeat-audit-regressions.test.ts](test/kernel.repeat-audit-regressions.test.ts).

## 5. Изменяемые входы и результаты

Это доверенные внутрипроцессные TypeScript-вызовы. `null` не поддерживается,
приведения строк к числам нет; неизвестные поля options не используются.

| Вход / поле | Тип, источник | Обязательность / default | Проверка и результат |
| --- | --- | --- | --- |
| `KernelOptions.startupTimeoutMs` | number, builder options | нет; 30000 | Целое 0…2147483647 мс; 0 отключает deadline всего старта |
| `KernelOptions.shutdownTimeoutMs` | number, builder options | нет; 10000 | Тот же диапазон; 0 отключает deadline остановки |
| `KernelOptions.signals` | readonly NodeJS.Signals[], builder options | нет; SIGINT, SIGTERM | При build сохраняется snapshot уникальных значений; пустой массив отключает обработчики |
| `useStartupTimeout(timeoutMs)`, `useShutdownTimeout(timeoutMs)` | number, аргумент | обязателен | Та же проверка при build; invalid → KernelError до config/DI |
| `Kernel.start()` | входных полей нет | — | Promise<void>; общий для повторных вызовов; deadline включает уведомления |
| `Kernel.run()` | входных полей нет | — | Общий Promise<number> и один комплект process handlers |
| `Kernel.stop(request)` | объект, аргумент | default `{exitCode:0}` | Общая операция остановки |
| `request.exitCode` | number, код завершения | обязателен при явном request | Передаётся существующему runtime; контракт диапазона не меняется |
| `request.signal` | string, имя сигнала | нет | Передаётся stopping event и shutdown hooks |
| `ApplicationLifetime.notifyStarted(signal?)` | AbortSignal, внутренний вызов kernel | нет | Ожидание и оставшиеся callbacks отменяются; Promise<void> |
| `SupervisedHostedService.start(signal?)` | AbortSignal, HostedService-контракт | нет | Тот же signal передаётся inner; отмена запрещает следующий retry |
| `PublishOptions.signal` | AbortSignal, аргумент publish/publishScoped | нет | Отмена ожидания, без запуска оставшихся обработчиков; причина отмены отклоняет publish даже при isolate |
| `PublishOptions.handlerTimeoutMs` | number, аргумент | нет; без лимита | Существующий отдельный timeout handler; поля order/isolate/onError сохраняются |
| `Configuration(values)` | ReadonlyMap<string,string>, аргумент | обязателен | Собственный снимок; значения строковые, null не поддерживается |
| `ConfigDefinition.ensureValid(environment?)` | development / test / production | нет; process env | Проверка без изменения объявления; готовый ConfigView проверяет совпадение своего окружения |
| `ConsoleLogger.*(message, fields?)` | string и LogFields | message обязателен | Несериализуемые fields заменяются фиксированным маркером |

Пример отмены события: `await bus.publish(event, payload, { signal: controller.signal })`.
Event identity, payload T, формат логов и политика регистрации обработчиков остаются
существующими контрактами [EventBus](events/EventBus.ts) и [Logger](logging/Logger.ts).
RestartPolicy сохраняет `maxAttempts` (3), `backoffMs` (100), `maxBackoffMs` (5000),
`onRetry?`; default phase наследуется от службы, explicit phase проверяется как
описано выше. Отмена проверяется до фабрики и после неудачной попытки.

Ошибка старта сохраняется как основная, если очистка успешно завершилась в срок.
При завершившемся отказе очистки она остаётся в `AggregateError`/`cause` вместе
с ошибками освобождения; публичный `stop` не выдаёт такой rollback за успех.
Если очистка превысила deadline, наружу выходит `ShutdownTimeoutError` с исходной
ошибкой в `cause`, чтобы `Osnv.run()` выполнил предусмотренный принудительный выход.
Обычный отказ старта `Osnv.run()` выводит в stderr после существующего
`redactSensitive`: вложенные подробности форматируются явно без сворачивания
в `[Object ...]`. Маскирование секретов и предел глубины redaction сохраняются;
форматирование поддерживает BigInt и уже обезличенные циклические ссылки,
не вызывает пользовательский `inspect`. Код завершения остаётся 1.
Чтение объявления через `get()` и `ensureValid(environment)` не фиксирует
окружение и не изменяет будущие чтения. Host использует отдельный `resolve`,
а сервисы — представление из DI/ConfigRegistry своего kernel.

## 6. Исторические проверки исправлений K01–K08

| Проверка | Результат |
| --- | --- |
| Kernel, app/config, background, Infra | 121 PASS / 0 FAIL, 286 expect, 11 файлов |
| В том числе новые регрессии K01–K08 | 27 PASS / 0 FAIL |
| TypeScript kernel и его импортируемые зависимости | PASS, `tsc --noEmit -p tsconfig.kernel.json` |
| TypeScript всего `src` при исправлении K01–K08 | PASS, exit 0; промежуточные ошибки WebSocket сохранены в отчёте |

Проверенные команды и журналы фиксируются в
[отчёте об исправлениях](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-fixes-2026-09-14.md).
Физические PostgreSQL/контейнерные проверки неприменимы к этим изменениям.
Эти результаты относятся к исправлениям K01–K08 и не подтверждают реализацию §7.
Публичные конструкторные зависимости и генерируемые контракты при фиксации
архитектурного решения не менялись. Переходное состояние config описано ниже.

<a id="config-isolation-decision"></a>

## 7. Принятое решение: конфигурация каждого kernel

Основание: решение владельца от 2026-09-14 и
[MOD-ARCH-001 §5.4](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation).
Статус: реализовано; проверено в исходниках и собранном бинарнике.

Контракт реализации согласован с текущей доработкой Infra/config:
`Configuration` хранит снимок источников, `ConfigRegistry` — представления
по идентичности объявления. `ConfigRegistry.get(config)` возвращает один
типизированный `AppConfig<T>` текущего kernel. `defineConfig` возвращает
неизменяемый `ConfigDefinition<T>` с `resolve(environment?, configuration?)`
и DI-токеном `token`. Валидация объявления не меняет его состояния.
Прямые `get/has` объявления сохраняются для отдельных вызовов вне kernel,
читают текущее process env без общего кэша; сервисы получают `definition.token`
через существующий DI или используют `ConfigRegistry.get`.
Пользовательский `AppConfig.resolve(environment?, configuration?)` может
строить своё независимое представление;
старые объекты только с `ensureValid` остаются валидаторами, ответственность
за отсутствие изменяемого общего состояния в них принадлежит автору.

Источники задаются существующим `KernelBuilder.addConfigSource`, окружение —
`useEnvironment`. Полный контракт источников описан в [config/README.md](config/README.md).
`InfraConnector.create(configs?: ConfigRegistry)` получает владельца значений;
вызов без аргумента остаётся standalone-сценарием. JWT-конфигурация приложения
собирается фабрикой при разрешении TokenService через DI, а не при импорте файла.

Модуль владеет общим неизменяемым объявлением конфигурации. Kernel владеет
выбранным окружением, снимком разрешённых значений и кэшем. Одно объявление
должно поддерживать несколько kernel в одном процессе без ручного копирования
потребителем. Разрешение и проверка не меняют объявление или соседний kernel.

Ответственность остаётся внутри существующих `config/defineConfig.ts` и
`KernelBuilder`. Переход затрагивает сбор `@Module.config`, host-композицию
`runApp`, DI-потребителей и Infra-коннекторы: все они должны использовать
представление соответствующего kernel. Типизированное чтение, приоритеты
источников и `Secret` сохраняются; точные сигнатуры описаны выше.

Временный запрет повторного использования объявления снят. Регрессия K07
теперь проверяет успешную сборку двух kernel и независимое чтение их представлений.
Добавлены проверки сервисов, Infra, отложенных профилей LLM, JWT и составного
конфига защиты сессий. Реестр вызывает фабрику составного конфига один раз
для своего kernel; адаптер защиты сессий получает именно этот результат.

Результат профильного прогона: **225 PASS / 15 SKIP / 0 FAIL**, 653 expect,
30 файлов. Двенадцать новых проверок изоляции находятся в kernel, auth и session.
TypeScript затронутой области, codegen и бинарные проверки прошли.
Состояние общего TypeScript и состав SKIP перечислены в
[отчёте](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).
