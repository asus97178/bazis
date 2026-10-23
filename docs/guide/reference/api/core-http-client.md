# `bazis/core/http-client`

HTTP-клиент для вызовов внешних сервисов, в стиле axios, поверх `fetch`.
Это `bazis/library/http-client` плюс подключение к DI с передачей
`x-request-id`. Список — по пакету 0.117.1.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `httpClientModule(config)` | Регистрация клиента в DI: общие настройки, именованные клиенты | [Подключение](../../http/http-client.md#подключение) |
| `HttpClient` | Клиент: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `request`, `create` | [Запросы](../../http/http-client.md#запросы) |
| `HttpClientFactory`, `HttpClientFactoryBuilder` | Именованные клиенты, как `IHttpClientFactory` в .NET | там же |
| `HttpClientError`, `HttpErrorCode` | Ошибка с кодом `ETIMEDOUT`, `ERR_BAD_STATUS`…, статусом и ответом | [Ошибки](../../http/http-client.md#ошибки) |
| `HttpClientConfigError` | Запрошен незарегистрированный именованный клиент | [Ошибки HTTP-клиента](../errors/http.md#httpclientconfigerror) |
| `InterceptorManager` | Перехватчики запросов и ответов | — |
| `basicAuthHeader(username, password)` | Значение заголовка `Authorization: Basic …` | — |
| `appendQuery`, `defaultParamsSerializer`, `resolveUrl`, `isBodyInit` | Сборка адреса и тела | — |
| `shouldPropagateCorrelation` | Можно ли отправлять `x-request-id` на этот адрес | [Correlation id и секреты](../../http/http-client.md#correlation-id-и-секреты) |
| `InspectableRedirectProtocol` | Протокол проверяемых перенаправлений между сервисами bazis | — |

Типы: `RequestConfig`, `ResolvedRequestConfig`, `HttpResponse`,
`HttpMethod`, `ResponseType`, `RequestParams`, `ParamValue`,
`ParamPrimitive`, `HeaderBag`, `BasicAuth`, `RetryOptions`,
`RequestTransform`, `ResponseTransform`, `FulfilledFn`, `RejectedFn`,
`ProgressEvent`, `ProgressListener`, `CorrelationPropagation`,
`HttpClientModuleConfig`.

> [!WARNING]
> Опции — с написанием bazis, а не axios: `baseUrl`, `timeoutMs`,
> `maxResponseBytes`. Неизвестная опция с 0.100.8 — ошибка с подсказкой.
