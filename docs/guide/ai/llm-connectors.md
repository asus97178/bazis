# LLM-коннекторы

Модель подключается так же, как база данных или Redis: коннектором в
`@Infra`. Коннектор читает конфигурацию, создаёт клиента модели, проверяет
его здоровье и регистрирует [`AgentRuntime`](agents.md) — его можно
получать по типу в любом сервисе.

Все примеры проверены на bazis 0.111.1. Вместо настоящего провайдера в
проверках — локальный сервер с API в формате OpenAI: так результаты не
зависят от сети и ключей.

## Конфигурация

```ts
// infra/llm.config.ts
import { defineConfig, secret } from "bazis/core/kernel";

export const llmConfig = defineConfig("llm", {
  default: { provider: "openai", model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1", apiKey: secret("dev-key") },
  production: { apiKey: secret() },
});
```

| Ключ | Что задаёт | Из окружения |
| --- | --- | --- |
| `provider` | Метка для вашего адаптера; `openAiCompatibleAdapter` её не читает | `BAZIS_LLM__PROVIDER` |
| `model` | Имя модели у провайдера | `BAZIS_LLM__MODEL` |
| `baseUrl` | Адрес API, без `/chat/completions` | `BAZIS_LLM__BASEURL` |
| `apiKey` | Ключ: уходит в `Authorization: Bearer …` | `BAZIS_LLM__APIKEY` |

Ключ — секрет: в журнал он не попадает. Значение по умолчанию годится для
разработки и тестов, а в production ключ обязателен — без
`BAZIS_LLM__APIKEY` приложение не запустится:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
llm.apiKey — required non-empty secret is not set (BAZIS_LLM__APIKEY).
```

Подробнее — в главе [Секреты](../security/secrets.md).

## Одна модель: `llmConnect`

```ts
// infra/App.infra.ts
import { Infra, llmConnect, openAiCompatibleAdapter } from "bazis/core/infra";
import { llmConfig } from "./llm.config";

