# `bazis/core/testing`

Тесты приложения. Список — по пакету 0.141.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `startTestApp(Application, options)` | Запускает объявленное `@App` приложение в процессе теста: окружение `test`, свободный порт, без сигналов и экрана запуска. Принимает и отдельный модуль. `app.fetch(path)`, `app.use(Service, work)`, `app.container`, `app.stop()` | [Приложение целиком: `startTestApp`](../../fundamentals/testing.md#приложение-целиком-starttestapp) |
| `createTestContainer(Module, options)` | Контейнер модуля (или класса с `@App`: тогда с его `infra`, `cache`, `config`) для теста сервисов со службами ядра, без запуска; `overrides` — замены, `configure` — настройка ядра | [Модуль: `createTestContainer`](../../fundamentals/testing.md#модуль-createtestcontainer) |
| `TestApp`, `TestAppOptions` | Типы: запущенное приложение и его опции (поля `@App`, которые тест меняет, плюс `overrides`) | там же |
| `TestContainerOptions` | Тип опций `createTestContainer`: `overrides` и `configure` | там же |
