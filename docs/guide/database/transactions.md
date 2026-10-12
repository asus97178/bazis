# Транзакции

Один `saveChanges()` и так выполняется в одной транзакции. Отдельная
транзакция нужна, когда атомарной должна быть **цепочка** действий:
прочитать, проверить, записать, записать ещё. Для этого есть
`db.transactionScope(...)`.

Все примеры проверены на bazis 0.98.18 и PostgreSQL 17.

## Перевод денег

```ts
export class InsufficientFundsError extends Error {}

// providers: [scoped(TransfersService)]
export class TransfersService {
  constructor(private readonly db: BankDb) {}

  transfer(fromId: number, toId: number, amount: number): Promise<number> {
    return this.db.transactionScope(async () => {
      const from = await this.db.accounts.findForUpdate(fromId);
      const to = await this.db.accounts.findForUpdate(toId);
      if (!from || !to) throw new Error("account not found");

      from.balance -= amount;
      to.balance += amount;
      await this.db.saveChanges();
      if (from.balance < 0) throw new InsufficientFundsError();

      this.db.transfers.add(Object.assign(new Transfer(), { fromId, toId, amount }));
      await this.db.saveChanges();
      return from.balance;
    });
  }
}
```

```text
BEGIN
SELECT "id", "owner", "balance" FROM "accounts" WHERE "id" = $1 LIMIT $2 FOR UPDATE
SELECT "id", "owner", "balance" FROM "accounts" WHERE "id" = $1 LIMIT $2 FOR UPDATE
UPDATE "accounts" SET "balance" = $1 WHERE "id" = $2
UPDATE "accounts" SET "balance" = $1 WHERE "id" = $2
INSERT INTO "transfers" ("fromId", "toId", "amount") VALUES ($1, $2, $3) RETURNING "id"
COMMIT
```

- Всё, что контекст делает внутри функции, идёт в одной транзакции:
  запросы, каждый `saveChanges()`, сырой SQL через `db.database`.
- Функция вернула значение — `COMMIT`, и `transactionScope` возвращает
  это значение.
- Функция бросила исключение — `ROLLBACK`, и исключение летит дальше.
  В примере выше при нехватке денег откатятся оба `UPDATE`, хотя
  `saveChanges()` уже прошёл.

## Откат

Откатывает **любое** исключение из функции:

```ts
await this.db.transactionScope(async () => {
  await this.db.database.executeSqlRaw("UPDATE accounts SET balance = balance + {0} WHERE id = {1}", 1, 2);
  throw new Error("undo");
});
// Error: undo — UPDATE отменён
```

Поймать ошибку внутри и «продолжить как ни в чём не бывало» не получится.
После упавшей команды PostgreSQL прерывает всю транзакцию, и ORM помечает
её на откат:

```ts
await this.db.transactionScope(async () => {
  try { await this.db.database.querySqlRaw("SELECT 1/0"); } catch { /* проглотили */ }
  return "ok";
});
```

```text
OrmTransactionScopeError: ORM transaction scope was rolled back because an operation inside it failed:
PostgresError: division by zero. A failed operation marks the whole scope for rollback even when its
error is caught; to continue after an expected failure, run that operation in a nested transactionScope().
```

