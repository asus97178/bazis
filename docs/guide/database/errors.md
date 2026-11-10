# Ошибки базы данных

Ошибка базы данных приходит в код как класс ORM с понятным сообщением.
Ловить её можно по классу, а HTTP-статус клиенту фреймворк выбирает сам.

Все примеры проверены на bazis 0.109.0 и PostgreSQL 17.

## Какие бывают

| Класс | Когда | Поля |
| --- | --- | --- |
| `UniqueViolationError` | Нарушен уникальный индекс (SQLSTATE 23505) | `constraint`, `table`, `properties`, `conflict` |
| `ForeignKeyViolationError` | Ссылка на несуществующую строку или удаление строки, на которую ссылаются (23503) | `constraint`, `table` |
| `CheckViolationError` | Нарушено условие `@Check` (23514) | `constraint`, `table` |
| `NotNullViolationError` | `NULL` в обязательный столбец (23502) | `column`, `table` |
| `LockTimeoutError` | Блокировка не получена за `lockTimeoutMs` (55P03) | — |
| `OrmValidationError` | Правило `@Validator` сущности не выполнено, до SQL | `entityName`, `errors` |
| `EntityNotFoundError` | `first()` не нашёл строку | — |
| `TransactionOutcomeUnknownError` | База не ответила: неизвестно, записались ли данные | `phase` |
| `OrmTransactionScopeError` | Тайм-аут или отмена [транзакции](transactions.md) | — |

Первые пять — подклассы `DbUpdateError` (кроме `LockTimeoutError`, он
наследует `OrmError`). Исходная ошибка драйвера лежит в `error.cause`.
Сообщения называют ограничение или столбец, но **не** значения строк:

```text
UniqueViolationError: Unique constraint "ix_categories_name" violated.
ForeignKeyViolationError: Foreign key constraint "fk_products_categoryId" violated: the row refers to a missing row, or a row that other rows refer to was deleted.
CheckViolationError: Check constraint "ck_products_price" violated.
NotNullViolationError: Column "title" of table "products" does not accept NULL.
```

Они приходят из любой операции контекста: `saveChanges()`, запросов,
[немедленных изменений](immediate.md) и сырого SQL через `db.database`.
Остальные ошибки PostgreSQL — синтаксис SQL, нет таблицы — приходят как
`PostgresError` драйвера.

> [!NOTE]
> `ForeignKeyViolationError`, `CheckViolationError`, `NotNullViolationError`
> и `LockTimeoutError` — с версии 0.98.25. Раньше вместо них приходил
> сырой `PostgresError`.

## Обработка в коде

```ts
import { UniqueViolationError } from "bazis/core/orm";
import { HttpError } from "bazis/core/http";

async register(email: string) {
  this.db.users.add(Object.assign(new User(), { email }));
  try {
    await this.db.saveChanges();
  } catch (error) {
    if (error instanceof UniqueViolationError && error.constraint === "ix_users_email") {
      throw new HttpError(409, "This email is already registered");
    }
    throw error;
  }
}
```

После неудачного `saveChanges()` изменения остаются в контексте
([Сохранение](saving.md#если-сохранение-не-удалось)): исправьте данные и сохраните
снова, или возьмите новый контекст.

Своему коду, который ловит ошибки драйвера сам, поможет
`translateDatabaseError(error)`: он превратит известный SQLSTATE в класс
выше, а остальное вернёт как есть.

## HTTP-статусы

Приложение с базой отвечает на ошибку базы по смыслу само, настраивать ничего не нужно:

| Ошибка | Статус |
| --- | --- |
| `UniqueViolationError`, `ForeignKeyViolationError` | `409 Conflict` |
| `CheckViolationError`, `NotNullViolationError`, `OrmValidationError` | `422 Unprocessable Content` |
| `EntityNotFoundError` | `404 Not Found` |
| База не ответила, тайм-аут операции, транзакции или блокировки, deadlock, конфликт сериализации | `503 Service Unavailable` |
| Остальное | `500 Internal Server Error` |

Клиент получает название статуса — имена таблиц и ограничений наружу не уходят:

```text
POST /products    →  422 {"error":"Unprocessable Content"}
GET  /report      →  503 {"error":"Service Unavailable"}
```

- `4xx` **не** пишутся в лог как неожиданные: это ошибка клиента, а не сервера. `5xx` логируются как раньше.
- Свой статус для своих ошибок задаёт `errorHandler.status`, функция `(error) => number | undefined`:

  ```ts
  errorHandler: { status: (error) => error instanceof PaymentDeclinedError ? 402 : undefined }
  ```

- Свой ответ целиком, с текстом и `details`, задаёт `errorHandler.map`: `(error) => HttpError | undefined`.
  Модуль может зарегистрировать такую функцию сам, токеном `HTTP_ERROR_MAPPER`.

### Занятое значение

Нарушение уникального индекса отвечает `409` и называет свойства индекса. Текст для клиента задаёт сам индекс:

```ts
@Index({ unique: true, conflict: "This email is already registered" })
@Column({ type: "text" })
email = "";
```

```text
POST /users  →  409 {"error":"This email is already registered","details":{"code":"unique","fields":["email"]}}
```

Без `conflict` текст — `Conflict`, `details` те же. Поэтому ловить `UniqueViolationError` в сервисе ради ответа
не нужно: индекс решает и под нагрузкой, когда два запроса пришли одновременно. В коде у ошибки есть
`properties` (свойства индекса или ключа) и `conflict`; они заполнены, когда запрос шёл через контекст с этой сущностью.

> [!NOTE]
> Автоматические статусы, `conflict` у индекса и `errorHandler.map` — с версии 0.137.0. До неё статусы
> подключали вручную: `errorHandler: { status: databaseErrorStatus }`. Функция `databaseErrorStatus` осталась
> для своего кода, которому нужен только номер статуса.

## Тайм-ауты и недоступная база

Каждая операция ограничена `operationTimeoutMs`
([Подключение PostgreSQL](postgresql.md)). Если база не ответила вовремя —
упала, перегружена, недоступна по сети — запрос отменяется:

```text
TransactionOutcomeUnknownError: The database did not answer a statement sent outside a transaction: ORM operation
timed out after 5000 ms. If the statement changed data, its outcome is unknown: check the data and use a new
DbContext before saving again.
```

Запрос вне транзакции мог что-то записать, поэтому ORM не повторяет его сам
и закрывает этот контекст для дальнейшей работы. В HTTP-запросе это не
мешает: следующий запрос получит новый контекст. Внутри
`transactionScope` то же самое выглядит так:

```text
OrmTransactionScopeError: ORM transaction scope timed out after 5000 ms.
```

Блокировка, которую держит другая транзакция дольше `lockTimeoutMs`:

```text
LockTimeoutError: A lock was not granted within lockTimeoutMs: another transaction holds the row or table. Retry the
operation, or shorten the transaction that holds the lock.
```

Обрыв соединений пул переживает сам: следующий запрос откроет новое
соединение. Пока база недоступна, `/health` отвечает `503`
(`"infra:db","healthy":false`), а после её возврата всё работает без
перезапуска приложения.

## Дальше

- [Транзакции](transactions.md)
- [Сохранение и отслеживание изменений](saving.md)
- [Подключение PostgreSQL](postgresql.md)
- [Обработка ошибок](../overview/errors.md)
