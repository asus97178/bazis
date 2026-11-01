# Свой коннектор

Если готового коннектора нет — почтовый шлюз, платёжный API, очередь, —
напишите свой. Коннектор — объект с четырьмя действиями: создать клиента,
подключиться, отключиться, проверить здоровье. Всё остальное —
конфигурацию, порядок старта, `/health`, внедрение — даёт
[`@Infra`](overview.md).

Пример проверен на bazis 0.111.1 с локальным сервером вместо внешнего
сервиса.

## Клиент

Сначала клиент — то, что получат сервисы приложения. Здесь — клиент
внешнего сервиса уведомлений:

```ts
// notify/notify.connector.ts
import { InfraError } from "bazis/core/infra";

export class NotifyClient {
  private readonly lifetime = new AbortController();

  constructor(private readonly url: string, private readonly token: string) {}

  async send(to: string, text: string): Promise<number> {
    const response = await fetch(`${this.url}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) throw new InfraError(`Notify POST /messages -> ${response.status}`);
    return ((await response.json()) as { id: number }).id;
  }

  async alive(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/health`, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(2_000), ...(signal ? [signal] : [])]),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  close(): void {
    this.lifetime.abort();
  }
}
```

У каждого запроса есть срок, а `close()` обрывает текущие запросы — при
остановке приложение не будет ждать зависший сервис.

## Тип для внедрения

Чтобы сервисы получали клиента по типу, объявите интерфейс и токен
одного имени:

```ts
import { createToken, type InjectionToken } from "bazis/core/di";

export interface INotify extends NotifyClient {}
export const INotify = createToken<INotify>("INotify") as InjectionToken<NotifyClient>;
```

## Коннектор

```ts
import { reader, requireValue, type InfraConnector } from "bazis/core/infra";
import type { AppConfig, Secret } from "bazis/core/kernel";

export interface NotifyConfigShape { url: string; token: Secret }

export function notifyConnect(config: AppConfig<NotifyConfigShape>): InfraConnector<NotifyClient> {
  return {
    token: INotify,
    config,
    create(configs) {
      const c = reader(config, configs);
      return new NotifyClient(requireValue(c.get("url"), "url", "notify"), (c.get("token") as Secret).reveal());
    },
    async connect(client, signal) {
      if (!(await client.alive(signal))) throw new InfraError('Infra connector "notify": service is not reachable.');
    },
    dispose(client) {
      client.close();
    },
    healthCheck(client, signal) {
      return client.alive(signal);
    },
  };
}
```

| Часть | Когда вызывается | Что делает |
| --- | --- | --- |
| `token` | — | Под каким токеном клиент попадёт в DI |
| `config` | До старта | Конфигурация коннектора: `runApp` проверит её вместе с остальной |
| `create(configs)` | Перед подключением | Создаёт клиента, ещё не подключённого; здесь читается конфигурация и раскрываются секреты |
| `connect(client, signal)` | При старте | Подключается; ошибка останавливает старт |
| `dispose(client)` | При остановке | Закрывает соединения |
| `healthCheck(client, signal)` | На каждый `/health` | Жив ли сервис; без него проверки `infra:<имя>` не будет |
| `phase` | — | Порядок старта, по умолчанию `-100`: раньше HTTP-сервера |
| `describe(client, { connected })` | После подключения и после сбоя | Что показать на экране запуска: продукт и версия, адрес без пароля, переменные адреса. Необязательно |

`reader(config, configs)` читает значения конфигурации с учётом окружения
и переменных `BAZIS_…`. `requireValue` — что значение задано, иначе
понятная ошибка. Секрет раскрывайте только в `create`: дальше он живёт
внутри клиента и в журнал не попадает.

## Подключение

```ts
// infra/configs.ts
export interface NotifyConfig { url: string; token: Secret }
export const notifyConfig = defineConfig<NotifyConfig>("notify", {
  default: { url: "http://127.0.0.1:4020", token: secret("notify-dev") },
  production: { token: secret() },
});

// infra/App.infra.ts
@Infra({
  db: postgres(dbConfig),
  notify: notifyConnect(notifyConfig),
})
export class AppInfra {}
```

```ts
export class SignupService {
  constructor(private readonly notify: INotify) {}

  async signup(user: string) {
    return this.notify.send("ops", `new user ${user}`);
  }
}
```

Проверено:

```text
сервис недоступен при старте
→ [bazis] application failed: InfraError: Infra connector "notify": service is not reachable.

сервис работает
→ GET /health … {"name":"infra:notify","healthy":true,…}

сервис заболел
→ GET /health → 503 … {"name":"infra:notify","healthy":false,…}
```

## Сервис поверх клиента

Коннектор может добавить в DI готовый сервис на своём клиенте — так
`redisConnect(…, { cache: "distributed" })` добавляет общий кэш. Это поля
`providers` и `exports`:

```ts
export class WelcomeMessages {
  constructor(private readonly notify: INotify) {}
  welcome(user: string) {
    return this.notify.send(user, `Добро пожаловать, ${user}!`);
  }
}

export function notifyConnect(config: AppConfig<NotifyConfigShape>): InfraConnector<NotifyClient> {
  return {
    // … как выше
    providers: [singleton(WelcomeMessages)],
    exports: [WelcomeMessages],
  };
}
```

```ts
export class SignupService {
  constructor(private readonly notify: INotify, private readonly welcome: WelcomeMessages) {}
}
```

```text
POST /signup/ann → {"welcomeId":1,"auditId":2}
сервис получил: [{"to":"ann","text":"Добро пожаловать, ann!"},{"to":"ops","text":"new user ann"}]
```

## Советы

- **Срок на всё.** Подключение, запрос, проверка здоровья — каждое со
  своим сроком. Коннектор без срока подвешивает старт до общего срока
  приложения, 30 секунд.
- **Ошибка называет, что не так.** `InfraError` с именем коннектора и
  причиной. Не кладите в сообщение пароль и ключи; в адресе
  `redactSensitiveText` из `bazis/library/redaction` маскирует пароль.
- **Клиент без глобального состояния.** Всё — в экземпляре: тогда работают
  [два экземпляра](overview.md#два-экземпляра-одного-типа) с разными токенами.
- **Рядом с `ensureCreated` — `phase: 0`.** Если модуль создаёт схему
  через `ensureCreated` на PostgreSQL, до сервисов приложения стартуют
  только коннекторы фреймворка. Свой коннектор с фазой по умолчанию
  остановит старт:

  ```text
  [bazis] application failed: SchemaAdmissionError [ORM_SCHEMA_HOSTED_PHASE_CONFLICT]:
    Application hosted services must use phase 0 or later with schema admission:
    infra:notify (phase -100) is not a framework connector; a custom or changed
    connector starts at phase 0 or later: set phase: 0 on it.
  ```

  Добавьте в коннектор `phase: 0` — он подключится вместе с сервисами
  приложения, до HTTP-сервера.
- **`create` ничего не подключает.** Подключение — в `connect`: тогда старт
  сообщает об ошибке в одном месте и с понятным текстом.

## Дальше

- [Обзор `@Infra`](overview.md)
- [Коннекторы](connectors.md)
- [Конфигурация](../fundamentals/configuration.md)
- [Секреты](../security/secrets.md)
