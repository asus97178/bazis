import { createToken, type InjectionToken } from "../../di";
import type { AppConfig, ConfigRegistry, Secret } from "../../kernel";
import { reader, requireValue } from "../connectorConfig";
import { InfraError, type InfraConnector } from "../InfraConnector";
import { redactSensitive, redactSensitiveText } from "../../../library/redaction";

/** Таймаут запроса к кластеру по умолчанию (мс) — fail-fast вместо зависания. */
const DEFAULT_OPENSEARCH_TIMEOUT_MS = 5000;
const DEFAULT_OPENSEARCH_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_PREVIEW_CHARS = 4096;

export interface OpenSearchClientOptions {
  /** Базовый URL кластера, напр. `https://localhost:9200`. */
  readonly url: string;
  /** Пользователь (basic auth), необязательно. */
  readonly username?: string;
  /** Пароль (basic auth), необязательно. Раскрытый секрет — не логируется. */
  readonly password?: string;
  /** Таймаут запроса в мс (по умолчанию 5000). Защищает старт от зависания. */
  readonly timeoutMs?: number;
  /** Максимальный размер response body. По умолчанию 1 MiB. */
  readonly maxResponseBytes?: number;
}

/**
 * Минимальный клиент OpenSearch поверх `fetch` — без внешних зависимостей.
 * Покрывает то, что обычно нужно приложению: ping/health, search, index.
 * REST-протокол OpenSearch совместим с этим набором операций.
 */
export class OpenSearchClient {
  private readonly lifetime = new AbortController();
  private readonly base: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(options: OpenSearchClientOptions) {
    this.base = normalizeBaseUrl(options.url);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENSEARCH_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_OPENSEARCH_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new InfraError("OpenSearch timeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new InfraError("OpenSearch maxResponseBytes must be a positive integer.");
    }
    // Заголовки постоянны на всё время жизни клиента — собираем один раз.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.username !== undefined || options.password !== undefined) {
      const raw = `${options.username ?? ""}:${options.password ?? ""}`;
      headers.authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
    this.headers = headers;
  }

