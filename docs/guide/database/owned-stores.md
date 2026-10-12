# Owned stores

Owned store — это **набор таблиц, которыми модуль владеет единолично**. bazis
закрепляет таблицы с общим префиксом за модулем и не даёт их трогать никому
другому: ни другим модулям, ни изменениям «на месте».

Нужно это авторам переиспользуемых модулей, которые подключают в чужие
приложения: модуль сам создаёт свои таблицы и уверен, что приложение их не
испортило. Обычному приложению хватает
[`ensureCreated`](schema.md).

Все примеры проверены на bazis 0.98.23 и PostgreSQL 17.

## Объявление

```ts
import { Module } from "bazis/core/di";
import { Column, DbContext, Entity, Key, defineOrmOwnedStoreV1 } from "bazis/core/orm";

@Entity({ table: "notes_items" })
export class Note {
  @Key() id = 0;
  @Column({ type: "text" }) text = "";
}

export class NotesDbContext extends DbContext {
  readonly notes = this.set(Note);
}

export const notesStore = defineOrmOwnedStoreV1({
  contract: "bazis.orm-owned-store/v1",
  storeKey: "acme.notes",                                   // имя хранилища
  formatVersion: 1,                                         // версия формата
  ownedScope: { schema: "public", tablePrefix: "notes_" },  // «все таблицы notes_* мои»
});

@Module({ ormBazis: { context: NotesDbContext, entities: [Note], ownedStore: notesStore } })
export class NotesModule {}
```

- Хранилище работает через общее подключение из `@Infra`
  (`ormBazisConnect`), как остальные контексты.
- `ensureCreated`, `migrateOnStart` и миграции рядом с `ownedStore` не
  нужны: хранилище само создаёт и проверяет таблицы. С ними модуль не
  объявится:

  ```text
  OrmError: ORM owned store creates and verifies its own tables; remove ensureCreated, migrateOnStart and migrations from this ormBazis entry.
  ```

- С контекстом хранилища работают как с любым `DbContext`: запросы,
  `saveChanges`, транзакции.

## Первый запуск

bazis создаёт таблицы хранилища и записывает его «паспорт» в служебную
таблицу `__bazis_orm_owned_stores_v1`:

```text
 store_key  | format_version | table_prefix
------------+----------------+--------------
 acme.notes |              1 | notes_
```

В паспорте ещё лежат отпечатки модели и области. При каждом следующем
запуске bazis сверяет с ним базу **точно**: столбцы, ключи, индексы и их
имена. Совпало — приложение стартует. Нет — не стартует.

## Правила области

- **Все таблицы хранилища начинаются с префикса.** Таблица вне области:

  ```text
  ORM_OWNED_STORE_OWNERSHIP_CONFLICT: Owned store "acme.notes" (schema "public", prefix "notes_"): entity table
  "public"."outside_items" lies outside the store scope; name its tables with the prefix, for example "notes_outside_items".
  ```

- **Внешние ключи — только на таблицы своего хранилища.**
- **Чужим контекстам таблицы хранилища недоступны.** Другой контекст с той
  же сущностью:

  ```text
  ORM_OWNED_STORE_OWNERSHIP_CONFLICT: OtherDb maps table "public"."notes_items", which belongs to owned store
  "acme.notes"; only the store's own context may map it.
  ```

- **Области не пересекаются.** Два префикса пересекаются, если один
  начинается с другого: `notes_` и `notes_v2_` пересекаются, `notes_` и
  `notesv2_` — нет.
- **В области не должно быть посторонних таблиц.** Если таблица `notes_items`
  уже есть, но хранилище её не создавало:

  ```text
  ORM_OWNED_STORE_IDENTITY_MISSING: Owned store "acme.notes" (schema "public", prefix "notes_") is not registered yet,
  but its scope already contains tables that no owned store registered: "notes_items". Remove them, or choose another tablePrefix.
  ```

Несколько хранилищ в одном модуле — массив в `ormBazis`:

```ts
@Module({
  ormBazis: [
    { context: NotesDbContext, entities: [Note], ownedStore: notesStore },
    { context: TagsDbContext, entities: [Tag], ownedStore: tagsStore },
  ],
})
```

## Хранилище не меняется на месте

Любое изменение модели — новый столбец, индекс, другое имя ключа, другая
`formatVersion` — останавливает запуск:

```text
ORM_OWNED_STORE_IDENTITY_MISMATCH: Owned store "acme.notes" (schema "public", prefix "notes_"): its model changed
since the store was created (tables, columns, keys, indexes or their names). An owned store does not change in place:
declare a new storeKey with a tablePrefix that does not overlap the old one, move the data, then drop the old tables
and their row in __bazis_orm_owned_stores_v1 (rejectIfPresent can guard against leftovers).
```

