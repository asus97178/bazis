# `bazis/core/websocket`

WebSocket: шлюзы, комнаты, вход, рассылка из сервисов, адаптеры для
нескольких экземпляров. Список — по пакету 0.128.0.

## Шлюзы

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WebSocketGateway(options)` | Класс-шлюз в пространстве имён (`namespace: "chat"` → `/ws/chat`); подключается полем `gateways` модуля | [Шлюз](../../realtime/websocket.md#шлюз) |
| `SubscribeMessage(event, options)` | Метод — обработчик события: проверка данных, `rateLimit` | [Протокол](../../realtime/websocket.md#протокол) |
| `WebSocketService` | Отправка событий в комнаты из сервиса, контроллера, фоновой задачи | [Отправка из сервиса](../../realtime/websocket.md#отправка-из-сервиса) |
| `extractWebSocketToken(request)` | Токен из `Authorization` или `Sec-WebSocket-Protocol: bearer.<token>` | [Вход](../../realtime/websocket.md#вход) |

## Несколько экземпляров

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `RedisWebSocketAdapter` | Рассылка и сессии через Redis: `adapter: (services) => new RedisWebSocketAdapter(services.resolve(IRedis))` | [Несколько экземпляров](../../recipes/multiple-instances.md) |
| `InMemoryWebSocketAdapter`, `inMemoryWebSocketAdapter` | Адаптер одного процесса; по умолчанию | — |

## Ошибки

`WsUpgradeError` (отказ при подключении, со статусом HTTP),
`SessionCapacityError`, `WebSocketDeliveryError`, `PacketCodecError` —
[Ошибки WebSocket](../errors/realtime.md#websocket).

## Для пакетов и своих адаптеров

`websocketModule`, `WebSocketServer`, `WebSocketExplorer`, `SessionManager`,
`BazisSocketImpl`, `wrapSocket`, `WsRateLimiter`, `TopicCache`, `topicCache`,
кодеки `JsonPacketCodec`, `jsonPacketCodec`, `BinaryPacketCodec`,
`binaryPacketCodec`, функции протокола `encodeServerPacket`,
`decodeClientPacket`, `createAckPacket`, `createConnectedPacket`,
`createReconnectedPacket`, `sendPayload`, `createInstanceId`,
`normalizeNamespace`, подписки `detachRoomSubscriptions`,
`restoreRoomSubscriptions`, middleware подключения
`composeWsUpgradeMiddleware`, `createOriginCheckMiddleware`,
`createWsAuthMiddleware`, метаданные `getWebSocketGatewayMetadata`,
`getGatewayMessageHandlers`, `resolveWebSocketGatewayOptions`.

## Типы

- **Шлюз и сокет:** `BazisSocket`, `SocketContext`, `SocketUser`,
  `SocketBroadcast`, `AckCallback`, `WebSocketGatewayOptions`,
  `ResolvedGatewayOptions`, `SubscribeMessageOptions`, `MessageHandlerDecl`,
  `CompiledWsHandler`, `WebSocketNamespace`, `RegisteredNamespace`,
  `OnGatewayInit`, `OnGatewayConnection`, `OnGatewayDisconnect`,
  `OnGatewayShutdown`.
- **Вход и пределы:** `WsAccessTokenAuthenticator`, `WsAuthenticationContext`,
  `WsUpgradeContext`, `WsConnectionData`, `WsMiddleware`, `WsBodyValidator`,
  `WsRateLimit`, `WsRateLimiterOptions`, `WsRateLimiterStats`,
  `WebSocketMemoryLimits`.
- **Сервер и модуль:** `WebSocketOptions`, `WebSocketModuleConfig`,
  `WebSocketServerOptions`, `WebSocketServerStats`, `WebSocketDiagnostic`,
  `SessionManagerOptions`, `SessionState`, `TopicCacheOptions`,
  `TopicCacheStats`.
- **Протокол:** `ClientPacket`, `ServerPacket`, `PacketCodec`,
  `ReconnectPacketData`.
- **Адаптеры и доставка:** `WebSocketAdapter`, `WebSocketAdapterHooks`,
  `InMemoryWebSocketAdapterOptions`, `RedisWebSocketAdapterOptions`,
  `RedisReliableDeliveryOptions`, `ReliableBroadcastOptions`,
  `ReliableBroadcastReceipt`, `ReliableDeliveryBatch`, `ReliableRoomDelivery`,
  `ReliableRoomPublication`, `ReliableSessionOwner`, `ReplayAcknowledgement`,
  `ReplayDelivery`, `OfflineBroadcastResult`.

Параметры — `runApp({ websocket })` ([Параметры конфигурации](../configuration.md#runapp)).
