# WebSocket

Версия паспорта: 1.4. Дата: 2026-10-04. Статус: межузловая доставка реализована; квалификация — в отчёте ниже.
Тип: атомарный технический модуль. Путь: `src/osnv/core/websocket`.
Подключение: [websocketModule(config)](websocketModule.ts).
Область паспорта: исправления аудита, replay и надёжная межузловая доставка. Полные существующие
поля конфигурации находятся в исходных контрактах.

## Контракт межузловой доставки

Сохраняется существующий атомарный технический модуль. Компоненты находятся
внутри него, CLI-каркас нового модуля не требуется. Redis adapter использует
отдельный delivery store и ограничитель native операций; WebSocketServer выполняет
доставку из общего store и предоставляет диагностику и readiness. ORM, DI-порты и владение
host RedisClient сохраняются. Состояние очереди отделяется от revision сессии,
чтобы публикация на другом узле не конфликтовала с lease/ACK владельца.

| Новый вход | Контракт / default | Проверки и эффект |
| --- | --- | --- |
| `socket.to(room).emitReliable(event, data, options)` | Promise receipt; room и event обязательны, data JSON-совместимое или undefined | Доступ определяет gateway, namespace/excludeSid берутся с сервера. Требует capability адаптера и client-ack у получателей |
| `options.messageId` | Обязательный UUID v4, null запрещён | Один ID на логическую публикацию; неизменный при повторе после неопределённого результата |
| `options.expiresAt` | Обязательное Unix ms, safe integer | Deadline принятия операции, максимум 60 секунд вперёд по часам store; повтор сохраняет исходное значение |
| Receipt | messageId, recipients, duplicate | Успех означает запись всем зафиксированным адресатам, не ACK клиента; очередь хранится до ACK/session TTL |
| `adapter.reliableRooms` | Optional capability | Atomic global room fan-out, bounded reads и ACK с проверкой owner/connId; старые адаптеры сохраняют legacy режим |
| `onDiagnostic` | Optional sync callback, без payload/секретов | События отказа/переполнения/конфликта и счётчики; исключение наблюдателя изолируется |
| `limits.reliablePollIntervalMs` | Positive ms; 1000 | Polling дополняет pub/sub; пакетные чтения ограничены по числу сессий и байтам |
| Redis `operationTimeoutMs`, `maxPendingOperations` | Positive integers; 2000 ms, 64 | Timeout не выдаётся за отмену native I/O; незавершённые операции продолжают занимать bounded slots |
| Redis `deliveryClient` | Optional host-owned Bun RedisClient; default общий command client | Разделяет командные соединения доставки и session I/O. Initialize проверяет общий logical store nonce-пробой до записи policy. Оба клиента принадлежат host; общий native admission limit сохраняется. Сам по себе отдельный клиент не гарантирует пропускную способность |
| Redis reliable limits | maxQueueMessages=100, maxQueueBytes=1MiB, maxRecipients=1000, maxFanoutBytes=8MiB, maxOperations=10000, maxReadBytes=1MiB | Жёсткие границы, отказ вместо вытеснения неподтверждённых данных; единая политика у узлов одного prefix |
| Redis `reliable.requireAof` | boolean; true, null запрещён | При старте/readiness проверяет appendonly=yes, appendfsync=always, no-appendfsync-on-rewrite=no, noeviction и статус AOF. false снимает проверку durability; сохранность после аварии хранилища в этом режиме не гарантируется |

Существующий emit остаётся transport API, но отклонение offline queue становится
явной ошибкой и диагностическим событием. Для новой надёжной операции admission
ошибки проверяются до fan-out; транспортный timeout означает неопределённый
результат, повтор безопасен только с исходным messageId/expiresAt.
Один Redis primary/replication group — атомарная граница. Redis Cluster с
распределением ключей по shards не входит в этот контракт. Проверки: cross-node offline, потеря notification, отказ/рестарт Valkey с AOF,
сетевой разрыв, rolling replacement, бинарный запуск и измеренный нагрузочный
профиль. Фактические PASS/FAIL и ограничения приведены в отчёте квалификации.

