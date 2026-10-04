# Repository — спецификация

Repository (`IRepository<T>` / `Repository<T>`) — **тонкая обёртка над ORM** для работы с **одной сущностью**.  
Он не пишет SQL и не дублирует логику ORM: всё делегируется в `DbSet<T>` и `DbContext`.

---

## Что это простыми словами

Представь три слоя:

```
Сервис (UserService)
       ↓
Repository<User>     ← «работай только с пользователями»
       ↓
DbSet<User> + DbContext   ← весь ORM (запросы, трекинг, SaveChanges)
       ↓
База данных
```

**Repository** — это «дверь» в ORM для конкретной таблицы/сущности.  
Вместо того чтобы в каждом сервисе писать `ctx.users.where(...)` или таскать за собой весь `DbContext`, сервис получает готовый объект `IRepository<User>` через DI.

---

## Зачем пользоваться

| Без Repository | С Repository |
| --- | --- |
| Сервис зависит от всего `AppDbContext` | Сервис зависит только от `IRepository<User>` |
| Легко случайно трогать чужие таблицы | Видна одна сущность — меньше ошибок |
| Сложнее тестировать (нужен полный контекст) | Можно подменить `IRepository<User>` моком |
| Один стиль доступа к данным размыт по проекту | Единый паттерн: `query()` / `add()` / `saveChanges()` |

**Repository не заменяет ORM** — он **организует** доступ к нему в прикладном коде (сервисы, контроллеры, фоновые задачи).

### Когда Repository подходит

- CRUD и LINQ-подобные запросы к одной сущности
- Сервисный слой приложения с DI
- Несколько репозиториев в одном запросе (все делят один scoped `DbContext`)

### Когда лучше напрямую `DbContext`

- Сложная транзакция с несколькими несвязанными сущностями и ручной оркестрацией
- Скрипты/миграции, где DI не нужен (`DbContextFactory`)
- Сырой SQL через `database.executeSqlRaw` без привязки к одной сущности

---

## Файлы модуля

| Файл | Назначение |
| --- | --- |
| `IRepository.ts` | Интерфейс + DI-токены `IRepository` и `repositoryFor()` |
| `Repository.ts` | Scoped-реализация (делегирование в ORM) |
| `registerRepositories.ts` | Регистрация репозиториев в DI-контейнере |

Экспорт: `@/core/orm` (`IRepository`, `repositoryFor`, `registerRepositories`); сам класс `Repository` — в `@/library/orm`.

---

## Жизненный цикл и DI

- **Lifetime:** `scoped` — один экземпляр `Repository<T>` на scope (обычно один HTTP-запрос)
- **DbContext** тоже scoped → репозитории, зарегистрированные для одного типа контекста в одном scope, **делят его ChangeTracker**. Репозитории разных контекстов независимы
- `saveChanges()` на любом репозитории сохраняет **все** накопленные изменения контекста (не только «свою» таблицу)
- Для новой прикладной операции границу записи показывайте явно: внедрите свой
  `DbContext`, работайте с его DbSet и вызовите `db.saveChanges()`. Репозиторный
  метод остаётся совместимым сокращением той же операции, а не отдельным commit.

Регистрация автоматическая при `ormModule({ ... })`:

```ts
const DataModule = ormModule({
  context: AppDbContext,
  entities: [User, Post],
  provider: postgres({ url: Bun.env.OSNOVA_PG_URL! }),
  registerRepositories: true, // по умолчанию true
});
```

`ormModule` экспортирует family-токен `IRepository`, чтобы импортирующие модули могли инжектить `repositoryFor(User)`.

Отключить репозитории:

```ts
ormModule({ ..., registerRepositories: false })
```

---

## API: `IRepository<T>`

Ниже — все члены интерфейса. У `Repository<T>` поведение **идентично** (только делегирование).

### Запросы

#### `query(): DbSet<T>`

Точка входа в LINQ-подобные запросы ORM. Возвращает тот же объект, что и `dbSet`.

```ts
const adults = await users
  .query()
  .where((u) => u.age.gte(18))
  .orderBy((u) => u.name)
  .take(20)
  .toList();
```

#### `readonly dbSet: DbSet<T>`

Прямой доступ к `DbSet` — «escape hatch» для продвинутых сценариев.  
`query()` и `dbSet` — одно и то же; выбирай то, что читается лучше в коде.

**Что умеет `DbSet` / цепочка после `query()`** (полный список ORM):

