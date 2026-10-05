# Repository: specification

Repository (`IRepository<T>` / `Repository<T>`) is a **thin wrapper over the ORM** for working with **one entity**.
It writes no SQL and does not duplicate ORM logic: everything is delegated to `DbSet<T>` and `DbContext`.

---

## In plain words

Picture three layers:

```
Service (UserService)
       ↓
Repository<User>     ← "work only with users"
       ↓
DbSet<User> + DbContext   ← the whole ORM (queries, tracking, SaveChanges)
       ↓
Database
```

**Repository** is the "door" into the ORM for a concrete table/entity.
Instead of writing `ctx.users.where(...)` in every service or carrying the whole `DbContext` around, the service gets a ready `IRepository<User>` object through DI.

---

## Why use it

| Without Repository | With Repository |
| --- | --- |
| The service depends on the whole `AppDbContext` | The service depends only on `IRepository<User>` |
| Easy to touch other tables by accident | One entity is visible, so fewer mistakes |
| Harder to test (needs the full context) | `IRepository<User>` can be replaced with a mock |
| Data access style is scattered across the project | One pattern: `query()` / `add()` / `saveChanges()` |

**Repository does not replace the ORM**: it **organizes** access to it in application code (services, controllers, background tasks).

### When Repository fits

- CRUD and LINQ-like queries over one entity
- The application service layer with DI
- Several repositories in one request (they all share one scoped `DbContext`)

### When to use `DbContext` directly

- A complex transaction over several unrelated entities with manual orchestration
- Scripts/migrations that need no DI (`DbContextFactory`)
- Raw SQL through `database.executeSqlRaw` that is not tied to one entity

---

## Module files

| File | Purpose |
| --- | --- |
| `IRepository.ts` | The interface + the `IRepository` and `repositoryFor()` DI tokens |
| `Repository.ts` | The scoped implementation (delegates to the ORM) |
| `registerRepositories.ts` | Registers repositories in the DI container |

Exports: `osnv/core/orm` (`IRepository`, `repositoryFor`, `registerRepositories`); the `Repository` class itself is in `osnv/library/orm`.

---

## Lifecycle and DI

- **Lifetime:** `scoped`: one `Repository<T>` instance per scope (usually one HTTP request)
- **DbContext** is scoped too → repositories registered for one context type in one scope **share its ChangeTracker**. Repositories of different contexts are independent
- `saveChanges()` on any repository saves **all** pending changes of the context (not only "its own" table)
- For a new application operation, make the write boundary explicit: inject your
  `DbContext`, work with its DbSet and call `db.saveChanges()`. The repository
  method stays a compatible shortcut for the same operation, not a separate commit.

Registration is automatic with `ormModule({ ... })`:

```ts
const DataModule = ormModule({
  context: AppDbContext,
  entities: [User, Post],
  provider: postgres({ url: Bun.env.OSNV_PG_URL! }),
  registerRepositories: true, // true by default
});
```

`ormModule` exports the `IRepository` family token so importing modules can inject `repositoryFor(User)`.

Turning repositories off:

```ts
ormModule({ ..., registerRepositories: false })
```

---

## API: `IRepository<T>`

Below are all the interface members. `Repository<T>` behaves **identically** (it only delegates).

### Queries

#### `query(): DbSet<T>`

The entry point to the ORM's LINQ-like queries. Returns the same object as `dbSet`.

```ts
const adults = await users
  .query()
  .where((u) => u.age.gte(18))
  .orderBy((u) => u.name)
  .take(20)
  .toList();
```

#### `readonly dbSet: DbSet<T>`

Direct access to the `DbSet` is an escape hatch for advanced scenarios.
`query()` and `dbSet` are the same thing; pick whichever reads better in the code.

**What `DbSet` / the chain after `query()` can do** (the full ORM list):

| Method | What it does |
| --- | --- |
| `where(predicate)` | Filter (several `where` = AND) |
| `orderBy(selector)` | Ascending sort |
| `orderByDescending(selector)` | Descending sort |
| `take(n)` | LIMIT |
| `skip(n)` | OFFSET |
| `asNoTracking()` | Do not track the result (faster for read-only) |
| `ignoreQueryFilters()` | Turn off `@QueryFilter` and the soft-delete filter |
| `select(u => ({ ... }))` | Projection into a plain object |
| `include(u => u.nav)` | Eager loading of a navigation |
| `thenInclude(...)` | Nested loading after `include` |
| `toList()` | Run the query, return an array |
| `first(predicate?)` | The first element or an error |
| `firstOrDefault(predicate?)` | The first element or `null` |
| `count(predicate?)` | Number of rows |
| `any(predicate?)` | Whether there is at least one row |

**Predicates** (a Proxy DSL, not strings in SQL):

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `startsWith`, `endsWith`, `contains`, `in`, `isNull`, `isNotNull`, the combinators `.and()`, `.or()`, `.not()`.

> Important: in predicates use `.and()` / `.or()`, not JavaScript `&&` / `||`.

