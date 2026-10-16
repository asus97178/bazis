# WebSocket

Шлюз (gateway) — это контроллер для WebSocket: класс с обработчиками
сообщений. Он работает на том же порту, что и HTTP, по адресу
`/ws/<пространство>`. Клиент шлёт события, сервер отвечает и сам
рассылает сообщения в комнаты — из обработчика или из любого сервиса.

Все примеры проверены на bazis 0.98.31.

## Шлюз

```ts
// chat/Chat.gateway.ts
import { SubscribeMessage, WebSocketGateway, type BazisSocket } from "bazis/core/websocket";

@WebSocketGateway({ namespace: "chat" })          // адрес ws://host/ws/chat
export class ChatGateway {
  constructor(private readonly history: ChatHistory) {}

  handleConnection(socket: BazisSocket) { socket.join(`user:${socket.data.user?.id}`); }
  handleDisconnect(socket: BazisSocket, reason: string) { … }

  @SubscribeMessage("join")
  join(socket: BazisSocket, room: string) {
    socket.join(room);
    return { room, history: this.history.get(room) };   // ответ клиенту
  }

  @SubscribeMessage("say")
  say(socket: BazisSocket, message: { room: string; text: string }) {
    this.history.add(message.room, message.text);
    socket.to(message.room).emit("message", { room: message.room, text: message.text, from: socket.id });
    return { delivered: true };
  }
}
```

| Часть | Что это |
| --- | --- |
| `@WebSocketGateway({ namespace })` | Пространство: один адрес и свой набор событий. Путь — `/ws/` + пространство |
| `@SubscribeMessage("join")` | Обработчик события `join`. Аргументы — `socket`, данные, `ack` — по позиции |
| Возвращаемое значение | Уходит клиенту как подтверждение (`ack`) с тем же `id`, что у запроса |
| `handleConnection`, `handleDisconnect` | Вызываются при подключении и отключении |
| `socket.data.user` | Кто подключился — заполняет вход, см. ниже |

Шлюз объявляется в своём модуле, как контроллер, и видит его
провайдеры:

```ts
@Module({
  gateways: [ChatGateway],
  providers: [singleton(ChatHistory)],
  controllers: [ChatController],
})
export class ChatModule {}
```

Больше ничего не нужно: `runApp` с опцией `http` обслуживает шлюзы на том
же порту.

> [!NOTE]
> Поле `gateways` в `@Module` — с версии 0.98.31. Раньше шлюзы
> перечислялись в `websocketModule({ gateways })`, и шлюз не видел
> сервисы своего модуля.

## Протокол

Сообщения — JSON. Клиент шлёт событие:

```json
{ "v": 1, "type": "event", "event": "join", "data": "general", "id": "1" }
```

Сервер отвечает подтверждением с тем же `id` или ошибкой, а события в
комнату приходят без `id`:

```json
{ "v": 1, "type": "ack", "id": "1", "data": { "room": "general", "history": [] } }
{ "v": 1, "type": "error", "id": "2", "data": { "message": "Unknown event" } }
{ "v": 1, "type": "event", "namespace": "/chat", "event": "message", "data": { "room": "general", "text": "hi" } }
```

Сразу после подключения приходит `connected` с номером сессии:

```json
{ "v": 1, "type": "connected", "sid": "c805c8d7-…", "namespace": "/chat", "data": { "userId": "ann" } }
```

`id` нужен только тем сообщениям, на которые клиент ждёт ответ.
`{ "v": 1, "type": "ping" }` получает `{ "v": 1, "type": "pong" }`.

Клиент в браузере:

```js
const ws = new WebSocket("wss://api.example.com/ws/chat", [`bearer.${accessToken}`]);
let seq = 0;
const waiting = new Map();

ws.onmessage = ({ data }) => {
  const packet = JSON.parse(data);
  if (packet.id && waiting.has(packet.id)) { waiting.get(packet.id)(packet); waiting.delete(packet.id); return; }
  if (packet.type === "event") render(packet.event, packet.data);
};

function send(event, data) {
  return new Promise((resolve) => {
    const id = String(++seq);
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ v: 1, type: "event", event, data, id }));
  });
}

await send("join", "general");
await send("say", { room: "general", text: "hi" });
```

