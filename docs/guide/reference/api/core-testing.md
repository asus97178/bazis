# `bazis/core/testing`

Тесты приложения. Список — по пакету 0.112.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `startTestApp(AppModule, options)` | Запускает приложение в процессе теста: окружение `test`, свободный порт, без сигналов и экрана запуска. `app.fetch(path)`, `app.container`, `app.stop()` | [HTTP: `startTestApp`](../../fundamentals/testing.md#http-starttestapp) |
| `createTestContainer(Module, options)` | Контейнер модуля для теста сервисов со службами ядра, без запуска; `overrides` — замены, `configure` — настройка ядра | [Модуль: `createTestContainer`](../../fundamentals/testing.md#модуль-createtestcontainer) |
| `TestApp`, `TestAppOptions` | Типы: запущенное приложение и его опции (опции `runApp` плюс `overrides`) | там же |
| `TestContainerOptions` | Тип опций `createTestContainer`: `overrides` и `configure` | там же |
