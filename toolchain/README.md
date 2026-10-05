# Запуск с закреплённым Bun

Версия, revision, SHA-256 бинарника и квалифицированные хосты заданы в
[bun.json](bun.json). Текущая версия — Bun 1.4.0. Проверка не устанавливает и не
обновляет runtime.

| Хост | Что закреплено |
| --- | --- |
| macOS arm64 | точная версия и сборка ОС (26.5.2 / 25F84) и SHA-256 бинарника |
| Linux arm64, Linux x64 | glibc (не musl/Alpine) и SHA-256 официального `bun-linux-*.zip`; дистрибутив задаёт образ |

На Linux копия Bun защищена правами 0500 в приватном каталоге 0700: флага
неизменяемости, доступного обычному пользователю, там нет. Архивы Linux сверены с
`SHASUMS256.txt` релиза; подпись `SHASUMS256.txt.asc` не проверялась.
Квалификация Linux (2026-10-05): полный набор тестов в `debian:bookworm-slim`
(arm64) и job `linux` на GitHub-hosted `ubuntu-latest` (x64). Тестам Codex и
gRPC TLS нужны `python3` и `openssl` в окружении.

Укажи абсолютный путь к существующему исполняемому файлу этой версии. Это должен
быть сам бинарник, а не символьная ссылка:

Рекомендуемое постоянное место — `~/.osnv/toolchain/bun-1.4.0/bun` (права 0755:
с read-only бинарником `bun build --compile` оставляет `.bun-build` в каталоге),
переменная — в `~/.zshenv`, чтобы её видели и неинтерактивные шеллы. Не храните
бинарник в `/private/tmp`: macOS очищает его при перезагрузке.

```sh
export OSNV_BUN_BIN=/absolute/path/to/bun
./scripts/osnv-bun run toolchain:check
./scripts/osnv-bun run di:generate --target all
./scripts/osnv-bun test --isolate src/osnv/core/di/test
./scripts/osnv-bun node_modules/typescript/bin/tsc --noEmit
```

Команды запускаются из корня проекта. Launcher проверяет бинарник до исполнения,
создаёт временную копию и использует её также для дочерних команд `bun`.
Несовпадение версии, хеша или macOS останавливает запуск с диагностикой
`OSNV_BUN_*`. Обычный `bun run` использует Bun из PATH, который может отличаться
от закреплённого.

Копия помечается флагом `uchg`. `bun build --compile` клонирует исполняемый файл
во временный `.<hash>.bun-build` в текущем каталоге; клон наследует флаг, и Bun
не может его удалить. Поэтому `build:bin:*` компилируют через
[scripts/build-bin.ts](../scripts/build-bin.ts) из временного каталога и удаляют его.
Прямой `./scripts/osnv-bun build --compile` в checkout оставит около 60 МБ мусора;
убрать его можно так: `chflags nouchg .*.bun-build && rm .*.bun-build`.

При `SIGINT`, `SIGTERM`, `SIGHUP` или `SIGQUIT` launcher передаёт первый сигнал
дочернему процессу и ждёт завершения до 15 секунд. Это даёт запас относительно
стандартного `KernelOptions.shutdownTimeoutMs = 10000`. Затем зависший процесс
получает `SIGKILL`; временная копия runtime удаляется после завершения процесса.
Код выхода после сигнала сохраняется: например, 143 для `SIGTERM`.

Если приложение задаёт больший shutdown timeout, увеличь и бюджет launcher:

```sh
OSNV_BUN_SHUTDOWN_TIMEOUT_MS=35000 ./scripts/osnv-bun run start
```

`OSNV_BUN_SHUTDOWN_TIMEOUT_MS` — необязательная строка из десятичных цифр,
целое от 1 до 2147483647 миллисекунд без ведущих нулей; default — `15000`.
Некорректное значение останавливает запуск с
`OSNV_BUN_SHUTDOWN_TIMEOUT_INVALID` до создания дочернего процесса.
Ожидание проверяется с шагом 100 мс, значение округляется вверх до этого шага.
Значение выбирается больше бюджета kernel; launcher не читает конфигурацию
приложения. `shutdownTimeoutMs = 0` отключает предел kernel, но не launcher.
После обновления настройка не нужна для стандартного shutdown: прежний предел
launcher около 500 мс заменён на 15 секунд.
