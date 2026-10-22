# Платформы

Где запускается исполняемый файл, как собрать его под Linux с Mac и как
запустить под systemd. Kubernetes — в главе
[Плавная остановка и health](graceful-shutdown.md#kubernetes), Docker — в
главе [Docker](docker.md).

Все примеры проверены на bazis 0.111.2 и macOS на Apple Silicon, раздел
systemd — на 0.100.2, Debian 12 (systemd 252).

## Где работает файл

`bazis build --bin` собирает файл для системы и архитектуры, на которой
идёт сборка. Файл, собранный на Linux, — обычная программа для glibc:

```text
ELF 64-bit LSB executable, ARM aarch64, dynamically linked,
  interpreter /lib/ld-linux-aarch64.so.1, for GNU/Linux 3.7.0
```

| Система | Работает? |
| --- | --- |
| Debian, Ubuntu и другие Linux с glibc | Да |
| Alpine и другие Linux с musl | Нет: `exec /shop: no such file or directory` — нет загрузчика glibc |
| macOS | Да, если собрано на macOS |

Архитектура тоже должна совпадать: файл с Mac на Apple Silicon — для
`arm64`, для сервера `x86_64` собирайте на `x86_64`.

## Linux-файл с Mac

`--platform` собирает файл для другой платформы прямо на Mac:

```sh
bunx bazis build --bin --platform linux-x64
```

```text
  [OK  ]  compile         bin/shop-linux-x64 · 80.4 MB                                    138 ms
    ✔  SUCCESS   executable is ready · bin/shop-linux-x64

$ file bin/shop-linux-x64
bin/shop-linux-x64: ELF 64-bit LSB executable, x86-64, … for GNU/Linux 3.2.0
```

| `--platform` | Для чего |
| --- | --- |
| `linux-x64`, `linux-arm64` | Linux с glibc: Debian, Ubuntu, RHEL |
| `linux-x64-musl`, `linux-arm64-musl` | Alpine |
| `darwin-arm64`, `darwin-x64` | macOS |
| `windows-x64` | Windows (bazis на нём не проверялся) |

К имени можно добавить `-baseline` (старые процессоры x64 без AVX2) или
`-modern`. Файл по умолчанию — `bin/<имя>-<платформа>`, локальная сборка
`bin/<имя>` остаётся. При первой сборке под платформу Bun скачивает её
рантайм (около 40 МБ) и кладёт в свой кэш.

> [!NOTE]
> `--platform` — с версии 0.107.0. Раньше Linux-файл с Mac получали только
> через Docker, как ниже.

Ещё способ — сборочный этап из главы [Docker](docker.md): он даёт
Linux-файл, его можно забрать из образа:

```sh
docker build --target build -t shop-build .
id=$(docker create shop-build)
docker cp "$id":/app/bin/shop ./shop-linux
docker rm "$id"
```

Файл собран под архитектуру Docker на вашей машине — на Apple Silicon это
`aarch64`.

## systemd

```ini
# /etc/systemd/system/shop.service
[Unit]
Description=Shop API
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/shop/shop
DynamicUser=yes
Environment=BAZIS_ENV=production HOST=0.0.0.0 PORT=8080
EnvironmentFile=/etc/shop/shop.env
Restart=on-failure
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```sh
# /etc/shop/shop.env — только для root
BAZIS_DB__HOST=db.internal
BAZIS_DB__PASSWORD=…
```

```sh
sudo chmod 600 /etc/shop/shop.env
sudo systemctl daemon-reload
sudo systemctl enable --now shop
```

- **`DynamicUser=yes`** — systemd запускает приложение от временного
  пользователя без прав (`shop`), не от root.
- **`EnvironmentFile`** читает systemd от root до смены пользователя,
  поэтому файл с паролем может быть доступен только root.
- **`TimeoutStopSec=20`** — больше срока остановки приложения (10
  секунд): systemd не прервёт её раньше времени.
- **`Restart=on-failure`** перезапускает приложение после падения, но не
  после штатной остановки.

Журнал — в journald:

```text
$ journalctl -u shop -o cat
Started shop.service - Shop API.
info: bazis started {"environment":"production","debug":false,"configKeys":3,…,"startupMs":136.4}
info: GET /health 200 5.0ms {"method":"GET","path":"/health","status":200,"durationMs":4.95}
Stopping shop.service - Shop API...
info: bazis stopped {"signal":"SIGTERM","exitCode":0,"shutdownMs":1.2}
shop.service: Deactivated successfully.
Stopped shop.service - Shop API.
```

Падение процесса — перезапуск через 2 секунды:

```text
shop.service: Main process exited, code=killed, status=9/KILL
shop.service: Scheduled restart job, restart counter is at 1.
info: bazis started {…}
```

Обновление — заменить файл и `sudo systemctl restart shop`.

## Дальше

- [Один исполняемый файл](single-executable.md)
- [Docker](docker.md)
- [Плавная остановка и health](graceful-shutdown.md)
- [Настройка продакшена](production.md)