| Метод | Что делает |
| --- | --- |
| `where(predicate)` | Фильтр (несколько `where` = AND) |
| `orderBy(selector)` | Сортировка по возрастанию |
| `orderByDescending(selector)` | Сортировка по убыванию |
| `take(n)` | LIMIT |
| `skip(n)` | OFFSET |
| `asNoTracking()` | Не отслеживать результат (быстрее для read-only) |
| `ignoreQueryFilters()` | Отключить `@QueryFilter` и soft-delete фильтр |
| `select(u => ({ ... }))` | Проекция в plain-объект |
| `include(u => u.nav)` | Жадная загрузка навигации |
| `thenInclude(...)` | Вложенная загрузка после `include` |
| `toList()` | Выполнить запрос, вернуть массив |
| `first(predicate?)` | Первый элемент или ошибка |
| `firstOrDefault(predicate?)` | Первый элемент или `null` |
| `count(predicate?)` | Количество строк |
| `any(predicate?)` | Есть ли хотя бы одна строка |

**Предикаты** (Proxy-DSL, не строки в SQL):

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `startsWith`, `endsWith`, `contains`, `in`, `isNull`, `isNotNull`, комбинаторы `.and()`, `.or()`, `.not()`.

> Важно: в предикатах используй `.and()` / `.or()`, а не JavaScript `&&` / `||`.

---

### Чтение по ключу

#### `find(key: unknown): Promise<T | null>`

Поиск по первичному ключу выполняет SQL с учётом фильтров доступа и soft delete.
Если найденная сущность уже отслеживается, возвращается тот же объект (identity
map). Наличие объекта в трекере само по себе не позволяет пропустить запрос.

```ts
const user = await users.find(42);
if (user === null) {
  // не найден
}
```

---

### Изменения (change tracking)

Изменения **не попадают в БД сразу** — они копятся в `ChangeTracker` до вызова `saveChanges()`.

#### `add(entity: T): T`

Пометить сущность на **INSERT**. Возвращает ту же ссылку.

```ts
const user = users.add(Object.assign(new User(), { name: "Ann" }));
await users.saveChanges(); // INSERT, id сгенерируется
```

#### `addRange(entities: readonly T[]): void`

Пакетная вставка (несколько `Added` за один вызов).

#### `update(entity: T): T`

Пометить на **полное UPDATE** всех не-ключевых колонок.

#### `remove(entity: T): T`

Пометить на удаление. Для `@SoftDelete` — ставит метку времени, а не DELETE.

#### `attach(entity: T): T`

Прикрепить существующий объект как `Unchanged` (со снимком для отслеживания изменений).

#### `stateOf(entity: T): EntityState`

Текущее состояние в трекере:

| `EntityState` | Значение |
| --- | --- |
| `Detached` | Не отслеживается |
| `Unchanged` | Загружена, изменений нет |
| `Added` | Будет INSERT |
| `Modified` | Будет UPDATE |
| `Deleted` | Будет DELETE (или soft delete) |

---

### Сохранение (Unit of Work)

#### `saveChanges(): Promise<number>`

Применить **все** изменения текущего `DbContext` в **одной транзакции**.  
Возвращает число обработанных сущностей. `0` — если нечего сохранять.

Перед сохранением ORM:

1. `DetectChanges` (сравнение со snapshot)
2. Валидация (`@Validator`, если `validateOnSave: true`)
3. INSERT / UPDATE / DELETE параметризованным SQL
4. `AcceptChanges` при успехе

При ошибке транзакция откатывается, состояние трекера сохраняется — можно исправить данные и вызвать `saveChanges()` снова.

```ts
users.add(newUser);
posts.add(newPost);
await users.saveChanges(); // сохранит и User, и Post — один контекст
```

---

### Инфраструктура (read-only)

#### `readonly changeTracker: ChangeTracker`

Прямой доступ к трекеру контекста (редко нужен в сервисах; для отладки и продвинутых кейсов).

#### `readonly database: DatabaseFacade`

Фасад БД того же контекста:

- `ensureCreated()` / `migrate()` / `migrateVersioned()`
- `executeSqlRaw()` / `querySqlRaw()`
- `transaction(work)`
- `canConnect()`

```ts
await users.database.executeSqlRaw(
  'UPDATE "Users" SET "active" = {0} WHERE "id" = {1}',
  false,
  userId,
);
```

---

## DI: токены и внедрение

### `repositoryFor(User)` — рекомендуемый способ

Типизированный токен для конкретной сущности:

```ts
import { repositoryFor, type IRepository } from "@/core/orm";

class UserService {
  constructor(private readonly users: IRepository<User>) {}
}
```