---

### Reading by key

#### `find(key: unknown): Promise<T | null>`

A primary key lookup runs SQL with the access filters and soft delete applied.
If the found entity is already tracked, the same object is returned (identity map).
Having the object in the tracker does not by itself allow skipping the query.

```ts
const user = await users.find(42);
if (user === null) {
  // not found
}
```

---

### Changes (change tracking)

Changes **do not reach the database right away**: they pile up in the `ChangeTracker` until `saveChanges()` is called.

#### `add(entity: T): T`

Marks the entity for **INSERT**. Returns the same reference.

```ts
const user = users.add(Object.assign(new User(), { name: "Ann" }));
await users.saveChanges(); // INSERT, the id is generated
```

#### `addRange(entities: readonly T[]): void`

Batch insert (several `Added` in one call).

#### `update(entity: T): T`

Marks a **full UPDATE** of all non-key columns.

#### `remove(entity: T): T`

Marks for deletion. For `@SoftDelete` it sets a timestamp instead of DELETE.

#### `attach(entity: T): T`

Attaches an existing object as `Unchanged` (with a snapshot for change tracking).

#### `stateOf(entity: T): EntityState`

The current state in the tracker:

| `EntityState` | Meaning |
| --- | --- |
| `Detached` | Not tracked |
| `Unchanged` | Loaded, no changes |
| `Added` | Will be INSERTed |
| `Modified` | Will be UPDATEd |
| `Deleted` | Will be DELETEd (or soft-deleted) |

---

### Saving (Unit of Work)

#### `saveChanges(): Promise<number>`

Applies **all** changes of the current `DbContext` in **one transaction**.
Returns the number of processed entities; `0` if there is nothing to save.

Before saving, the ORM runs:

1. `DetectChanges` (comparison with the snapshot)
2. Validation (`@Validator`, if `validateOnSave: true`)
3. INSERT / UPDATE / DELETE with parameterized SQL
4. `AcceptChanges` on success

On an error the transaction is rolled back and the tracker state is kept: you can fix the data and call `saveChanges()` again.

```ts
users.add(newUser);
posts.add(newPost);
await users.saveChanges(); // saves both User and Post: one context
```

---

### Infrastructure (read-only)

#### `readonly changeTracker: ChangeTracker`

Direct access to the context's tracker (rarely needed in services; for debugging and advanced cases).

#### `readonly database: DatabaseFacade`

The database facade of the same context:

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

## DI: tokens and injection

### `repositoryFor(User)`: the recommended way

A typed token for a concrete entity:

```ts
import { repositoryFor, type IRepository } from "@/core/orm";

class UserService {
  constructor(private readonly users: IRepository<User>) {}
}
```

Registration in a module (if you do not use `ormModule`):

```ts
import { Module } from "@/core/di";
import { registerRepositories } from "@/core/orm";

@Module({
  configure: (di) => registerRepositories(di, AppDbContext, [User, Post]),
  exports: [IRepository],
})
class MyModule {}
```

### Explicit dependencies in a provider

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

A low-level token for DI extensions:

```ts
IRepository.of(User) // the same as repositoryFor(User), but without the richer typing
```

---

## Full example

### 1. Entity and context

```ts
import { Column, DbContext, Entity, Key, ormModule } from "osnv/core/orm";
import { postgres } from "osnv/library/orm";

@Entity()
class User {
  @Key() id = 0;
  @Column({ type: "text" }) name = "";
  @Column({ type: "integer" }) age = 0;
}

class AppDbContext extends DbContext {
  readonly users = this.set(User);
}
```

### 2. Data module

```ts
export const DataModule = ormModule({
  context: AppDbContext,
  entities: [User],
  provider: postgres({ url: Bun.env.OSNV_PG_URL! }),
  migrateOnStart: true,
});
```

### 3. Service

```ts
import { repositoryFor, type IRepository } from "osnv/core/orm";

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
    return user; // the id is filled in after saveChanges
  }

  async rename(id: number, name: string) {
    const user = await this.users.find(id);
    if (user === null) return false;
    user.name = name; // snapshot tracking picks up the change
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

### 4. Application module

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

## Query examples

### Filter and paging

```ts
const page = await users
  .query()
  .where((u) => u.age.gte(18).and(u.name.startsWith("A")))
  .orderByDescending((u) => u.age)
  .skip(20)
  .take(10)
  .toList();
```

### Projection (only the needed fields)

```ts
const labels = await users
  .query()
  .select((u) => ({ id: u.id, name: u.name }))
  .where((u) => u.age.gt(21))
  .toList();
// [{ id: 1, name: "Ann" }, ...]
```

### Eager loading of relations

```ts
const authors = await authorsRepo
  .query()
  .include((a) => a.books)
  .thenInclude((b) => b.reviews)
  .toList();
```

### Global filter and soft delete

```ts
// @QueryFilter on the entity goes into WHERE automatically
await docs.query().toList();

// See the "hidden" rows:
await docs.query().ignoreQueryFilters().toList();

