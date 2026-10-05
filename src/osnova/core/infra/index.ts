// Слой инфраструктуры: декларативное подключение внешних систем (БД, кэш,
// поисковый движок, ...) через единый контракт `InfraConnector` и собирательный
// декоратор `@Infra`. Коннекторы опираются на встроенные в Bun клиенты
// (`SQL`, `RedisClient`) и `fetch` — ноль внешних зависимостей.

export { Infra, infraModule, type InfraManifest } from "./Infra";
export { InfraError, errorMessage, type InfraConnector } from "./InfraConnector";
export { InfraLifecycle } from "./InfraLifecycle";
export { reader, requireValue, type ConfigReader } from "./connectorConfig";
export { codexAppServerConnect, CODEX_APP_SERVER } from "./connectors/codex";
export { CodexError, RU_CODEX_MESSAGES, type CodexErrorCode, CODEX_MODEL_ID, CODEX_REASONING_EFFORT, type CodexClient, type CodexConfigShape, type CodexLogin, type CodexLoginMethod, type CodexModel, type CodexStatus, type CodexRunInput, type CodexChatMessage, type CodexTool, type CodexToolCall, type CodexToolResult } from "./connectors/codex/contracts";

export { postgres, POSTGRES, postgresConnectionOptions, type PostgresConfigShape, type PostgresSslMode, type PostgresConnectorOptions } from "./connectors/postgres";
export {
  redisConnect,
  REDIS,
  type RedisConfigShape,
  type RedisConnectorCacheMode,
  type RedisConnectorOptions,
} from "./connectors/redis";
export {
  RedisDistributedCacheBackend,
  RedisDistributedCacheDriver,
  type RedisCommandClient,
  type RedisDistributedCacheTuning,
} from "./cache";
export {
  openSearchConnect,
  OPENSEARCH,
  OpenSearchClient,
  type OpenSearchClientOptions,
  type OpenSearchConfigShape,
  type OpenSearchConnectorOptions,
} from "./connectors/opensearch";
export {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  llmConnect,
  type LlmConfigShape,
  type LlmConnectionOptions,
  type LlmConnectorOptions,
  type LlmProviderAdapter,
} from "./connectors/llm";
export {
  llmProfile,
  llmRouter,
  LlmModelRouter,
  LlmModelRouterError,
  type LlmModelProfile,
  type LlmModelProfileOptions,
  type LlmRouterOptions,
} from "./connectors/llmRouter";
export {
  openAiCompatibleAdapter,
  OpenAiCompatibleModelProvider,
  OpenAiCompatibleProviderError,
  type OpenAiCompatibleAdapterOptions,
  type OpenAiCompatibleFetch,
} from "./connectors/openaiCompatible";