Регистрация в модуле (если не используешь `ormModule`):

```ts
import { Module } from "@/core/di";
import { registerRepositories } from "@/core/orm";

@Module({
  configure: (di) => registerRepositories(di, AppDbContext, [User, Post]),
  exports: [IRepository],
})
class MyModule {}
```

### Явные зависимости в провайдере

```ts
import { scoped, DI } from "@/core/di";
import { repositoryFor } from "@/core/orm";

providers: [
  scoped(
    DI.classProvider(UserService, UserService, [repositoryFor(User)] as const),
  ),
],
```

### `IRepository` — open generic family

Низкоуровневый токен для расширений DI:

```ts
IRepository.of(User) // эквивалент repositoryFor(User), но без улучшенной типизации
```

---

## Полный пример

### 1. Сущность и контекст

```ts
import { Column, DbContext, Entity, Key, ormModule } from "@osnova/core/orm";
import { postgres } from "@osnova/library/orm";

@Entity({ migrate: true })
class User {
  @Key() id = 0;
  @Column({ type: "text" }) name = "";
  @Column({ type: "integer" }) age = 0;
}

class AppDbContext extends DbContext {
  readonly users = this.set(User);
}
```

### 2. Модуль данных

```ts
export const DataModule = ormModule({
  context: AppDbContext,
  entities: [User],
  provider: postgres({ url: Bun.env.OSNOVA_PG_URL! }),
  migrateOnStart: true,
});
```

### 3. Сервис

```ts
import { repositoryFor, type IRepository } from "@/core/orm";

export class UserService {
  constructor(private readonly users: IRepository<User>) {}

  listAdults(limit: number) {
    return this.users
      .query()
      .where((u) => u.age.gte(18))
      .orderBy((u) => u.name)
      .take(limit)
      .toList();
  }

  async findById(id: number) {
    return this.users.find(id);
  }

  async create(name: string, age: number) {
    const user = this.users.add(Object.assign(new User(), { name, age }));
    await this.users.saveChanges();
    return user; // id уже заполнен после saveChanges
  }

  async rename(id: number, name: string) {
    const user = await this.users.find(id);
    if (user === null) return false;
    user.name = name; // snapshot-трекинг подхватит изменение
    await this.users.saveChanges();
    return true;
  }

  async removeById(id: number) {
    const user = await this.users.find(id);
    if (user === null) return false;
    this.users.remove(user);
    await this.users.saveChanges();
    return true;
  }
}
```

### 4. Модуль приложения

```ts
import { Module, scoped } from "@/core/di";
import { repositoryFor } from "@/core/orm";

@Module({
  imports: [DataModule],
  providers: [
    scoped(UserService, UserService, [repositoryFor(User)] as const),
  ],
  exports: [UserService],
})
class UsersModule {}
```

---

## Примеры запросов

### Фильтр и пагинация

```ts
const page = await users
  .query()
  .where((u) => u.age.gte(18).and(u.name.startsWith("A")))
  .orderByDescending((u) => u.age)
  .skip(20)
  .take(10)
  .toList();
```

### Проекция (только нужные поля)

```ts
const labels = await users
  .query()
  .select((u) => ({ id: u.id, name: u.name }))
  .where((u) => u.age.gt(21))
  .toList();
// [{ id: 1, name: "Ann" }, ...]
```

### Жадная загрузка связей

```ts
const authors = await authorsRepo
  .query()
  .include((a) => a.books)
  .thenInclude((b) => b.reviews)
  .toList();
```

### Глобальный фильтр и soft delete

```ts
// @QueryFilter на сущности — автоматически в WHERE
await docs.query().toList();

// Увидеть «скрытые» строки:
await docs.query().ignoreQueryFilters().toList();

// @SoftDelete — remove() ставит deletedAt, не DELETE
docs.remove(doc);
await docs.saveChanges();
```

### Read-only без трекинга

```ts
const rows = await users.query().asNoTracking().toList();
// объекты не в changeTracker — быстрее для отчётов и списков
```

---

## Несколько репозиториев в одном сервисе

```ts
class OrderService {
  constructor(
    private readonly orders: IRepository<Order>,
    private readonly products: IRepository<Product>,
  ) {}

  async placeOrder(productId: number, qty: number) {
    const product = await this.products.find(productId);
    if (product === null) throw new Error("product not found");

    this.orders.add(Object.assign(new Order(), { productId, qty }));
    product.stock -= qty;

    await this.orders.saveChanges(); // сохранит и Order, и Product
  }
}
```

