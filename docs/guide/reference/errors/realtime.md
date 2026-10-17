# Ошибки WebSocket и gRPC

Тексты — из исходников 0.100.8; проверенные примеры — в главах
[WebSocket](../../realtime/websocket.md) и [gRPC](../../realtime/grpc.md).

## WebSocket

### Что получает клиент

Ошибка в ответ на сообщение — пакет `error` с тем же `id`:

```json
{ "v": 1, "type": "error", "id": "2", "data": { "message": "Unknown event" } }
```

| Ситуация | `message` |
| --- | --- |
| Неизвестное событие | `Unknown event` |
| Данные не прошли проверку | `Invalid message payload` |
| Превышен `rateLimit` обработчика | `Too many requests` |
| Обработчик упал | `Handler failed`; полная ошибка — в журнале `WebSocket handler failed` |
| Сообщение больше `maxPayloadBytes` (64 КиБ) | Ответа нет: соединение закрывается с кодом `1006` или `1009` |
| Пакет — не JSON или не объект | `Invalid JSON packet`, `Packet must be a JSON object` |
| Неизвестная версия или тип пакета | `Unsupported packet version`, `Unknown packet type: …` |

Подробно — в главе [WebSocket](../../realtime/websocket.md#проверка-данных-и-лимиты).

### При подключении

`WsUpgradeError` — отказ в подключении, ответ HTTP до перехода на
WebSocket:

| Статус | Текст | Когда |
| --- | --- | --- |
| 401 | `Unauthorized` | `authenticator` не узнал клиента |
| 403 | `Origin not allowed` | `Origin` не из разрешённых |
| 500 | — | `authenticator` упал с другой ошибкой; ошибка — в журнале |

### `SessionCapacityError`

```text
WebSocket session capacity exceeded (10000).
```

Подключений больше, чем `maxSessions`. Новые отклоняются.

### `WebSocketDeliveryError`

Ошибки гарантированной доставки через Redis. Код — в поле `code` и в
тексте `WebSocket delivery rejected: <код>.`:

| Код | Когда |
| --- | --- |
| `DURABILITY_CONFIGURATION` | Redis может терять записи. Текст называет неверные настройки: `appendonly is no, needs yes; appendfsync is everysec, needs always.` ([Несколько экземпляров](../../recipes/multiple-instances.md)) |
| `RELIABLE_DELIVERY_UNAVAILABLE` | Гарантированная доставка запрошена, а адаптер её не поддерживает |
| `PAYLOAD_CAPACITY` | Сообщение больше допустимого размера |
| `QUEUE_CAPACITY`, `OFFLINE_QUEUE_CAPACITY` | Переполнена очередь недоставленных сообщений |
| `STORE_TIMEOUT`, `STORE_BUSY` | Redis не ответил в срок или перегружен |
| `OWNERSHIP_LOST`, `DELIVERY_POLICY_MISMATCH`, `INVALID_PUBLICATION`, `STORE_PROTOCOL` | Внутренние: состояние доставки в Redis не совпало с ожидаемым |

## gRPC

`GrpcError` — ошибка со статусом gRPC: `new GrpcError(GrpcStatus.NOT_FOUND,
"User 99 not found.")`. Класс и `GrpcStatus` — из `bazis/core/grpc`.

### Сервер

| Ситуация | Клиент получает |
| --- | --- |
| `throw new GrpcError(GrpcStatus.NOT_FOUND, "User 99 not found.")` | `5 "User 99 not found."` |
| Не прошли правила DTO | `3 "Request validation failed."` и трейлер с полями |
| Нет входа | `16 "Unauthenticated."` |
| Нет прав | `7 "Permission denied."` |
| Любое другое исключение | `13 "Internal server error."`; ошибка — в журнале `gRPC handler failed` |

### Клиент

| Статус | Текст | Когда |
| --- | --- | --- |
| `UNAVAILABLE` | `Unable to open gRPC connection.` | Сервер недоступен |
| `DEADLINE_EXCEEDED` | `Deadline exceeded.` | Вышел срок вызова |
| `CANCELLED` | `RPC cancelled.`, `gRPC client is closed.` | Отмена через `signal`; клиент закрыт |
| `RESOURCE_EXHAUSTED` | `Too many concurrent gRPC calls.`, `gRPC response message is too large.` | Предел одновременных вызовов; ответ больше лимита |
| `INTERNAL` | `Invalid protobuf response.`, `Unary response requires exactly one message.` | Сервер ответил не по протоколу |

Ошибка клиента gRPC, которую не поймали в контроллере HTTP, даёт
`502 Bad Gateway` (тайм-аут — `504`), как ошибка
[HTTP-клиента](http.md#http-клиент).

## Дальше

- [WebSocket](../../realtime/websocket.md)
- [gRPC](../../realtime/grpc.md)