## 1. Ответственность и компоненты

Приоритеты MOD-ARCH-001 §2.1: одна техническая функция, существующие DI/порты;
отдельные классы для доставки и native I/O имеют самостоятельные обязанности
внутри атомарного модуля. Heartbeat и массовый shutdown используют до 16
параллельных операций; mailbox читаются партиями до 128 владельцев с лимитом
байтов ответа. Исполненный бинарник использует тот же публичный runtime.
Пустые результаты READ пропускаются до локального поиска сессии: idle polling
не запускает полный expiry sweep для каждого пустого mailbox. Для непустого
результата проверки текущего connId, lease и backpressure сохраняются.
Компромисс: синхронная AOF-запись увеличивает задержку ради сохранности принятой
очереди; Lua нужен для атомарного fan-out без нового ORM или брокера.

Модуль владеет WebSocket на общем HTTP listener: upgrade, gateways, пакеты,
комнаты, сессии, replay и lifecycle. Использует существующие DI, HTTP-порт
и интерфейс адаптера. Прикладная авторизация и эксплуатация хранилища принадлежат
приложению. Новые модули, ORM, миграции и второй пул БД не создаются.
Redis-адаптер — дополнительная реализация существующего порта.

| Компонент | Ответственность |
| --- | --- |
| [WebSocketServer](ws-server.ts) | Deadlines, согласование replay, ACK и ownership, native drain, bounded close |
| [SessionManager](session-manager.ts) | Локальный индекс сессий/комнат, ограниченная очередь, delivery IDs, упорядоченные записи с CAS |
| [Dispatcher](ws-dispatch.ts) | Один ответ handler выбранным кодеком, deferred ACK и отмена |
| [Socket wrapper](socket-wrapper.ts) | Публичный OsnvSocket, результат send, состояние физического соединения |
| [In-memory adapter](adapter/in-memory.adapter.ts) | Отдельные лимиты живых сессий и истории удалений, защита от старых snapshots |
| [Creation token](session-creation.ts) | Внутренний process-local порядок создания для компактизации истории |
| [Redis adapter](adapter/redis.adapter.ts) | Межузловой live pub/sub и атомарное хранение сессий на существующем Bun RedisClient |
| [Reliable delivery store](adapter/redis-delivery-store.ts) | Порт глобальных mailbox, idempotency, политика durability, canonical hash из существующего library/boundary |
| [Redis operations](adapter/redis-operations.ts) | Ограничивает native I/O и ожидание; timed-out операция продолжает занимать слот до реального завершения |
| [Lua scripts](adapter/redis-delivery-scripts.ts) | Атомарное обновление membership, admission, mailbox и ACK |
| [Types](types.ts), [codecs](codec/packet-codec.interface.ts) | Аддитивное расширение wire v1; одинаковая семантика JSON и binary |

## 2. DI и публичные границы

Фабрика регистрирует gateways как singleton; зависимости конструктора связывает
существующий codegen. Resolver-фабрика singleton `WEBSOCKET_UPGRADE` собирает
их через WebSocketExplorer. `WebSocketModule` глобален, явно экспортирует
`[WEBSOCKET_UPGRADE]`. Направление зависимости — WebSocket → HTTP; HTTP обращается
к порту upgrade. TypeScript-вход: [index.ts](index.ts), `osnv/core/websocket`.
Новые TypeScript-экспорты: `ReplayDelivery`, `ReplayAcknowledgement`,
`RedisWebSocketAdapter` и его options, `ReliableBroadcastOptions/Receipt`,
`ReliableRoomDelivery/Publication`, `ReliableSessionOwner/DeliveryBatch`,
`WebSocketDeliveryError`, `WebSocketDiagnostic`, `RedisReliableDeliveryOptions`.
Новых DI-экспортов нет.

Адаптер конструируется вручную runtime или потребителем. WebSocket входит
в `FRAMEWORK_INTERNAL_PREFIXES` генератора. Регистрации gateways и зависимости
не менялись; codegen не требуется, generated-файлы этим исправлением не затронуты.
Опубликованные входы — существующие upgrade-маршруты и WebSocket-пакеты;
новых HTTP/AI endpoint нет.

