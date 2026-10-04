# От нового проекта до бинарника

Osnova использует TypeScript, Bun, DI, DbContext и контроллеры с декораторами.
Зависимости конструкторов и привязки HTTP-параметров выводит codegen перед запуском.
Для разработчика C# ближайшие знакомые понятия — DI scope, EF DbContext и
контроллеры ASP.NET. ORM-условия в Osnova строятся методами, без LINQ expression trees.

## 1. Создать приложение

В checkout фреймворка используйте квалифицированный Bun из
[toolchain](../toolchain/bun.json). Команды ниже предполагают, что OSNOVA_BUN_BIN
уже указывает на проверенный исполняемый файл.

```sh
./scripts/osnova-bun run toolchain:check
./scripts/osnova-bun run osnova new MyApp --path ../my-app
cd ../my-app
"$OSNOVA_BUN_BIN" install
"$OSNOVA_BUN_BIN" run dev
```

Пустой backend слушает `http://127.0.0.1:3000`; GET `/health` проверяет запуск.
При занятом порте задайте `PORT=3100`. Для этого проекта БД и LLM не нужны.
Пример приложения в исходном checkout имеет отдельные требования к инфраструктуре.

CLI копирует пакет в `vendor/osnova`. Добавьте этот каталог в Git вместе с
приложением: после переноса исходный checkout не требуется. Это снимок версии;
изменения фреймворка автоматически не подтягиваются. `--link-framework` оставляет
живую связь с внешним checkout для совместной разработки. Собранный CLI вне
checkout принимает `--framework /absolute/path/to/src/osnova`.

## 2. Добавить функцию

Из корня нового приложения:

```sh
"$OSNOVA_BUN_BIN" run osnova g module Task --empty
```

CLI создаст `Task.module.ts`, `MODULE.md` и подключит модуль в `AppModule`.
До реализации заполните ответственность и входы в паспорте. Одна функция может
содержать модель, сервис, контроллер и фоновые обработчики. Составной модуль
нужен для самостоятельных функций: `g pack Catalog --parts items,categories`.
Полный пример контроллера без БД: [HTTP README](../src/osnova/core/http/README.md).

Для учебного CRUD есть `g module Guest --minimal`: десять файлов, включая
модель, DbContext, сервис, контроллер, ListQuery и паспорт. Его запуск требует
provider БД и готовой схемы. `--full` дополнительно требует auth/cache/background/AI
инфраструктуру host; это расширенный пример, а не старт без зависимостей.

## 3. Границы API

- Сервис объявляет зависимости в конструкторе; обычная регистрация —
  `scoped(IService, Service)`. Codegen выводит зависимости без ручного массива.
- Сервис списка возвращает `PageResult<T>`: `items` и `total`. Контроллер формирует
  JSON:API `data/meta/links` и берёт путь из `HttpContext.path`.
- CLI-списки через HTTP возвращают 20 записей по умолчанию, максимум 100;
  `summary()` возвращает полный count и не более 20 имён.
- `DbContext.saveChanges()` сохраняет все накопленные изменения своего контекста.
  `IRepository.saveChanges()` имеет ту же область сохранения.
- ORM: `u => u.age.gte(18).and(u.name.startsWith("A"))`. `&&`, `||`, `!` над
  Predicate останавливают codegen; неверный тип сравнения отклоняет TypeScript.
  Ручной запуск JS/any без этих проверок не даёт такой защиты.

## 4. Проверить и собрать

```sh
"$OSNOVA_BUN_BIN" run di:generate
"$OSNOVA_BUN_BIN" run build
"$OSNOVA_BUN_BIN" run build:bin
./bin/my-app
```

`dev` и `build` сами запускают codegen. Его файлы в `src/generated` не редактируют
вручную. Ошибка `OSNOVA_HTTP_BINDING_UNRESOLVED` означает, что сигнатура action
не позволяет определить источник аргумента: уточните тип; для заголовков и сырых тел используйте `HttpContext`.
При `OSNOVA_ORM_PREDICATE_LOGIC` замените JS-логику методами `.and/.or/.not`.
Ошибка генерации сохраняет предыдущие outputs и останавливает штатную команду.

Бинарник приложения содержит код и generated metadata. Внешние БД, конфигурация
и явно используемые файлы остаются обязанностью host. Проверяйте запуск бинарника
из другого каталога. Текущая квалификация runtime относится к macOS arm64;
другие платформы требуют отдельной проверки.
