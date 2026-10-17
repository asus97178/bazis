# Версии и выпуски

## Номер версии

bazis следует [Semantic Versioning](https://semver.org). До версии 1.0:
- минорная версия (`0.100.0`) может содержать ломающие изменения;
- патч (`0.100.8`) — исправления.

В ветке 0.100 ломающие изменения дважды выходили в патчах: 0.100.4 и
0.100.7. Каждое из них — в разделе **Changed (breaking)** файла
[CHANGELOG](https://github.com/asus97178/bazis/blob/main/CHANGELOG.md), с
тем, что и как поменять. Перед обновлением прочитайте этот раздел у всех
версий между вашей и новой — сводка в главе
[Обновление между версиями](upgrading.md).

## Где выходят

- Пакет — [`bazis` в npm](https://www.npmjs.com/package/bazis).
- Каждая версия — тег `vX.Y.Z` в
  [репозитории](https://github.com/asus97178/bazis); пакет публикуется из
  GitHub Actions по тегу, с подписью происхождения (npm provenance).
- Что изменилось — [CHANGELOG](https://github.com/asus97178/bazis/blob/main/CHANGELOG.md),
  по-английски.

## Требования

| Что | Версия |
| --- | --- |
| Bun | 1.4.0 и новее |
| TypeScript | 5.9.3, 6 или 7. С TypeScript 7 нужен ещё `@typescript/typescript6`: кодогенерации нужен API компилятора ([`BAZIS_TYPESCRIPT_API_MISSING`](errors/codegen.md#bazis_typescript_api_missing)) |
| Node.js | Не нужен: пакет поставляется исходниками TypeScript и работает на Bun |

## Какая версия установлена

Шапка любой команды CLI:

```text
  █▀▀▄ █▀▀█ ▄▀▀  ░█░ ▀▀▀█    bazis 0.100.8 · bun 1.4.0
```

Или:

```sh
bun pm ls | grep bazis
```

```text
├── bazis@0.100.8
```

Флага `bazis --version` нет.

## Как обновиться

```sh
bun add bazis@latest
bunx bazis test
```

`bazis test` обновит сгенерированный код и запустит тесты. Если
появились ошибки — сверьтесь с [обновлением между версиями](upgrading.md)
и [справочником ошибок](errors/README.md).

## Дальше

- [Обновление между версиями](upgrading.md)
- [Установка](../introduction/installation.md)