## Комнаты

Комната — имя, к которому подписываются сокеты: `socket.join("general")`,
`socket.leave("general")`. `socket.to(room).emit(event, data)` шлёт всем
в комнате, **кроме отправителя**; ему ответ возвращает сам обработчик.

Проверено: Ann и Bob вошли в `general`, Ann отправила `say`:

```text
ann  <- ack {"delivered":true}
bob  <- event "message" {"room":"general","text":"hi","from":"c805c8d7-…"}
```

Удобный приём — в `handleConnection` подписывать сокет на личную комнату
`user:<id>`, тогда «сообщить пользователю» — это отправка в неё.

## Отправка из сервиса

Сервер часто должен написать клиенту сам: заказ оплачен, отчёт готов.
Для этого есть `WebSocketService` — его может внедрить любой сервис или
контроллер:

```ts
import { WebSocketService } from "bazis/core/websocket";

export class OrdersService {
  constructor(private readonly ws: WebSocketService) {}

  async markPaid(order: Order) {
    …
    this.ws.to(`user:${order.userId}`).emit("order-paid", { orderId: order.id });
  }
}
```

```text
ann <- {"v":1,"type":"event","namespace":"/chat","event":"order-paid","data":{"orderId":42}}
```

- Доставка та же, что у `socket.to(room)`: подключённым участникам сразу,
  отключившимся — в очередь до переподключения.
- `to(room)` работает, когда пространство одно. Если их несколько —
  `this.ws.namespace("chat").to(room).emit(…)`; иначе ошибка перечислит
  пространства.
- До запуска сервера и после остановки отправка бросает
  `WebSocket server is not running.`.

> [!NOTE]
> `WebSocketService` — с версии 0.98.31. Раньше отправить сообщение можно
> было только в ответ на сообщение клиента.

## Вход

Настройки WebSocket на всё приложение — опция `websocket` в `runApp`:

```ts
await runApp(AppModule, {
  http: { port: 3000 },
  websocket: {
    requireAuth: true,
    cors: { origins: ["https://app.example.com"] },
    authenticator: async (token, context) => {
      if (!token) return null;
      const { payload } = await context!.services!.resolve(AuthTokens).issuer.verifyAccess(token);
      return { id: String(payload.sub) };            // socket.data.user
    },
  },
});
```

`context.services` — сервисы приложения: проверка берёт тот же
`AuthTokens`, что и HTTP-проверки, с ключом из настроек.

> [!NOTE]
> `context.services` — с версии 0.100.4. Раньше проверке токена
> приходилось создавать свой издатель токенов вне DI.

| Настройка | Что делает |
| --- | --- |
| `authenticator` | Проверяет токен при подключении; вернуть `null` — анонимный клиент |
| `requireAuth: true` | Без пользователя подключение отклоняется |
| `cors.origins` | Откуда можно подключаться из браузера; с `authenticator` список обязателен |

Токен передаётся в заголовке `Authorization: Bearer …` или, из браузера,
где заголовки задать нельзя, — подпротоколом `bearer.<токен>`:

```js
new WebSocket("wss://api.example.com/ws/chat", [`bearer.${accessToken}`]);
```

Передачу токена в строке запроса (`?token=`) включает `allowQueryToken: true`;
по умолчанию она выключена — адреса попадают в журналы и историю браузера.

| Подключение | Ответ сервера |
| --- | --- |
| Без токена при `requireAuth` | `401 Unauthorized` |
| Токен истёк, испорчен, не та подпись (`JwtError`) | `401 Unauthorized` |
| `Origin` не из списка | `403 Origin not allowed` |
| Пространства нет | `404` |
| `authenticator` упал с другой ошибкой | `500`, ошибка в логе |

Проверка токена при подключении — это проверка входа. Права на
действия проверяйте в обработчиках: `socket.data.user` там уже есть.

> [!NOTE]
> `401` для `JwtError` — с версии 0.98.31; раньше был `500`.

## Проверка данных и лимиты

Данные события приходят как есть. Проверка — опция `validate`: верните
значение для обработчика или бросьте ошибку. Лимит частоты — `rateLimit`:

