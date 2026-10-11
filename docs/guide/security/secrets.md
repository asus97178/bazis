# Секреты и конфигурация

Как объявлять настройки и откуда они берутся, рассказано в главе
[Конфигурация](../fundamentals/configuration.md). Здесь — про секреты:
пароли, ключи API, ключи подписи. Где их хранить в production, что bazis
прячет сам и где секрет всё-таки может утечь.

Все примеры проверены на bazis 0.98.29.

## Секрет в коде — только для разработки

Значение в `default` видно всем, у кого есть код. Поэтому секрет по
умолчанию — это ключ разработки, а production получает свой:

```ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface MailConfig { host: string; apiKey: Secret }

export const mailConfig = defineConfig<MailConfig>("mail", {
  default: { host: "localhost", apiKey: secret("dev-key") },
  production: { apiKey: secret() },   // без значения — обязателен
});
```

Забытая строка `production` больше не проходит молча. В production
приложение не запустится на секрете из `default`:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
mail.apiKey — production would use the development default secret from the code;
set BAZIS_MAIL__APIKEY, or declare apiKey in the production section.
```

| Окружение | `BAZIS_MAIL__APIKEY` не задана | Задана |
| --- | --- | --- |
| `development`, `test` | `dev-key` из кода | Значение переменной |
| `production` | Запуск остановлен | Значение переменной |

> [!NOTE]
> Проверка — с версии 0.98.29. Раньше production работал на `dev-key`.
> Если общий ключ для production действительно нужен в коде (тестовый
> стенд), объявите его явно: `production: { apiKey: secret("…") }`.

Окружение без `BAZIS_ENV` (и без `NODE_ENV`) — это `production`, а не
`development`: забытая переменная не включит режим разработки.

### Проверка значения

Длину ключа и формат проверяет `validate`. Текст ошибки — ваш, значение
в него не попадает:

```ts
validate: {
  signingKey: (key) => key.reveal().length < 32 ? "must be at least 32 characters" : undefined,
},
```

```text
Invalid configuration (environment "production"): auth.signingKey — must be at least 32 characters.
```

## Где хранить секреты в production

| Способ | Подходит? |
| --- | --- |
| Переменные окружения `BAZIS_*` (systemd `EnvironmentFile`, `docker run -e`, Kubernetes `secretKeyRef`) | Да |
| Файлы секретов Docker и Kubernetes (`/run/secrets`) через `secretFilesSource` | Да |
| Аргументы командной строки `--mail.apiKey=…` | Нет: аргументы видны всем в `ps` |
| JSON-файл в репозитории | Нет |
| `.env` рядом с бинарником | Только осознанно, см. ниже |

### Файлы секретов

Docker (`secrets:` в compose, swarm) и Kubernetes (секрет, смонтированный
томом) кладут каждый секрет отдельным файлом. `secretFilesSource` читает
такой каталог:

```ts
import { runApp } from "bazis/core/app";
import { argsSource, envSource, secretFilesSource } from "bazis/core/kernel";