## 3. Входные контракты

Поля ниже необязательны, кроме явно указанных; null не поддерживается.

| Вход | Тип, default | Проверка и поведение |
| --- | --- | --- |
| Config `replayDelivery` / query `replay` | `transport` или `client-ack`; default `transport` | Неизвестное/повторное query — HTTP 400. Config `client-ack` требует этот режим; downgrade — 409 |
| `ClientPacket.type` | Обязательно: `event`, `ping`, `reconnect`, новый `replay-ack` | Wire v1, namespace, payload, correlation id и ingress/control rate limits сохраняются |
| `replay-ack.data.deliveryIds` | Обязательный непустой `string[]` | Не более `maxOutboundQueuePerSession`, UUID v4, каждый ID выдан этому физическому соединению; иначе error без изменения очереди |
| `replay-ack.id` | Optional correlation string | После сохранения ACK: `{type:"ack", id, data:{acknowledged:number}}`; повтор недавно принятого ID на том же соединении даёт 0; remote ACK history ограничена maxOutboundQueuePerSession |
| `ServerPacket.deliveryId` | UUID queued packet | Стабильный ID client-ack replay, отдельный от correlation id |
| `connected/reconnected.replayDelivery` | `client-ack` при согласованном режиме | Клиент проверяет режим перед подтверждением |
| `reconnected.replayCount` | Число пакетов текущей партии replay | Включает missed и последующие frames этой партии; оставшиеся global mailbox пакеты доставляются polling |
| `SessionState.creationToken` | Optional immutable string | Runtime выдаёт process incarnation + монотонный номер; legacy-граница описана ниже |
| `SessionState.replayDelivery` | Optional mode; legacy `transport` | Сохранённый client-ack не может быть понижен следующим reconnect |
| `limits.maxBackpressureBytes` | Positive number bytes; 1 MiB | Native outgoing buffer; replay ждёт drain, переполнение закрывает получателя |
| `limits.socketCloseTimeoutMs` | Positive number ms; 1000 | После runtime close принудительно завершает socket, если peer не закончил close handshake |
| `limits.handshakeTimeoutMs` | Nonnegative ms; 10000 | Общий upgrade deadline с I/O; отдельный open/replay deadline; 0 отключает |
| `limits.messageHandlingTimeoutMs` | Nonnegative ms; 30000 | Включает validation и deferred callback; 0 отключает |
| `codec` | PacketCodec; JSON | Один codec для ACK, emit, replay и broadcast; binary framing сохраняется |

Дополнения SessionManager: пятый optional аргумент `replayDelivery` у
`createSession`; `enableReplayAcknowledgements(sid): void`;
`acknowledgeDeliveries(sid, deliveryIds): number`. Это внутренние транспортные
операции. Доступ к SID, namespace, principal и владельцу проверяет сервер.

Миграция legacy queue присваивает IDs после claim; если они превысят byte limit,
переход отклоняется без потери очереди. `acknowledgeDeliveries` снимает только
названные IDs, предварительная проверка их выдачи обязательна.
`peekOutbound` не меняет очередь. `acknowledgeOutbound(sid, count)` снимает только
transport-префикс, без await между send и снятием; count=0 ничего не меняет.
Некорректный count и положительный count для client-ack вызывают Error.
`drainOutbound` тоже не может снять неподтверждённую client-ack очередь.

## 4. Replay, очередь и lifecycle