Оба репозитория используют **один** scoped `DbContext` → одна транзакция на `saveChanges()`.

---

## Что Repository **не** делает

- Не создаёт отдельный Unit of Work — это `DbContext.saveChanges()`
- Не генерирует SQL — это `SqlTranslator` / `SaveExecutor`
- Не валидирует сам по себе — валидация ORM при `saveChanges()`
- Не изолирует транзакции между разными scope — у каждого scope свой контекст
- Не регистрирует сущности — только те, что переданы в `ormModule({ entities: [...] })`

---

## Частые ошибки

### 1. Забыли `saveChanges()`

```ts
users.add(user);
// данные ещё не в БД!
await users.saveChanges();
```

### 2. `add()` не той сущности

```ts
// ❌ книгу добавили через authorsRepo — ORM воспримет как Author
authors.add(book);

// ✅ свой репозиторий
books.add(book);
```

### 3. Ожидали auto deps для `IRepository<User>`

Open generic не подхватывается `di:generate` автоматически. Указывай deps явно:

```ts
scoped(UserService, UserService, [repositoryFor(User)] as const)
```

### 4. `ensureCreated` в тестах без старта приложения

`ensureCreated: true` в `ormModule` срабатывает в `OrmLifecycle.start()` (при запуске приложения).  
В тестах вызови вручную:

```ts
await scope.resolve(AppDbContext).database.ensureCreated();
```

### 5. Разные scope — разные данные в трекере

```ts
const scopeA = container.createScope();
const scopeB = container.createScope();
// resolve в scopeA и scopeB — разные DbContext и Repository
```

---

## Связь с `DbContext.setOf()`

Repository внутри вызывает:

```ts
context.setOf(EntityClass) // → DbSet<T>
```

Метод `setOf` добавлен в `DbContext` именно для generic-доступа без объявления поля `readonly users = this.set(User)` в наследнике.  
В прикладном коде предпочтительнее **Repository**, а не прямой `setOf`.

---

## Интеграция в приложении (`UsersModule`)

В проекте модуль пользователей уже подключён к Repository. Схема:

```
HTTP-запрос
    → UsersController (IUserStore)
    → UserService (IRepository<User>)
    → UsersDbContext (scoped)
    → PostgreSQL
```

### Файлы

| Файл | Роль |
| --- | --- |
| `src/modules/users/User.ts` | ORM-сущность `@Entity({ migrate: true })` |
| `src/modules/users/UsersDbContext.ts` | `DbContext` с `users = this.set(User)` |
| `src/modules/users/UserService.ts` | Бизнес-логика через `IRepository<User>` |
| `src/modules/users/IUserStore.ts` | Контракт для контроллера (не привязан к ORM) |
| `src/modules/users/UsersModule.ts` | `ormModule` + scoped `UserService` |
| `src/modules/users/InMemoryUserStore.ts` | In-memory реализация для тестов без БД |

### Регистрация модуля (как в коде)

```ts
// src/modules/users/UsersModule.ts
const UsersDataModule = ormModule({
  context: UsersDbContext,
  entities: [User],
  provider: postgres({ url: Bun.env.OSNOVA_PG_URL! }),
  migrateOnStart: true,
});

@Module({
  imports: [UsersDataModule],
  controllers: [UsersController],
  providers: [scoped(IUserStore, UserService, [repositoryFor(User)] as const)],
  exports: [IUserStore],
})
class UsersModule {}
```

Контроллер **не знает** про Repository — он зависит только от `IUserStore`.  
ORM и DI спрятаны в `UserService`.

### UserService — тонкая обёртка над Repository

```ts
export class UserService implements IUserStore {
  constructor(private readonly users: IRepository<User>) {}

  list(limit: number) {
    return this.users.query().take(limit).toList();
  }

  async byId(id: number) {
    return (await this.users.find(id)) ?? undefined;
  }

  async add(name: string) {
    const user = this.users.add(Object.assign(new User(), { name }));
    await this.users.saveChanges();
    return user;
  }

  async remove(id: number) {
    const user = await this.users.find(id);
    if (user === null) return false;
    this.users.remove(user);
    await this.users.saveChanges();
    return true;
  }
}
```

### Запуск

```bash
bun run dev
# или
bun run src/examples/osnova/orm.ts
```

```bash
curl http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/users -H 'Content-Type: application/json' -d '{"name":"Bob"}'
```

База подключается через `OSNOVA_PG_URL`. Схема создаётся при старте через `migrateOnStart`.

### Почему контроллер → IUserStore, а не IRepository

