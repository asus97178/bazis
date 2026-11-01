# HTTP-клиент

`HttpClientBase` — клиент для запросов к другим сервисам. Его API повторяет
Axios: `get`, `post`, `baseUrl`, `params`, перехватчики, ответ в `data`.
Поверх `fetch` он добавляет тайм-аут, повторы, предел размера ответа и
защиту секретов при запросах на чужой адрес. Работает и на сервере, и в
браузере.

В приложении клиента к внешнему сервису объявляют как контроллер: класс с
декоратором `@HttpClient` и поле модуля `httpClients`.

Все примеры проверены на bazis 0.129.0.

## Подключение

Адрес сервиса и тайм-аут — в настройках:

```ts
// weather/config/Weather.config.ts
import { defineConfig } from "bazis/core/kernel";

export interface WeatherConfig {
  baseUrl: string;
  timeoutMs: number;
}

export const weatherConfig = defineConfig<WeatherConfig>("weather", {
  default: { baseUrl: "https://weather.example.com", timeoutMs: 2000 },
});
```

Клиент — класс-наследник `HttpClientBase` с декоратором:

```ts
// weather/clients/WeatherClient.ts
import { HttpClient, HttpClientBase } from "bazis/core/http-client";

@HttpClient({ config: weatherConfig })
export class WeatherClient extends HttpClientBase {}
```

Модуль перечисляет клиентов в `httpClients`, сервис просит клиента по типу:

```ts
@Module({
  httpClients: [WeatherClient],
  providers: [scoped(WeatherService)],
  controllers: [WeatherController],
  exports: [],
})
export class WeatherModule {}
```

```ts
export class WeatherService {
  constructor(private readonly weather: WeatherClient) {}

  async forecast(city: string) {
    const { data } = await this.weather.get<Forecast>("/forecast", { params: { city, day: ["mon", "tue"] } });
    return data;
  }
}
```

```text
GET https://weather.example.com/forecast?city=Kazan&day=mon&day=tue
```

- `baseUrl` и `timeoutMs` (а если объявлен — и `maxResponseBytes`) берутся
  из настроек клиента: `BAZIS_WEATHER__BASEURL=…` меняет адрес без правки
  кода. Настройки модуль объявляет сам — отдельно в `config` их писать не
  нужно.
- Остальные настройки запроса — прямо в декораторе:
  `@HttpClient({ config: weatherConfig, headers: { accept: "application/json" }, retry: { maxRetries: 3 } })`.
- По умолчанию тайм-аут 30 с и предел ответа 16 МиБ; correlation id
  запроса уходит в заголовки сам (ниже).
- Клиент — один на приложение (`singleton`).

## Запросы

| Метод | Пример |
| --- | --- |
| `get`, `delete`, `head`, `options` | `http.get<T>(url, config?)` |
| `post`, `put`, `patch` | `http.post<T>(url, data, config?)` |
| `request` | `http.request<T>({ method, url, data, ... })` |

Ответ — объект в стиле Axios:

| Поле | Что это |
| --- | --- |
| `data` | Тело: JSON разбирается сам, текст остаётся строкой |
| `status`, `statusText` | Код ответа |
| `headers` | Заголовки (`Headers`) |
| `raw` | Исходный `Response` |

Объект в `data` уходит как JSON с `content-type: application/json`.
`FormData`, `Blob`, строка и поток отправляются как есть.

## Настройки запроса

Любую настройку можно задать для модуля (`default`) или для отдельного
запроса — значение запроса важнее.

| Настройка | По умолчанию | Что задаёт |
| --- | --- | --- |
| `baseUrl` | — | Начало адреса; путь сохраняется: `https://api/v1` + `/users` → `https://api/v1/users` |
| `params` | — | Параметры строки запроса; массив повторяет ключ, `null` пропускается |
| `headers` | — | Заголовки |
| `timeoutMs` | 30 000 (в модуле) | Тайм-аут всего запроса вместе с повторами |
| `retry` | без повторов | `{ maxRetries, backoffMs, retryOn }` |
| `maxResponseBytes` | 16 МиБ (в модуле) | Предел тела ответа |
| `responseType` | по `content-type` | `"json"`, `"text"`, `"arrayBuffer"`, `"blob"`, `"stream"` |
| `validateStatus` | 200–299 | Какие коды считать успехом; `null` — любые |
| `auth` | — | `{ username, password }` — Basic-авторизация |
| `signal` | — | `AbortSignal` для отмены |

### Повторы

```ts
await this.http.get("/flaky", { retry: { maxRetries: 3, backoffMs: 50 } });
```

Повторяются только запросы, которые можно безопасно отправить дважды
(`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`), — при сетевой ошибке, по
тайм-ауту попытки и на кодах `408`, `429`, `500`, `502`, `503`, `504`
(свой список — `retryOn`). Пауза удваивается с каждой попыткой; если
сервис прислал `Retry-After`, клиент ждёт столько, сколько он просит.
`POST` и `PATCH` не повторяются: повтор мог бы, например, дважды создать
заказ.

