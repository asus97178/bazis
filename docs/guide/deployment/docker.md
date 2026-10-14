# Docker

Образ в два этапа: на первом Bun собирает [исполняемый файл](single-executable.md),
на втором файл кладётся в небольшой Debian. В итоговом образе нет ни Bun,
ни `node_modules`, ни исходников.

Все примеры проверены на bazis 0.100.2, образах `oven/bun:1.4.0` и
`debian:bookworm-slim`, Docker Compose 5.1 и PostgreSQL 17.

## Dockerfile

```dockerfile
# Сборка: зависимости, кодогенерация, проверка типов, исполняемый файл.
FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx bazis build --bin

# Запуск: только исполняемый файл в небольшом Debian, не от root.
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 app
COPY --from=build /app/bin/shop /usr/local/bin/shop
USER app
ENV BAZIS_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/usr/local/bin/shop"]
```

```text
# .dockerignore
node_modules
bin
src/generated
.env
.env.*
.git
```

- **Версия Bun** в образе сборки — та же, что в проекте: так кодогенерация
  и проверка типов идут так же, как у вас локально.
- **`bun install --frozen-lockfile`** до копирования исходников: слой с
  зависимостями пересобирается, только когда меняется `bun.lock`.
- **`bazis build --bin`** сам запускает кодогенерацию, поэтому
  `src/generated` в образ не копируется.
- **`HOST=0.0.0.0`** — иначе приложение слушает только `127.0.0.1` внутри
  контейнера и снаружи недоступно.
- **`ENTRYPOINT` в форме массива** — приложение становится процессом 1 и
  само получает `SIGTERM` от `docker stop`.
- **`HEALTHCHECK` без `curl`**: в `debian:bookworm-slim` его нет, а `bash`
  умеет открыть TCP-соединение сам. Запрос — HTTP/1.1 с заголовком
  `Host`.

```sh
docker build -t shop .
```

Сборка заняла 19 секунд, образ — 259 МБ: 138 МБ Debian и 84 МБ
исполняемый файл. Образ собирается под архитектуру машины сборки: на Mac с
Apple Silicon — `aarch64`.

## Запуск

```sh
docker run -d --name shop -p 8080:8080 \
  -e BAZIS_DB__HOST=db.internal \
  -v /etc/shop/db_password:/run/secrets/BAZIS_DB__PASSWORD:ro \
  shop
```

Секрет здесь — файл, смонтированный в `/run/secrets`: его читает
`secretFilesSource` из [точки входа для production](production.md#точка-входа).
Можно и переменной: `-e BAZIS_DB__PASSWORD=…`, но тогда значение видно в
`docker inspect`.

```text
$ docker inspect -f '{{.State.Health.Status}}' shop
healthy
$ docker exec shop id
uid=10001(app) gid=999(app) groups=999(app)
$ docker stop shop          # остановился за 0 с, код выхода 0
```

## Docker Compose

База, шаг схемы и приложение. Схема применяется отдельным контейнером до
старта приложения ([Шаг схемы](single-executable.md#шаг-схемы)), пароль —
файл секрета:

```yaml
x-app: &app
  build: .
  image: shop:local
  environment: &app-env
    BAZIS_DB__HOST: db
    BAZIS_DB__PORT: "5432"
    BAZIS_DB__DATABASE: shop
  secrets: [BAZIS_DB__PASSWORD]

services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: shop
      POSTGRES_PASSWORD_FILE: /run/secrets/BAZIS_DB__PASSWORD
    secrets: [BAZIS_DB__PASSWORD]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 2s
    volumes: [db-data:/var/lib/postgresql/data]

  schema:
    <<: *app
    environment:
      <<: *app-env
      BAZIS_SCHEMA_ONLY: "1"
    depends_on:
      db: { condition: service_healthy }

  app:
    <<: *app
    ports: ["8080:8080"]
    stop_grace_period: 20s
    depends_on:
      schema: { condition: service_completed_successfully }

secrets:
  BAZIS_DB__PASSWORD:
    file: ./db_password.txt

volumes:
  db-data:
```

```sh
docker compose up -d --build --wait app
```

```text
 Container shop-schema-1 Exited
 Container shop-db-1 Healthy
 Container shop-app-1 Healthy

schema-1  | [orm:schema] applied 2 operation(s): create table orders, create unique index ix_orders_email on orders (email)
schema-1  | info: schema only: infrastructure and schema are ready, stopping (BAZIS_SCHEMA_ONLY) {"hostedServices":2,"startupMs":40.6}
```

- Compose кладёт секрет в `/run/secrets/<имя>`; имя `BAZIS_DB__PASSWORD`
  совпадает с переменной, поэтому `secretFilesSource` находит его без
  настройки. Тот же файл читает и PostgreSQL (`POSTGRES_PASSWORD_FILE`).
- `schema` выходит с кодом 0, и только тогда стартует `app`. Если схему
  применить не удалось, приложение не запустится.
- `stop_grace_period: 20s` — больше срока остановки приложения (10
  секунд), чтобы Docker не прервал её `SIGKILL`
  ([Срок остановки](graceful-shutdown.md#срок-остановки)).
- `db_password.txt` не должен попадать ни в git, ни в образ: добавьте его
  в `.gitignore` и `.dockerignore`.

## Дальше

- [Плавная остановка и health](graceful-shutdown.md)
- [Платформы](platforms.md)
- [Настройка продакшена](production.md)
