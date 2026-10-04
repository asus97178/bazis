# Приёмочные испытания ORM

Дата: 2026-09-14. Основание: «делай» после перечисления условий промышленной приёмки.
Это проверочный контур существующей атомарной ORM и прикладного Users; нового
архитектурного модуля, драйвера, DI-регистраций и production-развёртывания нет.
Используются PostgresProvider, DbContext/Repository и настоящий UserService.

Целевые ОС, топология PostgreSQL, нагрузка/SLO запрошены. До ответа принят только
тестовый профиль: PostgreSQL 17.11, прямое TLS-подключение, Linux arm64 musl
в отдельном контейнере, pinned Bun 1.4.0 из cross-compiled executable. Перед SQL
проверяются версия/revision/platform/arch. Основной toolchain allowlist не меняется.
Тестовый Linux target не становится автоматически разрешённым runtime релиза.

Публичное поведение ORM сохраняется. В существующем host dbConfig объявляются
четыре уже поддержанных ORM-коннектором поля: operationTimeoutMs=30000,
cancellationTimeoutMs=5000, cancellationMode=server, maxPendingOperations=256.
Все обязательны в результате конфигурации, числа целые 1..2147483647,
mode server|close; JSON/env/CLI идут через существующий ConfigRegistry. Это делает
действующие defaults управляемыми без изменения их значений. Серверные timeout
и TLS CA не получают выдуманных production defaults.
JSON null существующий источник пропускает: он не переопределяет значение,
а при отсутствии других источников сохраняется default. Строка "null" в CLI/env
отклоняется; null в разрешённом представлении отсутствует. Схема kernel не меняется.

Контракт probe: команда fingerprint, matrix, business или soak; явный
OSNOVA_ORM_ENTERPRISE_LIVE=owned-disposable-v1, loopback URL с БД cancel_<run>,
публичный test CA. Soak duration — 30..3600 с, default 900; темп — 1..500 операций/с,
default 50; worker max=8, максимум 64 одновременно запущенных операций.
Измеритель использует фиксированные гистограммы, пишет JSON-окна каждые 10 секунд.
Метрики: p50/p95/p99/max, фактический темп, event-loop lag, RSS/heap, FD, сессии,
native pending/cancellations. Числовой бизнес-SLO не задан; измерения не объявляются SLA.

Критерии: ноль неожиданных ошибок/пропусков нагрузки/дубликатов, точная сверка
подтверждённых записей независимым клиентом, отсутствие строк отменённых/откаченных
операций, native pending=0 после drain, нет idle-in-transaction после drain,
соединения в рамках worker+control+observer. Память и FD сравниваются после warmup
и drain; отсутствие многосуточной утечки не выводится из 15 минут.
Технические пороги роста после warmup: RSS не более 64 MiB, JS heap после GC
не более 16 MiB. Они выявляют крупную регрессию этого стенда и не задают бюджет
памяти production. FD/RSS наблюдаются отдельно, percentile имеет шаг 1 мс.

Business drill теряет настоящий TLS-ответ COMMIT при создании пользователя:
UNKNOWN без afterCommit/afterRollback, без внутреннего retry; старый DbContext
запрещает save; новый контекст находит запись по уникальному нормализованному email;
повтор запроса с этим email не создаёт вторую запись. Этот ключ Users не объявляется
общей идемпотентностью всех API. API без устойчивого ключа требуют отдельного решения.

Ресурсы: только новые контейнеры с уникальной ownership label, loopback-публикация,
CPU/RAM/PID limits, без persistent volumes, синтетические случайные credentials,
временные TLS-ключи и executable; гарантированная cleanup. Существующие Docker
контейнеры/сети/VM-настройки не изменяются. Исходники/логи фиксируются SHA-256.

Дополнение 2026-09-19: режим autocommit проверяет root query/execute через withRetry.
TLS-ответ на INSERT теряется; независимый observer подтверждает запись до обрыва
сокетов. Критерий: UNKNOWN phase=commit, один dispatch и одна строка, без retry.
runner --autocommit-only запускает только этот сценарий на двух платформах.
Исторический overload в soak считает ожидания при inFlight=64, а не потерю строк;
критерий отсутствия этих ожиданий остаётся строгим, старый FAIL сохраняется.

PgBouncer/HA и окно PID reuse остаются отдельными границами. SQL-проверка identity
и pg_cancel_backend не выдаются за атомарный PID+secret CancelRequest.
Приёмка конкретного production-хоста требует его профиля и доступа; отсутствие
ответа пользователя не означает согласованный SLO или принятие остаточного риска.