Миграций для хранилищ нет. Новая версия — **новое хранилище**.

### Переход на новую версию

1. **Объявите новое хранилище рядом со старым.** Новый `storeKey` и
   префикс, который **не пересекается** со старым. Оба хранилища
   запускаются вместе, и bazis создаёт таблицы новой версии:

   ```ts
   export const notesStoreV2 = defineOrmOwnedStoreV1({
     contract: "bazis.orm-owned-store/v1",
     storeKey: "acme.notes.v2",
     formatVersion: 1,
     ownedScope: { schema: "public", tablePrefix: "notesv2_" },
   });

   @Module({
     ormBazis: [
       { context: NotesDbContext, entities: [Note], ownedStore: notesStore },
       { context: NotesV2DbContext, entities: [NoteV2], ownedStore: notesStoreV2 },
     ],
   })
   export class NotesModule {}
   ```

2. **Перенесите данные и уберите старое хранилище** одной транзакцией:

   ```sql
   BEGIN;
   INSERT INTO notesv2_items (id, text, tag) SELECT id, text, NULL FROM notes_items;
   SELECT setval(pg_get_serial_sequence('notesv2_items', 'id'), (SELECT max(id) FROM notesv2_items));
   DROP TABLE notes_items;
   DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key = 'acme.notes';
   COMMIT;
   ```

   `setval` обязателен, если переносите ключи `@Key() id`: без него счётчик
   останется на 1, и следующая вставка упадёт с
   `duplicate key value violates unique constraint "pk_notesv2_items"`.

3. **Уберите старое хранилище из модуля** и добавьте в новое
   `rejectIfPresent` со старой областью. Добавить его можно и позже: паспорт
   хранилища от этого не меняется.

   ```ts
   export const notesStoreV2 = defineOrmOwnedStoreV1({
     // …как выше
     rejectIfPresent: [{ schema: "public", tablePrefix: "notes_" }],
   });
   ```

   Это страховка: если на каком-то стенде старые таблицы остались
   (забыли выполнить шаг 2), приложение там не запустится:

   ```text
   ORM_OWNED_STORE_OWNERSHIP_CONFLICT: Owned store "acme.notes.v2" (schema "public", prefix "notesv2_") does not start
   while tables of the rejected scope (schema "public", prefix "notes_") exist: "notes_items". Move their data and drop
   them, together with their row in __bazis_orm_owned_stores_v1.
   ```

## Что не попадает в сообщения

Ошибки хранилища называют ключ, область и таблицы, но **не** значения из
строк и не текст драйвера. Имена, прочитанные из базы, экранируются и
обрезаются. Объект в области с необычным именем или определением bazis не
читает и в сообщении не повторяет:

```text
ORM_OWNED_STORE_DRIFT: Owned store "acme.notes" (schema "public", prefix "notes_"): the store scope contains an object
bazis does not expect there (for example a table with an unusual name or definition, or one created by another tool),
so it was not read. Remove such objects from the scope.
```

> [!NOTE]
> Пояснения в сообщениях — с версии 0.98.23. Раньше сообщение состояло
> только из кода: `ORM_OWNED_STORE_IDENTITY_MISMATCH`.

## Ошибки

Класс всех ошибок — `OrmOwnedStoreAdmissionError`, код — в `error.code`, и
сообщение начинается с него.

| Код | Когда |
| --- | --- |
| `ORM_OWNED_STORE_IDENTITY_MISMATCH` | Модель, версия формата или область отличаются от паспорта; неверное описание в `defineOrmOwnedStoreV1` |
| `ORM_OWNED_STORE_IDENTITY_MISSING` | В области есть таблицы, которые хранилище не создавало |
| `ORM_OWNED_STORE_OWNERSHIP_CONFLICT` | Таблица вне префикса, пересечение областей, остатки `rejectIfPresent`, чужой контекст на таблице хранилища |
| `ORM_OWNED_STORE_DRIFT` | Таблицы области изменены снаружи, или в области есть объект, который bazis не читает |
| `ORM_OWNED_STORE_CREATE_FAILED` | Не удалось создать таблицы (например, нет прав `CREATE`) |
| `ORM_OWNED_STORE_LOCK_UNAVAILABLE` | Запуск прерван: связь с базой, отмена, долгая блокировка другим экземпляром |
| `ORM_OWNED_STORE_PROVIDER_UNSUPPORTED` | Не PostgreSQL или не общее подключение из `@Infra` |

## Дальше

- [Управление схемой](schema.md)
- [`DbContext` и `DbSet`](dbcontext.md)
- [Транзакции](transactions.md)