```ts
@SubscribeMessage("say", {
  rateLimit: { limit: 20, windowMs: 60_000 },
  validate: (body) => {
    const m = body as { room?: unknown; text?: unknown } | null;
    if (typeof m?.room !== "string" || typeof m.text !== "string" || !m.text.trim()) throw new Error("room and text are required");
    return { room: m.room, text: m.text.trim() };
  },
})
say(socket: BazisSocket, message: { room: string; text: string }) { … }
```

| Что пришло | Ответ клиенту |
| --- | --- |
| `{ room: "general" }` без текста | `error` `Invalid message payload` |
| Третье сообщение в минуту при `limit: 2` | `error` `Too many requests` |
| Неизвестное событие | `error` `Unknown event` |
| Сообщение больше `maxPayloadBytes` (64 КиБ) | Соединение закрывается без ответа (код закрытия `1006` или `1009`) |

Текст вашей ошибки из `validate` клиенту не уходит — только
`Invalid message payload`. Предел размера и время жизни сессии задаются
в `@WebSocketGateway({ maxPayloadBytes, sessionTtlMs })`.

## Ошибки обработчика

Исключение в обработчике клиент видит как `Handler failed`, без текста,
а в лог приложения уходит полная ошибка с маскировкой секретов:

```text
error: WebSocket handler failed {"namespace":"/chat","event":"crash","error":{"name":"Error","message":"database is down, password=***", …}}
```

`exposeHandlerErrors: true` в настройках `websocket` отдаёт текст клиенту —
только для разработки.

> [!NOTE]
> Запись ошибок обработчиков в лог — с версии 0.98.31. Раньше ошибка
> терялась: клиент получал `Handler failed`, лог оставался пустым.

## Переподключение

Сессия живёт дольше соединения (`sessionTtlMs`, по умолчанию 2 часа).
Клиент, потерявший связь, подключается снова с номером сессии и получает
пропущенные сообщения:

```js
new WebSocket(`wss://api.example.com/ws/chat?sid=${sid}`, [`bearer.${accessToken}`]);
```

```json
{ "v": 1, "type": "reconnected", "sid": "d3ec5889-…", "missed": [ { "type": "event", "event": "order-paid", … } ] }
```

Проверено: Bob отключился, сервис отправил ему `order-paid`, Bob
переподключился — пришёл `reconnected` с одним пропущенным сообщением.
Комнаты сессии сохраняются. Чужую сессию взять нельзя: номер привязан к
пользователю, и подключение с её номером, но другим токеном получает
`401 Unauthorized`.

Сессии и комнаты по умолчанию живут в памяти одного процесса. Для
нескольких экземпляров за балансировщиком нужен адаптер Redis: тогда
`to(room)` доходит до клиентов других экземпляров, а сессия переживает
переподключение к другому. Адаптер строится из сервисов приложения и
берёт клиент Redis из `@Infra`:

```ts
import { IRedis } from "bazis/core/infra";
import { RedisWebSocketAdapter } from "bazis/core/websocket";

websocket: { adapter: (services) => new RedisWebSocketAdapter(services.resolve(IRedis)) }
```

> [!NOTE]
> С версии 0.100.4 `adapter` — функция от сервисов приложения; готовый
> экземпляр не принимается. Раньше адаптеру нужен был отдельный клиент
> Redis, созданный вне `@Infra`.

Адаптер хранит в Redis сессии и неотправленные сообщения, поэтому
требует, чтобы Redis не терял записи: `appendonly yes`,
`appendfsync always`, `no-appendfsync-on-rewrite no`,
`maxmemory-policy noeviction`. Иначе приложение не стартует и называет,
что изменить:

```text
WebSocketDeliveryError [DURABILITY_CONFIGURATION]: WebSocket delivery needs a Redis that does not lose writes:
  appendonly is no, needs yes; appendfsync is everysec, needs always. Set them in redis.conf or with CONFIG SET;
  otherwise undelivered messages and sessions may be lost.
```

Подробный пример — в рецепте [Несколько экземпляров с Redis](../recipes/multiple-instances.md).

## Дальше

- [Авторизация](../overview/authorization.md)
- [Аутентификация через JWT](../security/jwt.md)
- [Логирование и correlation id](../fundamentals/logging.md)