await runApp(AppModule, {
  http: { port: 3000 },
  configure: (kernel) => kernel
    .addConfigSource(secretFilesSource("/run/secrets", { optional: true }))
    .addConfigSource(envSource())
    .addConfigSource(argsSource()),
});
```

```text
/run/secrets/
├── mail.apiKey            ключ — имя настройки
└── BAZIS_DB__PASSWORD     или имя переменной
```

- Перевод строки в конце файла отбрасывается (`echo "key" > file` его
  добавляет).
- Служебные записи Kubernetes (`..data` и другие скрытые) и каталоги
  пропускаются; ключи-ссылки Kubernetes читаются.
- Файл больше 64 КиБ — ошибка запуска. Ошибки называют файл, но не его
  содержимое.
- Без `optional: true` отсутствующий каталог — ошибка запуска.
- Источники идут по порядку, следующий сильнее: здесь переменная окружения
  перекроет файл.

`inspect()` показывает, откуда пришло значение:

```json
{ "key": "mail.apiKey", "type": "secret", "env": ["BAZIS_MAIL__APIKEY"], "source": "files(/run/secrets)", "value": "***" }
```

> [!NOTE]
> `secretFilesSource` — с версии 0.98.29.

## Файлы `.env`

Bun сам читает `.env`, `.env.local` и `.env.<NODE_ENV>` при запуске из
исходников, поэтому `bazis dev` и `bazis test` их видят. Это удобно для
разработки и опасно для production.

- В git им не место. `bazis new` пишет в `.gitignore`:

  ```text
  .env
  .env.*
  !.env.example
  ```

- Бинарник из `bazis build --bin` **не** читает `.env` из каталога, где
  его запустили: настройки приходят только из настоящего окружения.
  Проверено: рядом с бинарником лежит `.env` с `BAZIS_ENV=development`, а
  приложение работает как production и отвечает на ошибку просто
  `{"error":"Internal Server Error"}`. Если `.env` рядом с бинарником — ваш
  способ развёртывания, соберите с `--dotenv`:

  ```bash
  bunx bazis build --bin --dotenv
  ```

  Тогда тот же `.env` переключит бинарник в `development` — с текстом и
  стеком ошибок в ответах. И `.env.local` побеждает `.env.production` даже
  при `NODE_ENV=production`.

- `bunfig.toml` бинарник не читает никогда. Иначе `preload` из такого
  файла в рабочем каталоге выполнил бы чужой код внутри приложения.

> [!NOTE]
> До версии 0.98.29 бинарник читал и `.env`, и `bunfig.toml` из
> рабочего каталога.

## Что делает `Secret`

`config.get("apiKey")` возвращает объект `Secret`. Значение достаёт только
`.reveal()`, всё остальное показывает звёздочки:

| Код | Результат |
| --- | --- |
| `console.log(key)` | `Secret(***)` |
| `` `${key}` `` | `***` |
| `JSON.stringify({ key })` | `{"key":"***"}` |
| `config.inspect()` | `"value": "***"` |
| `key.reveal()` | `dev-key` |

Поэтому держите `Secret` до места, где значение действительно нужно, и
вызывайте `.reveal()` прямо там:

```ts
async send(message: Mail) {
  await fetch(this.url, { headers: { authorization: `Bearer ${this.config.get("apiKey").reveal()}` }, … });
}
```

Строку из `.reveal()` не сохраняйте в поле сервиса, не возвращайте из
методов и не кладите в текст ошибок.

## Что маскируется в логах

`ConsoleLogger` и логи ошибок фреймворка маскируют:

| Что | Пример | В логе |
| --- | --- | --- |
| Поле с «секретным» именем | `{ apiKey: "live-AbC" }` | `{"apiKey":"***"}` |
| `имя=значение` в тексте | `password=hunter22` | `password=***` |
| Заголовок авторизации | `Bearer eyJhbGciOi…` | `Bearer ***` |
| Логин и пароль в адресе | `postgres://app:pa55word@db/app` | `postgres://***:***@db/app` |

Секретные имена: `password`, `secret`, `token`, `apiKey`, `authorization`,
`cookie`, `privateKey`, `clientSecret`, `credential`, `sessionId` и их
варианты (`refresh_token`, `x-api-key`…). Маскируется и текст сообщения,
и поля, и сообщение со стеком ошибки.

Проверено на ошибке с адресом SMTP:

```ts
throw new Error(`SMTP rejected login for smtp://mailer:${this.config.get("apiKey").reveal()}@smtp.local`);
```

```text
GET /mail/send  →  500 {"error":"Internal Server Error"}
```

```text
error: GET /mail/send failed {"method":"GET","path":"/mail/send","error":{"name":"Error",
"message":"SMTP rejected login for smtp://***:***@smtp.local", …}}
```

> [!WARNING]
> Маскировка узнаёт секрет **по виду**, а не по значению. Ключ, вставленный
> в текст без имени — `` `key ${key.reveal()} rejected` `` — попадёт в лог как
> есть. Не кладите значения секретов в сообщения и ошибки.

> [!NOTE]
> Маскировка адресов и текста сообщения — с версии 0.98.29. Раньше пароль
> из адреса попадал в лог.

## Ошибки и окружение

В production клиент получает только название статуса, без сообщения и
стека. В `development` ответ содержит `message` и `stack`. Они проходят ту
же маскировку, что и лог, но всё остальное из текста ошибки — имена
таблиц, пути, данные — уходит клиенту. Поэтому:

- стенд, доступный снаружи (staging, демо), запускайте с
  `BAZIS_ENV=production`;
- `http: { exposeErrorDetails: true }` в production не включайте.

## Ротация ключей

Секрет — одна строка. Несколько ключей (новый и старый, на время смены)
удобно передать через запятую:

```ts
export interface WebhookConfig { keys: Secret }

export const webhookConfig = defineConfig<WebhookConfig>("webhook", {
  default: { keys: secret("dev-1") },
  production: { keys: secret() },
});

// BAZIS_WEBHOOK__KEYS=new-key,old-key
const keys = this.config.get("keys").reveal().split(",");
```

Новым ключом подписывайте, а принимайте оба. Когда старый перестал
встречаться, уберите его из переменной. Для JWT то же самое делает
набор ключей — см. [Ротация ключей](jwt.md#ротация-ключей).

## Дальше

- [Конфигурация](../fundamentals/configuration.md)
- [Аутентификация через JWT](jwt.md)
- [Обработка ошибок](../overview/errors.md)