Входящие сообщения ждут open и `handleConnection`. Отмена прекращает ожидание
и подавляет поздние эффекты, но не откатывает начатый I/O произвольного адаптера.
Ответы об изменении состояния отправляются после `flushSession`.
Активность физического соединения объединяется в периодические сохранения:
не чаще одной записи на треть меньшего из session TTL и active lease. Между ними
обновляется только локальный lastSeenAt; expiresAt/activeLeaseExpiresAt не
продлеваются без записи. Истёкший lease по-прежнему отклоняет кадр. Изменения
комнат, явный SessionManager.updateContext, очереди и ownership сохраняются через
прежний CAS. Это не вводит автоматического сохранения произвольных socket.data mutations.
Фоновая renewal распределяется детерминированным SID offset внутри безопасного
TTL/lease окна. Runtime проверяет due сессии короткими тиками, а не сохраняет все
сессии одной волной. Предел 16 native workers и CAS-порядок каждого SID сохраняются.
Внутренний optional schedule у renewOwnedLeases задаёт неотрицательные safe integers
afterMs/spreadMs; вызов без schedule сохраняет прежнюю немедленную renewal.

Replay учитывает фактический размер закодированного кадра: помещающийся префикс
идёт в `reconnected.missed`, остальные пакеты — по порядку отдельными кадрами.
При backpressure сервер ждёт drain и продолжает на следующем event-loop turn
после native callback. Deadline ограничивает ожидание, runtime close handshake
ограничен `socketCloseTimeoutMs`.

- `transport` сохраняет совместимость: снимается принятый транспортом префикс.
  Это не доказательство получения клиентом.
- `client-ack` хранит весь replay до клиентского подтверждения. Обрыв без ACK
  повторяет те же IDs; частичный ACK допускает любой порядок. Клиент подтверждает
  после обработки и дедуплицирует по deliveryId. Группы ACK ограничены payload
  и control rate limit. Пример — [DESIGN.md](DESIGN.md).

Reliable queue отклоняет новые пакеты при лимите числа/байтов, сохраняя старые.
`enqueueOutbound` возвращает false. Внутренний offline fan-out возвращает
`truncated`; runtime использует его строгий allOrNothing режим и выдаёт
`OFFLINE_QUEUE_CAPACITY` до live публикации. Прежний необязательный режим
SessionManager и transport enqueue сохраняют совместимость с вытеснением.
Отказ больше не теряется за успешным ответом handler.
Обычные сохранения используют CAS при наличии этой операции. Конфликт вызывает
ошибку flush и удаляет устаревший локальный индекс, сохраняя нового владельца.
Client-ack требует адаптер с CAS, иначе HTTP 503.

Гарантия ограничена принятыми в очередь сообщениями, session TTL и хранилищем.
Переживание падения процесса относится к уже сохранённой очереди:
`enqueueOutbound=true` до завершения `flushSession` ещё не доказывает запись.
Live emit/broadcast сам по себе не получает эту гарантию. Exactly-once внешнего
побочного эффекта не обещается. Прикладная дедупликация принадлежит приложению.

Handler ACK отличается от replay ACK: третий аргумент handler и результат
undefined означают deferred до callback/отмены. Непустой return или отсутствие
третьего аргумента дают automatic ACK. Вместе callback и return порождают
максимум один ответ; без packet.id dispatcher не ожидает callback.

## 5. Адаптеры и данные

### In-memory

Single-node, без сохранения после рестарта. Options — положительные целые:

| Option | Default | Назначение |
| --- | --- | --- |
| `maxEntries` | 10000; runtime передаёт maxSessions | Только живые записи |
| `maxTombstones` | maxEntries | Независимый предел истории удалений |
| `tombstoneTtlMs` | 60000 ms | Legacy initial-write window и срок хранения маркеров |

SID не переиспользуется, createdAt и creationToken неизменяемы. Удалённый SID
не восстанавливает даже snapshot большей revision. Старые маркеры сворачиваются
в границу поколений, не занимая живую ёмкость; новые runtime-сессии имеют больший
номер, включая создание в ту же миллисекунду. Обновления имеющихся записей
разрешены независимо от этой границы. Close также сохраняет границу против
поздних записей после очистки.

Компактизация консервативна: отложенная первая запись, созданная до границы,
может быть отвергнута. Для legacy/импортированных snapshots без локального token
действуют граница createdAt и initial-write window; точное различение таких
сессий одной миллисекунды не обещается. Runtime не импортирует их как новые SID.
Заполнение живой ёмкости даёт SessionCapacityError и close 1013; история отдельно
ограничена и не блокирует новые поколения.