- **Контроллер** описывает HTTP-контракт (`list`, `byId`, `add`, `remove`)
- **Repository** — инфраструктурный доступ к таблице
- Между ними **UserService** — место для правил домена (проверки, несколько репозиториев, события)

Если логики мало, можно инжектить `IRepository<User>` прямо в контроллер — но отдельный сервис масштабируется лучше.

---

## Моки и тестирование без БД

Repository удобно подменять в unit-тестах: сервис тестируется без PostgreSQL и без `DbContext`.

### Уровень 1: мок `IRepository<User>`

Тест `UserService` без БД — подставь объект с нужными методами:

```ts
import { describe, expect, test } from "bun:test";
import type { IRepository } from "@/core/orm";
import { UserService } from "./UserService";
import { User } from "./User";

test("add calls repository add and saveChanges", async () => {
  let saved = false;
  const users: IRepository<User> = {
    get dbSet() { throw new Error("not needed"); },
    query() { throw new Error("not needed"); },
    find: async () => null,
    add: (entity) => entity,
    addRange: () => {},
    update: (entity) => entity,
    remove: (entity) => entity,
    attach: (entity) => entity,
    stateOf: () => "Unchanged" as const,
    saveChanges: async () => { saved = true; return 1; },
    get changeTracker() { throw new Error("not needed"); },
    get database() { throw new Error("not needed"); },
  };

  const service = new UserService(users);
  await service.add("Ann");
  expect(saved).toBe(true);
});
```

Полный рабочий мок с in-memory хранилищем: `src/modules/users/users.service.test.ts`.

### Уровень 2: `InMemoryUserStore` (без Repository)

Для тестов **контроллера** достаточно подменить `IUserStore`:

```ts
import { Module, createContainer, DI } from "@/core/di";
import { InMemoryUserStore } from "./InMemoryUserStore";
import { IUserStore } from "./IUserStore";
import { UsersController } from "./UsersController";

@Module({
  controllers: [UsersController],
  providers: [
    DI.scoped(DI.valueProvider(IUserStore, new InMemoryUserStore())),
  ],
})
class TestUsersModule {}

const container = createContainer(TestUsersModule);
const scope = container.createScope();
const controller = scope.resolve(UsersController);
// вызывай методы контроллера или HTTP e2e поверх модуля
```

Контроллер и HTTP-слой не трогают ORM — только контракт `IUserStore`.

### Уровень 3: интеграционный тест с настоящим Repository

Как в `src/orm/test/orm.repository.test.ts`:

```ts
const DataModule = ormModule({
  context: UsersDbContext,
  entities: [User],
  provider: postgres({ url: Bun.env.OSNOVA_PG_URL! }),
  healthCheck: false,
});

const container = createContainer(DataModule);
const scope = container.createScope();
await scope.resolve(UsersDbContext).database.ensureCreated();

const service = new UserService(scope.resolve(repositoryFor(User)));
await service.add("Integration");
expect(await service.list(10)).toHaveLength(1);
```

### Что мокать в каких тестах

| Тестируешь | Мокай | БД нужна? |
| --- | --- | --- |
| `UserService` (правила домена) | `IRepository<User>` | Нет |
| `UsersController` (HTTP, @Catch) | `IUserStore` / `InMemoryUserStore` | Нет |
| Repository + ORM (запросы, трекинг) | — | Да (PostgreSQL) |
| Полный HTTP e2e | — | Да (или test module с in-memory store) |

### Советы

1. **Не мокай `query()`**, если тестируешь SQL/фильтры — используй PostgreSQL qualification.
2. **Мокай `saveChanges()`**, чтобы проверить, что сервис вообще сохраняет данные.
3. **Один scope на тест** — `scope.dispose()` в `afterEach`, иначе утечки scoped-сервисов.
4. Для `validateOnBuild: true` в DI-тестах с Repository указывай deps явно: `[repositoryFor(User)]`.

---

## Тесты

Живые примеры и сценарии:

- ORM Repository: `src/orm/test/orm.repository.test.ts`
- UserService + mock Repository: `src/modules/users/users.service.test.ts`

Покрыто: CRUD, запросы, include, `@QueryFilter`, `@SoftDelete`, DI scoped, encapsulation модулей.

---

## Краткая шпаргалка

```ts
// DI
constructor(private readonly users: IRepository<User>) {}

// Читать
await users.find(id);
await users.query().where(...).toList();

// Писать
users.add(entity);
users.update(entity);
users.remove(entity);
await users.saveChanges();

// Токен DI
repositoryFor(User)
```
