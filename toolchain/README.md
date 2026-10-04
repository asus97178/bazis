# Запуск с закреплённым Bun

Версия, revision, SHA-256 бинарника и поддерживаемая macOS заданы в
[bun.json](bun.json). Текущая версия — Bun 1.4.0. Проверка не устанавливает и не
обновляет runtime.

Укажи абсолютный путь к существующему исполняемому файлу этой версии. Это должен
быть сам бинарник, а не символьная ссылка:

Рекомендуемое постоянное место — `~/.osnova/toolchain/bun-1.4.0/bun` (права 0755:
с read-only бинарником `bun build --compile` оставляет `.bun-build` в каталоге),
переменная — в `~/.zshenv`, чтобы её видели и неинтерактивные шеллы. Не храните
бинарник в `/private/tmp`: macOS очищает его при перезагрузке.

```sh
export OSNOVA_BUN_BIN=/absolute/path/to/bun
./scripts/osnova-bun run toolchain:check
./scripts/osnova-bun run di:generate --target all
./scripts/osnova-bun test --isolate src/osnova/core/di/test
./scripts/osnova-bun node_modules/typescript/bin/tsc --noEmit
```

Команды запускаются из корня проекта. Launcher проверяет бинарник до исполнения,
создаёт временную копию и использует её также для дочерних команд `bun`.
Несовпадение версии, хеша или macOS останавливает запуск с диагностикой
`OSNOVA_BUN_*`. Обычный `bun run` использует Bun из PATH, который может отличаться
от закреплённого.

Копия помечается флагом `uchg`. `bun build --compile` клонирует исполняемый файл
во временный `.<hash>.bun-build` в текущем каталоге; клон наследует флаг, и Bun
не может его удалить. Поэтому `build:bin:*` компилируют через
[scripts/build-bin.ts](../scripts/build-bin.ts) из временного каталога и удаляют его.
Прямой `./scripts/osnova-bun build --compile` в checkout оставит около 60 МБ мусора;
убрать его можно так: `chflags nouchg .*.bun-build && rm .*.bun-build`.

При `SIGINT`, `SIGTERM`, `SIGHUP` или `SIGQUIT` launcher передаёт первый сигнал
дочернему процессу и ждёт завершения до 15 секунд. Это даёт запас относительно
стандартного `KernelOptions.shutdownTimeoutMs = 10000`. Затем зависший процесс
получает `SIGKILL`; временная копия runtime удаляется после завершения процесса.
Код выхода после сигнала сохраняется: например, 143 для `SIGTERM`.

Если приложение задаёт больший shutdown timeout, увеличь и бюджет launcher:

```sh
OSNOVA_BUN_SHUTDOWN_TIMEOUT_MS=35000 ./scripts/osnova-bun run start
```

`OSNOVA_BUN_SHUTDOWN_TIMEOUT_MS` — необязательная строка из десятичных цифр,
целое от 1 до 2147483647 миллисекунд без ведущих нулей; default — `15000`.
Некорректное значение останавливает запуск с
`OSNOVA_BUN_SHUTDOWN_TIMEOUT_INVALID` до создания дочернего процесса.
Ожидание проверяется с шагом 100 мс, значение округляется вверх до этого шага.
Значение выбирается больше бюджета kernel; launcher не читает конфигурацию
приложения. `shutdownTimeoutMs = 0` отключает предел kernel, но не launcher.
После обновления настройка не нужна для стандартного shutdown: прежний предел
launcher около 500 мс заменён на 15 секунд.