### Redis / Valkey

`new RedisWebSocketAdapter(client, options)` использует native Bun RedisClient
существующей инфраструктуры. Host создаёт/настраивает и закрывает командный
клиент и необязательный deliveryClient. Адаптер владеет только duplicate для pub/sub;
close снимает подписку и закрывает duplicate, не очищает ключи и не закрывает оба
host client. Отдельный deliveryClient должен обращаться к той же logical DB;
initialize проверяет это временным ключом connection-check с nonce и TTL.

| Option | Default | Ограничение |
| --- | --- | --- |
| `keyPrefix` | osnv:ws | 1–64 ASCII буквы/цифры/`:_-`; общий для узлов одного приложения, отдельный для других |
| `writeProtectionMs` | 60000 ms | Положительное безопасное целое; защита первой записи/удаления |
| `maxSessionBytes` | 8 MiB | Положительное безопасное целое; сериализованная сессия |
| `maxPublishBytes` | 1 MiB | Положительное безопасное целое; pub/sub packet |

Один ключ на SID; revision/CAS и запись атомарны в одной Lua-команде. Первая
запись требует revision 1 и допустимый createdAt по часам Redis. Record живёт
до большего из expiresAt и конца creation window; удаление защищено до конца
этого окна. Session JSON хранится непрозрачной строкой, сохраняя массивы/null.
После истечения lease допустим новый владелец; CAS блокирует старого писателя.
Pub/Sub исключает дубль на узле отправителя; local fan-out использует codec
принимающего runtime.

`emitReliable` использует общий индекс room → SID и отдельную LIST-очередь для
каждого SID. CAS-сохранение сессии атомарно обновляет membership и TTL очереди;
публикация/ACK очереди не меняют revision сессии. Получатели включают живые и
offline сессии любого узла в этом prefix/namespace. Удаление сессии удаляет
mailbox, истечение session TTL завершает гарантию хранения.

Lua publication проверяет все capacity условия до добавления пакетов; receipt
фиксирует число адресатов. Операция с теми же ID/deadline/данными повторяется без
второго fan-out, несовпадение даёт MESSAGE_ID_CONFLICT. Порядок JSON-полей не
меняет fingerprint. Используется существующий canonicalJsonHashV1 и его лимиты
структуры JSON. История операций ограничена maxOperations и acceptance deadline.
Pub/Sub только ускоряет доставку; polling извлекает её при потере notification.
Выданные этому соединению неподтверждённые ID исключаются из следующих чтений,
чтобы не занимать бюджет ответа других получателей. READ/ACK проверяют owner,
connId и действующий lease; после reconnect снова выдаются те же ID.

При старте и readiness strict режим требует AOF always/noeviction,
no-appendfsync-on-rewrite=no (fsync не пропускается при compaction) и здоровый
статус записи. Все узлы prefix обязаны иметь одну delivery policy. Host RedisClient
должен разрешать CONFIG GET и INFO persistence, но приложению CONFIG SET не нужен.
Изменение policy требует отдельного prefix либо управляемой миграции после drain;
нельзя удалять policy при наличии сессий. Старый Redis без AOF больше не проходит
strict initialize: явное reliable.requireAof=false снимает проверку durability,
сохранность после аварии хранилища в этом режиме не гарантируется.
Полный перечень ключей, ACL, ошибок и порядок эксплуатации — в runbook отчёта.

## 6. Проверки и граница готовности

Актуальные команды, PASS/FAIL, профиль нагрузки, хеши и эксплуатационные границы:
[квалификация enterprise WebSocket](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-enterprise/REPORT.md).
Проверки используют закреплённый Bun 1.4.0; toolchain не менялся. Production и
прикладная БД не изменялись. Отклонений от
[MOD-ARCH-001](../../../../docs/architecture/MODULE_ARCHITECTURE.md) нет.

Исторические проверки: [надёжность replay](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-reliability/REPORT.md)
и [семь исправлений аудита](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-fixes/REPORT.md).
Они не заменяют квалификацию текущего состояния файлов.