@Infra({
  llm: llmConnect(llmConfig, openAiCompatibleAdapter(), { timeoutMs: 30_000 }),
})
export class AppInfra {}
```

`openAiCompatibleAdapter` работает с любым API в формате OpenAI Chat
Completions. `timeoutMs` — срок одного запроса к модели, по умолчанию
60 секунд, `0` — без срока.
`contextTokens` — окно контекста модели в токенах (`128_000` для модели на
128 тысяч): зная его, рантайм заранее
[сжимает длинный диалог](agents.md#длинный-диалог-сжатие).

| Опция адаптера | По умолчанию | Что задаёт |
| --- | --- | --- |
| `chatCompletionsPath` | `/chat/completions` | Путь запроса к модели |
| `healthPath` | `/models` | Путь проверки здоровья |
| `healthCheck` | `true` | Проверять ли здоровье в `/health` |
| `extraHeaders` | — | Дополнительные заголовки, например для прокси |
| `maxResponseBytes` | 16 МиБ | Предел размера ответа |
| `fetch` | глобальный `fetch` | Своя функция запроса, например в тестах |

С одной моделью `modelProfile` агента ни на что не влияет.

## Claude: `anthropicAdapter`

Для моделей Claude есть свой адаптер. Он работает через официальный SDK,
поэтому живёт в отдельном входе `bazis/core/infra/anthropic`, а пакет SDK
приложение ставит само:

```bash
bun add @anthropic-ai/sdk
```

```ts
// infra/llm.config.ts
export const llmConfig = defineConfig("llm", {
  default: { provider: "anthropic", model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", apiKey: secret("") },
});

// infra/App.infra.ts
import { Infra, llmConnect } from "bazis/core/infra";
import { anthropicAdapter } from "bazis/core/infra/anthropic";

@Infra({ llm: llmConnect(llmConfig, anthropicAdapter({ effort: "medium" })) })
export class AppInfra {}
```

| Опция адаптера | По умолчанию | Что задаёт |
| --- | --- | --- |
| `effort` | умолчание модели | Насколько тщательно модель работает: `low`, `medium`, `high`, `xhigh`, `max` |
| `thinking` | `true` | Адаптивные рассуждения: модель сама решает, когда и сколько думать. `false` не передаёт настройку — для модели, которая её не принимает |
| `thinkingDisplay` | умолчание модели | `"summarized"` возвращает краткое изложение рассуждений в тексте частей `reasoning`; иначе на текущих моделях текст пуст |
| `cache` | `true` | Кэш промпта: `true` — на пять минут, `"1h"` — на час, `false` — выключен |
| `maxOutputTokens` | 32 000 | `max_tokens` запроса, если запуск не задал `maxOutputTokens` |
| `healthCheck` | `true` | Проверять ли провайдера в `/health` |
| `client` | — | Готовый клиент SDK вместо созданного по конфигурации: клиент облачной платформы или подставной в тестах |

Что адаптер делает сам:

- **Кэш промпта.** Инструкции, описания инструментов и уже пройденный диалог
  на следующем шаге читаются из кэша провайдера — в разы дешевле. В
  `result.usage` это видно: `cacheReadTokens` и `cacheWriteTokens`.
  Кэш работает, пока начало запроса не меняется, поэтому не подставляйте
  в инструкции агента время или номер запроса.
- **Рассуждения.** Блоки рассуждений модели остаются в диалоге частями
  `reasoning` и возвращаются провайдеру без изменений вместе с вызовом
  инструмента, к которому привели. `usage.reasoningTokens` — сколько
  токенов ответа ушло на них.
- **Окно модели.** При старте адаптер спрашивает у провайдера модель из
  конфигурации: неверный ключ или имя модели останавливают запуск, а окно
  контекста становится известно без `contextTokens`, и
  [сжатие диалога](agents.md#длинный-диалог-сжатие) начинается заранее.
- **Изображения и файлы.** `agentImage` уходит как изображение (по адресу
  или `data:`-строкой: JPEG, PNG, GIF, WebP), `agentFile` — как документ
  (PDF или текст).
- **Структурированный ответ** запрашивается по JSON-схеме. Правила, которые
  API не принимает (`minLength`, `minimum` и другие), SDK превращает в
  подсказку модели, а проверяет их рантайм.

Чего адаптер не передаёт: `temperature` (текущие модели Claude её
отвергают) и повторы самого SDK — запрос повторяет
[рантайм](agents.md#что-рантайм-исправляет-сам). Если модель отказалась
отвечать по соображениям безопасности, запуск завершается с
`AGENT_PROVIDER_STOPPED` (`finishReason: "content-filter"`), а категория
отказа — в `responses[].metadata.refusal`.

Текст ошибки API адаптер не повторяет: в нём может быть часть запроса. В
журнале остаются код ответа, тип ошибки и номер запроса, по которому его
можно найти в консоли провайдера:

```text
error: Agent model call failed {"code":"AGENT_PROVIDER_FAILED","error":{"name":"AnthropicProviderError",
  "message":"Anthropic request failed with HTTP 401 (authentication_error), request req_011…"}}
```

## Что уходит провайдеру

Проверено на запросах, которые получил сервер:

| Что есть в запуске | Что в запросе |
| --- | --- |
| Инструменты агента | `tools`; точки в именах заменены: `orders.find` → `orders_find` |
| `onTextDelta` | `stream: true`: текст приходит по частям |
| `output` с JSON-схемой | `response_format: { type: "json_schema", json_schema: { name, strict, schema } }` |
| Ключ | `Authorization: Bearer <apiKey>` |
| `agentImage` в сообщении пользователя | часть `image_url`; файл `data:`-строкой — часть `file` |

Вызовы инструментов разбираются и в потоковом ответе, и в обычном.

## Здоровье

Коннектор добавляет в `/health` проверку `infra:llm` — запрос к
`healthPath`:

```json
{"healthy":true,"checks":[{"name":"infra:llm","healthy":true,"durationMs":0.42}]}
```

Если провайдер не отдаёт `/models`, отключите проверку
(`healthCheck: false`) или укажите другой путь.

## Проверка при старте

При запуске коннектор один раз запрашивает `GET /models` (не дольше пяти
секунд). Неверный ключ или адрес останавливает запуск, а не первый
запрос к агенту:

```text
[bazis] application failed: InfraError: Infra connector "llm": https://api.openai.com/v1 is not available —
  OpenAI-compatible GET /models failed with HTTP 401.
```

| Среда | Проверяется? |
| --- | --- |
| `development`, `production` | Да |
| `test` | Нет: в тесте модель заменяют, а настоящий провайдер не нужен |

В среде `test` к провайдеру не ходит и `/health`: проверка `infra:llm`
отвечает «здоров». `llmConnect(…, { checkOnStart: false })` выключает
только проверку при старте — `/health` в разработке и production
по-прежнему спрашивает провайдера. `checkOnStart: true` включает оба
обращения и в тестах.

> [!NOTE]
> Проверка при старте — с версии 0.100.0, без проверки в среде `test` —
> с 0.100.5, `/health` без провайдера в среде `test` — с 0.100.6. Раньше
> тест, запускающий приложение с `llmConnect`, обращался к настоящему
> провайдеру.

## Несколько моделей: `llmRouter`

Разным агентам нужны разные модели: быстрая и дешёвая для простых
вопросов, сильная для сложных. `llmRouter` описывает их профилями:

```ts
import { Infra, llmProfile, llmRouter, openAiCompatibleAdapter } from "bazis/core/infra";

@Infra({
  llm: llmRouter({
    fast: llmProfile(llmConfig, openAiCompatibleAdapter(), { model: "gpt-4.1-mini", temperature: 0.1, maxOutputTokens: 500 }),
    reasoning: llmProfile(llmConfig, openAiCompatibleAdapter(), { model: "gpt-4.1", maxOutputTokens: 4000, fallback: "fast", timeoutMs: 20_000 }),
  }, { defaultProfile: "fast" }),
})
export class AppInfra {}
```

> [!NOTE]
> До 0.111.1 приложение с `llmRouter` и модулем `ormBazis` с `ensureCreated`
> не запускалось: `infra:llm (phase -100) is not a framework connector`.

Агент выбирает профиль полем `modelProfile`; без него — `defaultProfile`:

```text
агент без modelProfile          → model "gpt-4.1-mini", temperature 0.1, max_tokens 500
агент с modelProfile "reasoning" → model "gpt-4.1",      max_tokens 4000
```

| Опция профиля | Что задаёт |
| --- | --- |
| `model` | Модель профиля вместо `model` из конфигурации |
| `temperature`, `maxOutputTokens` | Параметры запроса |
| `timeoutMs` | Срок запроса этого профиля |
| `contextTokens` | Окно контекста модели в токенах: по нему рантайм заранее [сжимает длинный диалог](agents.md#длинный-диалог-сжатие) |
| `fallback` | Профиль, который ответит, если этот не смог |

У каждого профиля может быть своя конфигурация — другой провайдер, адрес и
ключ: `llmProfile(otherConfig, …)`.

Если профилей несколько, `defaultProfile` обязателен — или профиль с
именем `default`. Неизвестный `fallback` и циклы `fallback` останавливают
запуск одной строкой:

```text
[bazis] configuration error: llmRouter profile "fast" fallback "smart" is not registered.
```

Сам вызов `llmRouter(...)` не бросает исключение (с версии 0.113.0):
ошибку сообщает сборка приложения.

### Неизвестный профиль

Профиль проверяется вместе с определением агента — в
[`check`](agents.md#агенты-в-базе) и перед запуском:

```text
check({ name: "support", modelProfile: "creative" })
→ AgentSetupError: Agent "support": model profile "creative" is not configured (configured: fast, reasoning).
```

### Запасная модель

Если профиль ответил ошибкой или не уложился в `timeoutMs`, запрос уходит
профилю из `fallback`. Агент получает ответ, а в журнале остаётся
предупреждение:

```text
reasoning отвечает HTTP 503:
→ ответ от fast
→ warn: LLM model profile failed, using fallback {"profile":"reasoning","fallback":"fast",
    "agent":"support","error":{"name":"AgentModelUnavailableError",
    "message":"OpenAI-compatible POST /chat/completions failed with HTTP 503."}}

reasoning не ответил за 1 с (timeoutMs: 1000):
→ ответ от fast через 1,0 с
→ warn: … "error":{"name":"AgentModelTimeoutError","message":"OpenAI-compatible request timed out."}
```

Запасная модель не подключается, если основная уже начала выдавать текст
и оборвалась: иначе пользователь увидел бы начало одного ответа и
продолжение другого. Запуск завершится ошибкой:

```text
reasoning прислал «Начинаю отв» и оборвался
→ status: failed, AGENT_PROVIDER_FAILED; deltas: ["Начинаю отв"]
```

> [!NOTE]
> Предупреждение о запасной модели и проверка профиля — с версии 0.99.5.
> Раньше сломанная основная модель была не видна, а неизвестный профиль
> обнаруживался только при запуске.

## Ошибки

| Что случилось | Код запуска | В журнале |
| --- | --- | --- |
| Провайдер занят (HTTP 408, 409, 425, 429, 5xx) или оборвалось соединение — и после [повторов](agents.md#что-рантайм-исправляет-сам) тоже | `AGENT_PROVIDER_FAILED` | `OpenAI-compatible POST /chat/completions failed with HTTP 503.` |
| Провайдер отказал: другой HTTP-код (400, 401, 404) — без повторов | `AGENT_PROVIDER_FAILED` | `OpenAI-compatible POST /chat/completions failed with HTTP 401.` |
| Запрос длиннее окна модели (HTTP 400, 413 или 422 с текстом о длине контекста) — и после [сжатия](agents.md#длинный-диалог-сжатие) тоже | `AGENT_CONTEXT_OVERFLOW` | `… failed with HTTP 400. The request does not fit the model's context window.` |
| Не уложились в `timeoutMs` коннектора | `AGENT_PROVIDER_TIMEOUT` | `OpenAI-compatible request timed out.` |
| Не уложились в срок рантайма (`timeoutMs` в [настройках](agents.md#настройки-аудит-и-подтверждение), 60 с) | `AGENT_PROVIDER_TIMEOUT` | |
| Запуск отменён через `signal` | `AGENT_ABORTED` | — |

Каждый сбой, кроме отмены, пишется в журнал как `Agent model call failed`.
Тело ответа с ошибкой не попадает ни в журнал, ни в текст ошибки: провайдер
может повторить в нём запрос пользователя или ключ. Адаптер только
определяет по нему, не отказ ли это из-за длины запроса.

## Свой адаптер

Для API не в формате OpenAI напишите адаптер: он получает конфигурацию и
создаёт клиента, который умеет `complete`:

```ts
import type { LlmProviderAdapter } from "bazis/core/infra";
import { AgentModelTimeoutError, agentMessage, agentModelResponse, type AgentModelProvider } from "bazis/core/agent";

export const echoAdapter: LlmProviderAdapter = {
  create(connection): AgentModelProvider {
    return {
      async complete(request, context) {
        const last = request.messages.at(-1)?.content[0];
        const prompt = last?.kind === "text" ? last.text : "";
        const response = await fetch(`${connection.baseUrl}/generate`, {
          method: "POST",
          headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: connection.model, prompt }),
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(connection.timeoutMs ?? 60_000)]),
        }).catch((error) => {
          if ((error as Error).name === "TimeoutError") throw new AgentModelTimeoutError("echo model timed out");
          throw error;
        });
        const body = await response.json() as { text: string };
        return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", body.text) });
      },
    };
  },
  healthCheck: async () => (await fetch("https://models.internal/health")).ok,
};
```

```ts
@Infra({ llm: llmConnect(llmConfig, echoAdapter, { timeoutMs: 10_000 }) })
export class AppInfra {}
```

| Часть адаптера | Что делает |
| --- | --- |
| `create(connection)` | Создаёт клиента; `connection` — `provider`, `model`, `baseUrl`, `apiKey`, `timeoutMs` |
| `connect`, `dispose` | Необязательно: открыть и закрыть соединение при старте и остановке |
| `healthCheck` | Необязательно: проверка для `/health` (`infra:llm`) |

Передавайте `context.signal` в запросы — тогда отмена запуска и срок
рантайма прерывают запрос. Свой срок сообщайте ошибкой
`AgentModelTimeoutError`: запуск получит код `AGENT_PROVIDER_TIMEOUT`.

Если провайдер не может ответить сейчас — перегружен, ограничивает частоту,
оборвалось соединение, — бросайте `AgentModelUnavailableError`: такой запрос
рантайм [повторит](agents.md#что-рантайм-исправляет-сам). Пауза, которую
просит провайдер, передаётся в `retryAfterMs`. Любую другую ошибку рантайм
не повторяет.

```ts
if (response.status === 429 || response.status >= 500) {
  throw new AgentModelUnavailableError(`echo model: HTTP ${response.status}`, { retryAfterMs: 2_000 });
}
```

Если запрос не помещается в окно модели, бросайте
`AgentModelContextOverflowError` — рантайм сожмёт диалог и повторит шаг.
Окно модели сообщает необязательный метод `contextTokens(modelProfile?)`.
Сообщайте в `usage.inputTokens` весь размер запроса, вместе с токенами из
кэша: по нему рантайм уточняет свою оценку токенов.

Аргументы инструмента, которые модель написала битым JSON, — не сбой
провайдера. Вместо исключения верните вызов с причиной:
`agentToolCall({ id, name, inputError: "Unexpected end of JSON input" })`.
Инструмент не будет вызван, а модель получит ошибку
`TOOL_ARGUMENTS_INVALID` и напишет вызов заново.

```text
модель не ответила за timeoutMs: 200
→ status: failed, AGENT_PROVIDER_TIMEOUT
→ error: Agent model call failed {"code":"AGENT_PROVIDER_TIMEOUT","error":{"name":"AgentModelTimeoutError",…}}

healthCheck вернул false
→ GET /health → 503 {"healthy":false,"checks":[{"name":"infra:llm","healthy":false}]}
```

## Дальше

- [Агенты](agents.md)
- [Инструменты](tools.md)
- [Health checks](../fundamentals/health-checks.md)
- [Конфигурация](../fundamentals/configuration.md)
