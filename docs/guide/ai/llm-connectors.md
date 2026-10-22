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
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface LlmConfig { provider: string; model: string; baseUrl: string; apiKey: Secret }

export const llmConfig = defineConfig<LlmConfig>("llm", {
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

| Опция адаптера | По умолчанию | Что задаёт |
| --- | --- | --- |
| `chatCompletionsPath` | `/chat/completions` | Путь запроса к модели |
| `healthPath` | `/models` | Путь проверки здоровья |
| `healthCheck` | `true` | Проверять ли здоровье в `/health` |
| `extraHeaders` | — | Дополнительные заголовки, например для прокси |
| `maxResponseBytes` | 16 МиБ | Предел размера ответа |
| `fetch` | глобальный `fetch` | Своя функция запроса, например в тестах |

С одной моделью `modelProfile` агента ни на что не влияет.

## Что уходит провайдеру

Проверено на запросах, которые получил сервер:

| Что есть в запуске | Что в запросе |
| --- | --- |
| Инструменты агента | `tools`; точки в именах заменены: `orders.find` → `orders_find` |
| `onTextDelta` | `stream: true`: текст приходит по частям |
| `output` с JSON-схемой | `response_format: { type: "json_schema", json_schema: { name, strict, schema } }` |
| Ключ | `Authorization: Bearer <apiKey>` |

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
    "agent":"support","error":{"name":"OpenAiCompatibleProviderError",
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
| Провайдер ответил HTTP-ошибкой | `AGENT_PROVIDER_FAILED` | `OpenAI-compatible POST /chat/completions failed with HTTP 503.` |
| Не уложились в `timeoutMs` коннектора | `AGENT_PROVIDER_TIMEOUT` | `OpenAI-compatible request timed out.` |
| Не уложились в срок рантайма (`timeoutMs` в [настройках](agents.md#настройки-аудит-и-подтверждение), 60 с) | `AGENT_PROVIDER_TIMEOUT` | |
| Запуск отменён через `signal` | `AGENT_ABORTED` | — |

Каждый сбой, кроме отмены, пишется в журнал как `Agent model call failed`.
Тело ответа с ошибкой не читается и не попадает в журнал: провайдер может
повторить в нём запрос пользователя или ключ.

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