## Ошибки

Неудачный запрос бросает `HttpClientError`:

```ts
import { HttpClientError, HttpErrorCode } from "bazis/core/http-client";

try {
  return (await this.http.get(`/cities/${id}`)).data;
} catch (error) {
  if (error instanceof HttpClientError && error.status === 404) throw new NotFoundError(`city ${id} not found`);
  throw error;
}
```

| `error.code` | Когда |
| --- | --- |
| `ERR_BAD_STATUS` | Код ответа не прошёл `validateStatus`; ответ — в `error.response`, код — в `error.status` |
| `ETIMEDOUT` | Истёк `timeoutMs` |
| `ERR_NETWORK` | Сеть: нет соединения, DNS, отказ в браузере |
| `ERR_RESPONSE_TOO_LARGE` | Тело больше `maxResponseBytes` |
| `ERR_BAD_RESPONSE` | Код успешный, но JSON испорчен |
| `ERR_CANCELED` | Запрос отменён через `signal` |

Если ошибку не поймать, сервер ответит своему клиенту так:

| Ошибка | Ответ |
| --- | --- |
| `ETIMEDOUT` | `504 {"error":"Gateway Timeout"}` |
| Остальные коды | `502 {"error":"Bad Gateway"}` |

Подробности чужого ответа клиенту не уходят, а в журнал пишется полная
ошибка с `requestId`. Ловите `HttpClientError` в сервисе, когда ответ
внешнего сервиса что-то значит для вашего API — как `404` в примере.

> [!NOTE]
> Ответы `502` и `504` — с версии 0.98.11. Раньше любой сбой внешнего
> сервиса превращался в `500 Internal Server Error`.

## Correlation id и секреты

Если подключён `createCorrelationIdMiddleware()`, клиент передаёт
`x-request-id` текущего запроса дальше — запрос прослеживается через
несколько сервисов. По умолчанию заголовок уходит только на адрес из
`baseUrl`.

Секретные заголовки (`authorization`, API-ключи, cookie) клиент не
отправляет на другой адрес, чем `baseUrl`, и вырезает при редиректе на
чужой адрес:

```text
http.get("/echo", { headers: { "x-api-key": "secret" } })            → на baseUrl: ключ отправлен
http.get("https://other.example/echo", { headers: { "x-api-key": … } }) → ключ вырезан
```

| Настройка | Что меняет |
| --- | --- |
| `propagateCorrelation: "all"` | `x-request-id` уходит на любой адрес |
| `propagateCorrelation: ["api.internal"]` | Только на перечисленные хосты |
| `allowCrossOriginCredentials: true` | Разрешить секреты для чужого адреса — только если вы доверяете ему |

## Несколько внешних сервисов

Каждый сервис — свой класс со своими настройками; потребитель просит нужный
по типу:

```ts
@HttpClient({ config: paymentsConfig })
export class PaymentsClient extends HttpClientBase {}

@HttpClient({ config: weatherConfig })
export class WeatherClient extends HttpClientBase {}

@Module({ httpClients: [PaymentsClient, WeatherClient], providers: [scoped(CheckoutService)] })
export class CheckoutModule {}
```

```ts
export class CheckoutService {
  constructor(private readonly payments: PaymentsClient) {}
}
```

## Перехватчики

```ts
const api = this.http.create({ baseUrl: "https://crm.example.com" });
api.interceptors.request.use((config) => ({ ...config, headers: { ...config.headers, authorization: `Bearer ${token}` } }));
api.interceptors.response.use((response) => response, (error) => { metrics.failed(); throw error; });
```

`create(config)` делает новый клиент с настройками поверх текущих.
Добавляйте перехватчики к своему клиенту из `create`, а не к клиенту из
DI: он один на приложение, и перехватчик из конструктора scoped-сервиса
добавлялся бы заново при каждом запросе.

## В браузере, без DI

Тот же клиент работает во фронтенде — например, во Vue вместо Axios:

```ts
import { HttpClientBase } from "bazis/library/http-client";

export const api = new HttpClientBase({ baseUrl: "/api", timeoutMs: 10_000 });
api.interceptors.request.use((config) => ({ ...config, headers: { ...config.headers, authorization: `Bearer ${auth.token}` } }));

const { data } = await api.get<Order[]>("/orders", { params: { page: 2 } });
```

Относительный `baseUrl` отсчитывается от адреса страницы:
`/api` на `https://shop.example.com` → `https://shop.example.com/api`.
На сервере `baseUrl` должен быть полным адресом.

> [!NOTE]
> Относительный `baseUrl` — с версии 0.98.11. Раньше в браузере он
> приводил к ошибке `Failed to construct 'URL': Invalid base URL`.

## Дальше

- [Логирование и correlation id](../fundamentals/logging.md)
- [Обработка ошибок](../overview/errors.md)
- [Тестирование](../fundamentals/testing.md) — подмена зависимостей в тестах