// @SoftDelete: remove() sets deletedAt instead of DELETE
docs.remove(doc);
await docs.saveChanges();
```

### Read-only without tracking

```ts
const rows = await users.query().asNoTracking().toList();
// the objects are not in the changeTracker, which is faster for reports and lists
```

---

## Several repositories in one service

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

    await this.orders.saveChanges(); // saves both Order and Product
  }
}
```

Both repositories use **one** scoped `DbContext` → one transaction per `saveChanges()`.

---

## What Repository does **not** do

- It does not create a separate Unit of Work: that is `DbContext.saveChanges()`
- It does not generate SQL: that is `SqlTranslator` / `SaveExecutor`
- It does not validate on its own: the ORM validates on `saveChanges()`
- It does not isolate transactions across scopes: each scope has its own context
- It does not register entities: only those passed to `ormModule({ entities: [...] })`

---

## Common mistakes

### 1. Forgot `saveChanges()`

```ts
users.add(user);
// the data is not in the database yet!
await users.saveChanges();
```

### 2. `add()` of the wrong entity

```ts
// ❌ a book added through authorsRepo: the ORM treats it as an Author
authors.add(book);

// ✅ its own repository
books.add(book);
```

### 3. Dependencies of `IRepository<User>` without codegen

`di:generate` wires a constructor parameter typed `IRepository<User>` automatically. Explicit deps are needed only when the class is registered without codegen (for example in a hand-built test container):

```ts
scoped(UserService, UserService, [repositoryFor(User)] as const)
```

### 4. `ensureCreated` in tests without starting the application

`ensureCreated: true` in `ormModule` runs in `OrmLifecycle.start()` (at application start).
In tests call it by hand:

```ts
await scope.resolve(AppDbContext).database.ensureCreated();
```

### 5. Different scopes have different data in the tracker

```ts
const scopeA = container.createScope();
const scopeB = container.createScope();
// resolve in scopeA and scopeB gives different DbContext and Repository instances
```

---

## Relation to `DbContext.setOf()`

Inside, Repository calls:

```ts
context.setOf(EntityClass) // → DbSet<T>
```

The `setOf` method was added to `DbContext` exactly for generic access without declaring a `readonly users = this.set(User)` field in the subclass.
In application code prefer **Repository** over a direct `setOf`.

---

## Mocks and testing without a database

Repository is easy to replace in unit tests: the service is tested without PostgreSQL and without a `DbContext`.

### Level 1: a mock `IRepository<User>`

Testing `UserService` without a database: pass an object with the needed methods:

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

A mock usually needs only the methods the service calls.

### Level 2: an in-memory store (without Repository)

For **controller** tests it is enough to replace the store contract the controller depends on (here a hypothetical `IUserStore`):

```ts
import { Module, createContainer, DI } from "osnv/core/di";
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
// call the controller methods or run HTTP e2e over the module
```

The controller and the HTTP layer do not touch the ORM, only the `IUserStore` contract.

### Level 3: an integration test with a real Repository

As in [orm.repository.test.ts](../../../core/orm/test/orm.repository.test.ts):

```ts
const DataModule = ormModule({
  context: UsersDbContext,
  entities: [User],
  provider: postgres({ url: Bun.env.OSNV_PG_URL! }),
  healthCheck: false,
});

const container = createContainer(DataModule);
const scope = container.createScope();
await scope.resolve(UsersDbContext).database.ensureCreated();

const service = new UserService(scope.resolve(repositoryFor(User)));
await service.add("Integration");
expect(await service.list(10)).toHaveLength(1);
```

### What to mock in which tests

| You test | Mock | Database needed? |
| --- | --- | --- |
| `UserService` (domain rules) | `IRepository<User>` | No |
| `UsersController` (HTTP, @Catch) | the store contract / an in-memory store | No |
| Repository + ORM (queries, tracking) | — | Yes (PostgreSQL) |
| Full HTTP e2e | — | Yes (or a test module with an in-memory store) |

### Tips

1. **Do not mock `query()`** if you test SQL/filters: use PostgreSQL qualification.
2. **Mock `saveChanges()`** to check that the service saves data at all.
3. **One scope per test**: `scope.dispose()` in `afterEach`, otherwise scoped services leak.
4. In hand-built DI test containers (without codegen) with `validateOnBuild: true`, give Repository deps explicitly: `[repositoryFor(User)]`.

---

## Tests

Live examples and scenarios:

- ORM Repository: [orm.repository.test.ts](../../../core/orm/test/orm.repository.test.ts)

Covered: CRUD, queries, include, `@QueryFilter`, `@SoftDelete`, scoped DI, module encapsulation.

---

## Cheat sheet

```ts
// DI
constructor(private readonly users: IRepository<User>) {}

// Read
await users.find(id);
await users.query().where(...).toList();

// Write
users.add(entity);
users.update(entity);
users.remove(entity);
await users.saveChanges();

// DI token
repositoryFor(User)
```
