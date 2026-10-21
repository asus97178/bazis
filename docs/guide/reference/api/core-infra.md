# `bazis/core/infra`

Инфраструктура: манифест `@Infra` и коннекторы — PostgreSQL, Redis,
OpenSearch, LLM, Codex. Список — по пакету 0.111.2.

## Манифест

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Infra(manifest)` | Декоратор класса-манифеста: имя → коннектор | [Манифест](../../infra/overview.md#манифест) |
| `infraModule(manifest)` | То же без класса | там же |
| `InfraLifecycle` | Служба, которая открывает подключение при запуске и закрывает при остановке | [Порядок старта](../../infra/overview.md#порядок-старта-и-остановки) |
| `InfraError` | Ошибка настройки или подключения | [`InfraError`](../errors/startup.md#infraerror) |

## Коннекторы и клиенты

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `postgres(config, options)`, `IPostgres` | SQL-клиент Bun; внедряется по типу | [PostgreSQL](../../infra/connectors.md#postgresql-postgres) |
| `redisConnect(config, options)`, `IRedis` | Клиент Redis/Valkey; `cache: "distributed"` — общий кэш | [Redis](../../infra/connectors.md#redis-redisconnect) |
| `openSearchConnect(config, options)`, `IOpenSearch`, `OpenSearchClient` | Клиент OpenSearch | [OpenSearch](../../infra/connectors.md#opensearch-opensearchconnect) |
| `llmConnect(config, options)` | Одна модель OpenAI-совместимого API; регистрирует `AgentRuntime` | [`llmConnect`](../../ai/llm-connectors.md#одна-модель-llmconnect) |
| `llmRouter(profiles, options)`, `llmProfile`, `LlmModelRouter` | Несколько моделей по профилям, с запасной | [`llmRouter`](../../ai/llm-connectors.md#несколько-моделей-llmrouter) |
| `openAiCompatibleAdapter`, `OpenAiCompatibleModelProvider` | Адаптер OpenAI-совместимого API | [Свой адаптер](../../ai/llm-connectors.md#свой-адаптер) |
| `codexAppServerConnect(config)`, `ICodex`, `CODEX_MODEL_ID`, `CODEX_REASONING_EFFORT` | ChatGPT через Codex App Server; клиент внедряется по типу `ICodex` | [Codex](../../infra/connectors.md#codex) |
| `CodexError`, `RU_CODEX_MESSAGES` | Ошибки Codex с текстом для пользователя | [Ошибки агентов](../errors/agents.md#модели-и-codex) |
| `LlmModelRouterError`, `OpenAiCompatibleProviderError` | Ошибки LLM-коннекторов | [Ошибки](../../ai/llm-connectors.md#ошибки) |
| `DEFAULT_LLM_REQUEST_TIMEOUT_MS` | Срок запроса к провайдеру по умолчанию | — |

## Свой коннектор

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `reader(config)`, `requireValue`, `settingNames` | Чтение настроек коннектора и имена переменных для подсказки об ошибке | [Свой коннектор](../../infra/custom-connector.md) |
| `errorMessage(error)` | Текст ошибки, даже если брошено не `Error` | там же |
| `postgresConnectionOptions` | Общие параметры подключения PostgreSQL для SQL и ORM | — |
| `RedisDistributedCacheBackend`, `RedisDistributedCacheDriver` | Распределённый кэш поверх Redis | — |

## Типы

- **Манифест и коннекторы:** `InfraManifest`, `InfraConnector`,
  `ConnectionDescription`, `ConfigReader`.
- **PostgreSQL, Redis, OpenSearch:** `PostgresConfigShape`,
  `PostgresConnectorOptions`, `PostgresSslMode`, `RedisConfigShape`,
  `RedisConnectorOptions`, `RedisConnectorCacheMode`, `RedisCommandClient`,
  `RedisDistributedCacheTuning`, `OpenSearchConfigShape`,
  `OpenSearchConnectorOptions`, `OpenSearchClientOptions`.
- **LLM:** `LlmConfigShape`, `LlmConnectionOptions`, `LlmConnectorOptions`,
  `LlmModelProfile`, `LlmModelProfileOptions`, `LlmRouterOptions`,
  `LlmProviderAdapter`, `OpenAiCompatibleAdapterOptions`,
  `OpenAiCompatibleFetch`.
- **Codex:** `CodexClient`, `CodexConfigShape`, `CodexErrorCode`,
  `CodexLogin`, `CodexLoginMethod`, `CodexModel`, `CodexRunInput`,
  `CodexStatus`, `CodexChatMessage`, `CodexTool`, `CodexToolCall`,
  `CodexToolResult`.