  /** Низкоуровневый запрос к кластеру. Бросает {@link InfraError} на не-2xx. */
  public async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const label = `${safeMethod(method)} ${safePath(path)}`;
    let response: Response;
    try {
      this.lifetime.signal.throwIfAborted();
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch (error) {
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      throw new InfraError(`OpenSearch ${label} request failed: ${detail}`);
    }

    let text: string;
    try {
      text = await readBoundedText(response, this.maxResponseBytes, label);
    } catch (error) {
      if (error instanceof InfraError) {
        throw error;
      }
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      throw new InfraError(`OpenSearch ${label} response read failed: ${detail}`);
    }
    if (!response.ok) {
      const redacted = redactOpenSearchErrorText(text);
      const preview = redacted.length > MAX_ERROR_PREVIEW_CHARS
        ? `${redacted.slice(0, MAX_ERROR_PREVIEW_CHARS)}…`
        : redacted;
      throw new InfraError(
        `OpenSearch ${label} -> ${response.status}: ${preview}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new InfraError(`OpenSearch ${label} returned invalid JSON.`);
    }
  }

  /** Информация о кластере (`GET /`). */
  public info(): Promise<unknown> {
    return this.request("GET", "/");
  }

  /** Abort current requests, including response bodies, and reject subsequent calls. */
  public dispose(): void {
    this.lifetime.abort(new InfraError("OpenSearch client is disposed."));
  }

  /** Здоровье кластера (`GET /_cluster/health`). */
  public clusterHealth(signal?: AbortSignal): Promise<{ status: "green" | "yellow" | "red" }> {
    return this.request("GET", "/_cluster/health", undefined, signal);
  }

  /** Поиск по индексу. */
  public search<T = unknown>(index: string, body: unknown): Promise<T> {
    return this.request("POST", `/${indexSegment(index)}/_search`, body);
  }

  /** Индексация документа (с явным id — PUT, без — POST с авто-id). */
  public index<T = unknown>(index: string, document: unknown, id?: string): Promise<T> {
    return id === undefined
      ? this.request("POST", `/${indexSegment(index)}/_doc`, document)
      : this.request("PUT", `/${indexSegment(index)}/_doc/${documentIdSegment(id)}`, document);
  }

  /** Healthy only for explicitly accepted cluster states. */
  public async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const health = await this.clusterHealth(signal);
      return health?.status === "green" || health?.status === "yellow";
    } catch {
      return false;
    }
  }
}

/** Токен клиента OpenSearch для инъекции в сервисы приложения. */
export const OPENSEARCH: InjectionToken<OpenSearchClient> = createToken<OpenSearchClient>("OpenSearch");

/**
 * Интерфейс конфига, который требует коннектор OpenSearch. Конфиг подсистемы
 * поиска (`defineConfig<SearchConfig>("search", ...)`) должен предоставлять эти ключи.
 */
export interface OpenSearchConfigShape {
  /** Базовый URL кластера, напр. `https://localhost:9200`. */
  readonly url: string;
  readonly username: string;
  /** Пароль basic-auth — объявляется как `secret(...)`, читается как `Secret`. */
  readonly password: Secret;
}

export interface OpenSearchConnectorOptions {
  readonly token?: InjectionToken<OpenSearchClient>;
  /** Таймаут запроса в мс (по умолчанию 5000). */
  readonly timeoutMs?: number;
  /** Максимальный размер response body. По умолчанию 1 MiB. */
  readonly maxResponseBytes?: number;
}

function buildOpenSearchOptions<T extends OpenSearchConfigShape>(
  config: AppConfig<T>,
  options: OpenSearchConnectorOptions,
  configs?: ConfigRegistry,
): OpenSearchClientOptions {
  const c = reader(config, configs);
  return {
    url: requireValue(c.get("url"), "url", "opensearch"),
    username: c.get("username") as string,
    password: (c.get("password") as Secret).reveal(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
  };
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InfraError("OpenSearch url must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InfraError("OpenSearch url must use http or https.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new InfraError("OpenSearch url must not contain embedded credentials; use username/password config fields.");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new InfraError("OpenSearch url must not contain a query string or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function indexSegment(index: string): string {
  if (index.trim().length === 0) {
    throw new InfraError("OpenSearch index must be a non-empty string.");
  }
  return encodeURIComponent(index);
}

function documentIdSegment(id: string): string {
  if (id.trim().length === 0) {
    throw new InfraError("OpenSearch document id must be a non-empty string.");
  }
  return encodeURIComponent(id);
}

function safeMethod(method: string): string {
  const normalized = method.toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.length === 0 ? "REQUEST" : normalized;
}

function safePath(path: string): string {
  return redactSensitiveText(path.replace(/[\r\n\t]/g, " ").slice(0, 512));
}

function redactOpenSearchErrorText(text: string): string {
  try {
    return JSON.stringify(redactSensitive(JSON.parse(text)));
  } catch {
    return redactSensitiveText(text);
  }
}

async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new InfraError(`OpenSearch ${label} response exceeded ${maxBytes} bytes.`);
    }
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InfraError(`OpenSearch ${label} response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Коннектор OpenSearch для манифеста `@Infra`. Конфигурация берётся из
 * переданного `searchConfig` (`defineConfig("search", ...)`) — коннектор читает
 * объявленные ключи `url`/`username`/`password`. Клиент — fetch-обёртка, поэтому
 * «открытие соединения» — это ping кластера на старте (fail-fast, если кластер
 * недоступен). Закрытие отменяет активные запросы и запрещает новые.
 *
 * ```ts
 * export const searchConfig = defineConfig("search", {
 *   default: { url: "https://localhost:9200", username: "admin", password: secret("dev") },
 * });
 * @Infra({ search: openSearchConnect(searchConfig) })
 * export class AppInfra {}
 * // инъекция: constructor(private readonly search: OpenSearchClient) {}  // токен OPENSEARCH
 * ```
 */
export function openSearchConnect<T extends OpenSearchConfigShape>(
  config: AppConfig<T>,
  options: OpenSearchConnectorOptions = {},
): InfraConnector<OpenSearchClient> {
  return {
    token: options.token ?? OPENSEARCH,
    config,
    create(configs) {
      return new OpenSearchClient(buildOpenSearchOptions(config, options, configs));
    },
    async connect(client, signal) {
      const alive = await client.ping(signal);
      if (!alive) {
        throw new InfraError(`Infra connector "opensearch": cluster is not reachable or unhealthy.`);
      }
    },
    dispose(client) {
      client.dispose();
    },
    healthCheck(client, signal) {
      return client.ping(signal);
    },
  };
}