## Прикладная авторизация через DI и отдельный выходной лимит (2026-09-20)

Аддитивные входы существующего модуля:

| Вход | Default / проверка | Поведение |
| --- | --- | --- |
| config.middlewareFactory | отсутствует; функция обязана вернуть WsMiddleware | Resolver текущего kernel связывает upgrade-policy с DI; middleware выполняется после стандартных origin/auth и перед gateway middleware |
| Gateway.maxOutboundPayloadBytes | maxPayloadBytes; положительное конечное число | Отдельный предел ACK, emit, broadcast и replay; входные frame и native ingress по-прежнему ограничены maxPayloadBytes |

Не отменяет requireAuth/CORS и не меняет прежние defaults. Cookie-политика, проверка
Origin, отзыв сессий и scopes принадлежат приложению. Реализация middlewareFactory
не должна сохранять scoped-сервисы в singleton. При отсутствии фабрики прежняя
композиция идентична. Неверный результат фабрики отклоняется до запуска listener.
Проверки: `test/ws.chat-transport.test.ts`, существующие unit/e2e; реальная сборка
AgentChat в бинарник и вызов через общий HTTP/WebSocket listener.

## Учёт незавершённой работы и остановка (2026-10-04)

В существующем WebSocketServer исправлен R6 повторного аудита. Публичные
сигнатуры, DI и настройки не менялись. `maxConcurrentHandshakes` ограничивает
реально незавершённые upgrade-операции, включая authenticator, middleware и
session I/O. `maxConcurrentMessageHandlers` аналогично ограничивает валидацию
и обработчики сообщений. Тайм-аут быстро возвращает HTTP 504 либо закрывает
соединение, но слот возвращается только после завершения исходной операции,
включая позднюю ошибку. До этого новые операции получают прежний отказ busy.
Накопления очереди в обход лимита нет. Лимит upgrade не распространяется на
`handleConnection` после upgrade; его жизненный цикл отслеживается отдельно.

`close()` возвращает одну общую операцию для всех вызовов. Она запрещает
новые запросы, подаёт отмену и принудительно закрывает физические соединения.
`handleDisconnect` ждёт текущую работу своего соединения. Закрытие gateway
и адаптера выполняется после фактического завершения callbacks и сохранений.
Если `shutdownDrainTimeoutMs` истёк, close отклоняется с ошибкой timeout;
повторный вызов сохраняет этот результат. Упорядоченная очистка продолжает
ожидать исходные операции, а затем освобождает ресурсы ровно один раз.
При 0 общий deadline отключён. Сбой каждого этапа очистки наблюдается;
ошибки gateway не отменяют последующее закрытие адаптера.

Компромисс: постоянно зависший пользовательский код удерживает свой слот и
ресурсы до завершения процесса; быстрый timeout не выдаётся за физическую
отмену. При остановке вызывающий host обязан обработать ошибку close и не
объявлять успешное завершение прикладных эффектов. HTTP owner уже ловит её,
закрывает listener и возвращает ошибку своей остановки. Откат внешних действий
и принудительное завершение произвольного Promise не обещаются.

Регрессии: [ws.unit.test.ts](test/ws.unit.test.ts) проверяет занятые слоты после
timeout, поздние success/error, отсутствие поздних ACK, порядок handler →
disconnect → gateway → adapter и повторный close. [ws.audit-regressions.test.ts](test/ws.audit-regressions.test.ts)
проверяет тот же предел для незавершённого session load. Эти проверки используют
подставной транспорт. [ws.e2e.test.ts](test/ws.e2e.test.ts) дополнительно проверяет
реальный loopback HTTP/WebSocket: ошибка остановки по deadline, отказ нового
TCP-подключения к закрытому listener и завершение gateway после обработчика.
Redis и нагрузочная квалификация этим изменением не подтверждены.
Новых зависимостей, ресурсов или dynamic imports нет; проверки собранной
регрессионной fixture описаны в
[отчёте об исправлениях](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-reaudit-2026-10-04/FIXES.md).