Исходная ошибка лежит в `error.cause`. Если ошибка ожидаемая и после неё
нужно продолжить, оберните эту операцию во
[вложенный scope](#вложенные-транзакции).

### Изменения после отката остаются в контексте

Откат отменяет изменения в базе, но **не в объектах**. Сущности,
изменённые внутри scope, снова считаются несохранёнными: `Modified`,
а новые — `Added`:

```ts
await this.db.transactionScope(async () => {
  const bob = await this.db.accounts.find(2);
  bob!.balance += 1000;
  await this.db.saveChanges();
  throw new Error("x");
}).catch(() => {});

const bob = await this.db.accounts.find(2);
this.db.stateOf(bob!);        // EntityState.Modified, balance всё ещё +1000
await this.db.saveChanges();  // 1 — и +1000 попадёт в базу!
```

Так контекст честно показывает разницу с базой, и неудачный перевод
можно повторить. Но если повтор не нужен, **не вызывайте `saveChanges()`
у этого контекста**. В HTTP-запросе это обычно и так последнее действие:
ошибка уходит клиенту, а контекст запроса выбрасывается. В фоновой задаче
после отката берите новый контекст.

## Блокировка строк

`findForUpdate(key)` читает строку с `FOR UPDATE`: другая транзакция,
которая хочет ту же строку `FOR UPDATE` или изменить её, **ждёт** до
`COMMIT` или `ROLLBACK`. Так два параллельных перевода с одного счёта не
потратят одни и те же деньги дважды.

Для запроса — `.forUpdate()`:

```ts
const accounts = await this.db.accounts
  .where((a) => a.owner.eq("Ann"))
  .forUpdate()
  .toList();
```

Блокировка живёт до конца транзакции, поэтому вне `transactionScope`
смысла в ней нет:

```text
Error: forUpdate() locks rows only until the surrounding transaction ends; outside a transaction
the lock is released right after the SELECT. Run the read and the following saveChanges() inside
db.transactionScope(async () => { ... }).
```

### Очередь задач: `skipLocked`

Несколько обработчиков разбирают одну таблицу задач. С
`forUpdate({ skipLocked: true })` каждый берёт **свободные** строки и не
ждёт чужие:

```ts
await this.db.transactionScope(async () => {
  const jobs = await this.db.jobs
    .where((j) => j.status.eq("new"))
    .orderBy((j) => j.id)
    .take(2)
    .forUpdate({ skipLocked: true })
    .toList();

  for (const job of jobs) job.status = "done";
  await this.db.saveChanges();
});
// первый обработчик взял задачи 1 и 2, параллельный — 3 и 4
```

```text
SELECT "id", "status" FROM "jobs" WHERE "status" = $1 ORDER BY "id" ASC LIMIT $2 FOR UPDATE SKIP LOCKED
```

`skipLocked` требует:

- активную транзакцию;
- `where(...)`;
- положительный `take(n)` без `skip`;
- `orderBy` по всему первичному ключу;
- `toList()` или `firstOrDefault()` без `select` и `include`.

Иначе ошибка ещё до запроса, например:

```text
Error: FOR UPDATE SKIP LOCKED requires an explicit complete primary-key order.
```

## Вложенные транзакции

`transactionScope` внутри другого `transactionScope` — это `SAVEPOINT`.
Ошибка во вложенном откатывает только его, а внешний может продолжить:

```ts
await this.db.transactionScope(async () => {
  this.db.transfers.add(Object.assign(new Transfer(), { amount: 1 }));
  await this.db.saveChanges();

  try {
    await this.db.transactionScope(async () => {
      await this.db.database.executeSqlRaw("SELECT 1/0");
    });
  } catch {
    // ожидаемая ошибка: откатилась только вложенная часть
  }

  return this.db.accounts.count();   // внешняя транзакция жива
});
```

```text
BEGIN
INSERT INTO "transfers" ("fromId", "toId", "amount") VALUES ($1, $2, $3) RETURNING "id"
SAVEPOINT "bazis_scope_1"
SELECT 1/0
ROLLBACK TO SAVEPOINT "bazis_scope_1"
RELEASE SAVEPOINT "bazis_scope_1"
SELECT COUNT(*) AS count FROM "accounts"
COMMIT
```

Если вложенную ошибку не поймать, она долетит до внешней функции и
откатит всё.

> **Ловушка.** Сущности, которые вложенный scope успел сохранить перед
> откатом, снова становятся `Added`/`Modified`
> ([как и после любого отката](#изменения-после-отката-остаются-в-контексте)).
> Следующий `saveChanges()` во внешнем scope **сохранит их снова**.
> Добавляйте во вложенном scope только то, что готовы записать при
> повторе, или уберите их через `remove()`.

Вложенные scope выполняются по очереди: они работают на одном соединении
со стеком savepoint-ов. Запустить два одновременно нельзя:

```ts
await this.db.transactionScope(() =>
  Promise.all([this.db.transactionScope(...), this.db.transactionScope(...)]));
// ConcurrentTransactionScopeError: Concurrent sibling transaction scopes on one ambient
// connection are not supported; await each scope sequentially.
```

Обычные запросы внутри одного scope параллелить можно:
`Promise.all([db.accounts.count(), db.jobs.count()])` работает.

## Второй контекст в той же транзакции

Транзакция принадлежит контексту, который её начал. Другой контекст
(например, `AuditDb` соседнего модуля) подключается через `tx.use`:

```ts
await this.db.transactionScope(async (tx) => {
  const bob = await this.db.accounts.find(2);
  bob!.balance += 5;
  await this.db.saveChanges();

  await tx.use(this.audit, async (audit) => {
    audit.records.add(Object.assign(new AuditRecord(), { text: "bonus 5" }));
    await audit.saveChanges();
  });
});
// оба изменения — в одной транзакции, откатятся тоже вместе
```

Без `tx.use` второй контекст внутри scope использовать нельзя:

```text
OrmTransactionScopeError: AuditDb is not part of the surrounding transaction scope. Run it through
tx.use(context, work) to share the transaction, or use it after the scope.
```

Общая транзакция возможна, только если у контекстов **один и тот же
объект провайдера** (в приложении это так: все `ormModule` используют
одно подключение из `@Infra`). Иначе:

```text
OrmProviderIdentityMismatchError: AuditDb uses a different database provider than the surrounding
transaction scope. Contexts share one transaction only when they are created with the same provider object.
```

## После коммита: `afterCommit`

Письмо, событие в очередь, сброс кеша нужно делать, только если данные
точно записались. Для этого есть `tx.afterCommit`:

```ts
await this.db.transactionScope(async (tx) => {
  // ... перевод ...
  tx.afterCommit(() => this.mail.send(user, "Перевод выполнен"));
});
```

- Колбэк запускается после `COMMIT`. При откате он не вызывается.
- Колбэк из вложенного scope ждёт `COMMIT` **внешней** транзакции.
- Если колбэк упал, данные уже записаны, а `transactionScope` бросает
  `PostCommitError` (`error.committed === true`, ошибки колбэков — в
  `error.errors`):

```text
PostCommitError: Transaction committed, but 1 afterCommit callback failed.
```

Не повторяйте перевод по такой ошибке: он уже прошёл. Проверка —
`isCommittedOutcome(error)` из `bazis/core/orm`.

## Тайм-аут и отмена

Вся транзакция, включая `COMMIT`, ограничена по времени. По умолчанию
действует `operationTimeoutMs` подключения (30 секунд). Своё значение
задаётся в `timeoutMs`:

```ts
await this.db.transactionScope(async () => {
  await this.db.database.querySqlRaw("SELECT pg_sleep(3)");
}, { timeoutMs: 200 });
```

```text
OrmTransactionScopeError: ORM transaction scope timed out after 200 ms.
```

Выполняющийся запрос отменяется на сервере, транзакция откатывается,
соединение возвращается в пул.

Отменить транзакцию снаружи можно через `signal`:

```ts
const controller = new AbortController();
const work = this.db.transactionScope(async () => { /* ... */ }, { signal: controller.signal });
controller.abort();
// OrmTransactionScopeError: ORM transaction scope was aborted.
```

`timeoutMs` — целое число от 1 до 2147483647, иначе `TypeError` ещё до
начала транзакции.

## Ждите каждый вызов

Все вызовы ORM внутри функции нужно ждать через `await`. Если функция
вернулась раньше, чем закончился запрос, транзакция откатывается:

```ts
await this.db.transactionScope(async () => {
  const bob = await this.db.accounts.find(2);
  bob!.balance += 1;
  void this.db.saveChanges();   // забыли await
});
```

```text
OrmTransactionScopeError: ORM transaction scope callback returned while ORM operations were still
running, so the scope was rolled back; await every ORM call inside the scope callback.
```

## Время базы данных

`tx.databaseTime()` возвращает текущее время сервера PostgreSQL
(`clock_timestamp()`) с точностью до миллисекунды. Это удобно, когда
нужно одно время для всех экземпляров приложения:

```ts
await this.db.transactionScope(async (tx) => {
  const now = await tx.databaseTime();
  now.instant;              // Date
  now.epochMilliseconds;    // 1791640573379
});
```

## Низкоуровневая транзакция

`db.database.transaction(work)` выполняет сырой SQL в транзакции без
контекста:

```ts
const rows = await this.db.database.transaction(async (t) => {
  await t.execute("UPDATE accounts SET balance = balance + $1 WHERE id = $2", [7, 2]);
  return t.query("SELECT count(*)::int AS n FROM accounts", []);
});
```

Плейсхолдеры здесь в формате PostgreSQL — `$1`, `$2`, а параметры передаются
массивом. Это отличается от `executeSqlRaw`, где плейсхолдеры `{0}`. Для
обычного кода берите `transactionScope`.

## Ошибки

| Ошибка | Когда |
| --- | --- |
| исходное исключение | Функция бросила его — транзакция откачена |
| `OrmTransactionScopeError` | Ошибку поймали внутри; тайм-аут или отмена; второй контекст без `tx.use`; забытый `await` |
| `OrmProviderIdentityMismatchError` | У второго контекста другой провайдер |
| `ConcurrentTransactionScopeError` | Два вложенных scope одновременно |
| `PostCommitError` | Данные записаны, но упал колбэк `afterCommit` |
| `TransactionOutcomeUnknownError` | Соединение оборвалось во время `COMMIT`: неизвестно, записались ли данные. Контекст после этого не принимает новых операций |

## Дальше

- [Сохранение и отслеживание изменений](saving.md)
- [Запросы](queries.md)
- [Немедленные изменения](immediate.md)
- [Ошибки базы данных](errors.md)
