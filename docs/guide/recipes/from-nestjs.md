# Если вы пришли с NestJS

Модули, контроллеры, провайдеры и декораторы в bazis устроены как в
NestJS — переносится большая часть привычек. Ниже — что как называется,
что устроено иначе и одно и то же приложение на двух фреймворках.

Примеры bazis проверены на 0.100.6. Код NestJS — для сравнения, его мы
не запускали.

## Коротко о различиях

- **Декораторов на параметрах нет.** Ни `@Param`, ни `@Query`, ни
  `@Body`: откуда брать значение, bazis понимает по имени и типу
  параметра.
- **Зависимости собирает кодогенерация.** Контейнер не читает
  `reflect-metadata`: `bazis codegen` (его запускают `dev`, `test` и
  `build`) записывает зависимости конструкторов в `src/generated`. Граф
  целиком проверяется при запуске: незарегистрированный сервис или
  singleton, который зависит от scoped, останавливают приложение до
  первого запроса.
- **Интерфейс — не токен, абстрактный класс — токен.** Контракт сервиса —
  абстрактный класс; по нему и внедряют.
- **Контроллеры не регистрируются в `providers`.** Новый экземпляр на
  каждый запрос, как `Scope.REQUEST` у Nest, — для контроллеров это
  дёшево.
- **Bun и один исполняемый файл.** Никакого Express или Fastify под
  капотом; `bazis build --bin` даёт файл с Bun внутри.

## Что как называется

| NestJS | bazis | Где читать |
| --- | --- | --- |
| `NestFactory.create(AppModule)` + `listen` | `runApp(AppModule, { http })` | [Приложение](../overview/application.md) |
| `@Module({ imports, controllers, providers, exports })` | `@Module` с теми же полями | [Модули](../overview/modules.md) |
| `@Global()` | `@Global()` — так же | [Модули](../overview/modules.md#глобальные-модули) |
| `@Injectable()` | Не нужен | |
| `@Param()`, `@Query()`, `@Body()` | Имя и тип параметра метода | [Контроллеры](../overview/controllers.md#аргументы-методов) |
| `ParseIntPipe`, `ParseUUIDPipe` | Ограничение в маршруте: `:id(int)`, `:id(uuid)` | [Контроллеры](../overview/controllers.md#маршруты) |
| `class-validator` + `ValidationPipe` | `@RequestModel()` + `@Validator` | [Проверка данных](../overview/validation.md) |
| `Scope.DEFAULT` / `REQUEST` / `TRANSIENT` | `singleton` / `scoped` / `transient` | [Провайдеры](../overview/providers.md#время-жизни) |
| `@Inject(TOKEN)` + `{ provide, useClass }` | Абстрактный класс как токен: `singleton(IBookStore, MemoryBookStore)` | [Провайдеры](../overview/providers.md#регистрация-по-контракту) |
| `@nestjs/config` + `ConfigService` | `defineConfig` + `ConfigView<T>` | [Конфигурация](../fundamentals/configuration.md) |
| Guard (`CanActivate`) | `@Authorize(check)` | [Авторизация](../overview/authorization.md) |
| Interceptor | `@ActionFilter` или middleware | [Middleware](../overview/middleware.md) |
| Exception filter | Middleware, переводящий ошибку в `HttpError` | [Ошибки](../overview/errors.md#доменные-ошибки) |
| `HttpException`, `NotFoundException` | `HttpError`, `NotFoundError` | [Ошибки](../overview/errors.md) |
| `OnModuleInit`, `OnApplicationShutdown` | `LifecycleHook`: `onInit`, `onShutdown` | [Жизненный цикл](../fundamentals/lifecycle.md#хуки-жизненного-цикла) |
| `@nestjs/schedule`, `@Cron` | `PeriodicBackgroundService` в поле `background` модуля | [Фоновые службы](../realtime/background-services.md) |
| `@nestjs/swagger` | Не нужен: OpenAPI строит кодогенерация, `/docs` | [OpenAPI](../http/openapi.md) |
| `Test.createTestingModule(...).overrideProvider(...)` | `startTestApp(AppModule, { overrides })` | [Тестирование](../fundamentals/testing.md#http-starttestapp) |
| `nest g resource` | `bazis g module` | [Команды CLI](../cli/commands.md) |
| TypeORM / Prisma | Встроенная ORM: `DbContext`, `DbSet`, `saveChanges` | [Рецепт CRUD](crud-module.md) |

## Одно приложение на двух фреймворках

Каталог книг: поиск, книга по номеру, добавление только с ключом
администратора, своя ошибка «книга не найдена».

### Модуль

```ts
// NestJS
@Module({
  imports: [ConfigModule],
  controllers: [BooksController],
  providers: [
    { provide: BOOK_STORE, useClass: MemoryBookStore },
    BooksService,
  ],
  exports: [BooksService],
})
export class BooksModule {}
```

```ts
// bazis
@Module({
  config: booksConfig,
  controllers: [BooksController],
  providers: [
    singleton(IBookStore, MemoryBookStore),
    scoped(BooksService),
    singleton(LIFECYCLE_HOOK, WarmUp),
  ],
  exports: [BooksService],
})
export class BooksModule {}
```

Настройки модуль приносит сам (`config`) — их проверят при запуске
вместе с остальными.

### Контракт и реализация

```ts
// NestJS
export const BOOK_STORE = Symbol("BOOK_STORE");
export interface BookStore { all(): Book[]; find(id: number): Book | undefined; add(title: string, author: string): Book }

@Injectable()
export class BooksService {
  constructor(@Inject(BOOK_STORE) private readonly store: BookStore, private readonly config: ConfigService) {}
}
```

```ts
// bazis
/** The contract is an abstract class: it exists at runtime and is the DI token. */
export abstract class IBookStore {
  abstract all(): Book[];
  abstract find(id: number): Book | undefined;
  abstract add(title: string, author: string): Book;
}

export class BooksService {
  constructor(private readonly store: IBookStore, private readonly config: ConfigView<BooksConfig>) {}

  search(q: string, limit: number): Book[] {
    const max = Math.min(limit, this.config.get("pageSize"));
    return this.store.all().filter((book) => book.title.toLowerCase().includes(q.toLowerCase())).slice(0, max);
  }

  get(id: number): Book {
    const book = this.store.find(id);
    if (!book) throw new BookNotFound(id);
    return book;
  }
}
```

Ни `@Injectable`, ни `@Inject`: тип параметра конструктора и есть
токен.

### Настройки

```ts
// NestJS: ConfigModule.forRoot() и configService.get<number>("BOOKS_PAGE_SIZE")
```

```ts
// bazis
export interface BooksConfig { pageSize: number; adminKey: Secret }

export const booksConfig = defineConfig<BooksConfig>("books", {
  default: { pageSize: 20, adminKey: secret("dev-admin-key") },
  production: { adminKey: secret() },
});
```

Значения типизированы, переменные окружения называются сами —
`BAZIS_BOOKS__PAGESIZE`, `BAZIS_BOOKS__ADMINKEY`. Ошибка в значении или
пропущенный секрет production останавливает запуск
([Конфигурация](../fundamentals/configuration.md)).

### Контроллер

```ts
// NestJS
@Controller("books")
export class BooksController {
  constructor(private readonly books: BooksService) {}

  @Get()
  @UseInterceptors(WrapInterceptor)
  search(@Query("q") q: string, @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number) {
    return this.books.search(q, limit);
  }

  @Get(":id")
  get(@Param("id", ParseIntPipe) id: number) {
    return this.books.get(id);
  }

  @Post()
  @UseGuards(AdminKeyGuard)
  add(@Body() body: AddBookDto) {
    return this.books.add(body.title, body.author);
  }
}
```

```ts
// bazis
@Controller("books")
export class BooksController {
  constructor(private readonly books: BooksService) {}

  @Get()
  @ActionFilter({ after: (_ctx, result) => ({ items: result, servedAt: "now" }) })
  search(q: string, limit = 10) {
    return this.books.search(q, limit);
  }

  @Get(":id(int)")
  get(id: number) {
    return this.books.get(id);
  }

  @Post()
  @Authorize(adminKey)
  add(body: AddBookRequest, ctx: HttpContext) {
    const book = this.books.add(body.title, body.author);
    return Created(`${ctx.path}/${book.id}`, book);
  }
}
```

| Параметр | Откуда |
| --- | --- |
| `id` | Есть в маршруте `:id(int)` — из пути, уже числом |
| `q`, `limit` | Простые типы, которых нет в маршруте, — из строки запроса; `limit = 10` — необязательный |
| `body: AddBookRequest` | Класс модели запроса — из JSON-тела, с проверкой |
| `ctx: HttpContext` | Контекст запроса |

### Проверка тела

```ts
// NestJS
export class AddBookDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 100) author!: string;
}
```

```ts
// bazis
@RequestModel()
export class AddBookRequest {
  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;

  @Validator({ required: true, minLength: 1, maxLength: 100 })
  author!: string;
}
```

Поля, которых нет в классе, отбрасываются — как `whitelist: true` в
`ValidationPipe`, только по умолчанию.

### Guard → `@Authorize`

```ts
// NestJS
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const key = context.switchToHttp().getRequest().headers["x-admin-key"];
    if (!key) throw new UnauthorizedException();
    return key === this.config.get("ADMIN_KEY");
  }
}
```

```ts
// bazis
/** A guard: a check that runs before the controller and decides 401/403. */
export const adminKey: AuthorizeCheck = (ctx) => {
  const key = ctx.header("x-admin-key");
  if (!key) throw new UnauthorizedError();
  const config = ctx.services.resolve(booksConfig.token) as ConfigView<BooksConfig>;
  return key === config.get("adminKey").reveal();
};
```

Проверка — функция; сервисы она берёт из `ctx.services`. `false` — `403`,
`UnauthorizedError` — `401`.

### Exception filter → middleware

```ts
// NestJS
@Catch(BookNotFound)
export class BookNotFoundFilter implements ExceptionFilter {
  catch(error: BookNotFound, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(404).json({ error: error.message, details: { id: error.id } });
  }
}
```

```ts
// bazis
/** An exception filter: a domain error becomes an HTTP answer in one place. */
export const bookErrors: HttpMiddleware = async (_ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof BookNotFound) throw new NotFoundError(error.message, { id: error.id });
    throw error;
  }
};

await runApp(AppModule, { http: { /* … */ middleware: [bookErrors] } });
```

### `OnModuleInit` → `LifecycleHook`

```ts
// bazis
/** Runs once at start, like OnModuleInit. */
export class WarmUp implements LifecycleHook {
  constructor(private readonly store: IBookStore, private readonly logger: Logger) {}

  onInit() {
    this.logger.info("books ready", { count: this.store.all().length });
  }
}
// в модуле: singleton(LIFECYCLE_HOOK, WarmUp)
```

### Что получилось

```text
GET  /books?q=du&limit=5          → {"items":[{"id":1,"title":"Dune","author":"Herbert"}],"servedAt":"now"}
GET  /books                       → 400 {"error":"Missing required query parameter \"q\""}
GET  /books/1                     → {"id":1,"title":"Dune","author":"Herbert"}
GET  /books/99                    → 404 {"error":"book 99 not found","details":{"id":99}}
GET  /books/abc                   → 404 {"error":"Not Found"}            ← :id(int) не совпал
POST /books                       → 401 {"error":"Unauthorized"}         ← нет ключа
POST /books  x-admin-key: nope    → 403 {"error":"Forbidden"}
POST /books  {"title":""}         → 400 {"error":"Validation failed","details":[
                                       {"property":"title",…,"code":"minLength"},
                                       {"property":"author",…,"code":"required"}]}
POST /books  {"title":"Solaris","author":"Lem","isAdmin":true}
                                  → 201 Location: /books/2  {"id":2,"title":"Solaris","author":"Lem"}
GET  /docs                        → 200 (OpenAPI без единого декоратора Swagger)

info: books ready {"count":1}
```

### Тест

```ts
// NestJS
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(BOOK_STORE).useClass(FakeStore)
  .compile();
const app = moduleRef.createNestApplication();
await app.init();
await request(app.getHttpServer()).get("/books/7").expect(200);
```

```ts
// bazis
test("GET /books/:id uses the replaced store; an unknown id is 404", async () => {
  const app = await startTestApp(AppModule, {
    http: { middleware: [bookErrors] },
    overrides: [singleton(IBookStore, FakeStore)],
  });
  try {
    expect(await (await app.fetch("/books/7")).json()).toEqual({ id: 7, title: "Test Book", author: "Tester" });
    expect((await app.fetch("/books/1")).status).toBe(404);
  } finally {
    await app.stop();
  }
});
```

Приложение запускается на свободном порту, `app.fetch` ходит в него по
HTTP — без `supertest`.

## Чего в bazis нет

- **Декораторов на параметрах** и пользовательских param-декораторов
  (`createParamDecorator`): контекст запроса доступен через `HttpContext`,
  пользователь — через scoped-сервис ([Текущий пользователь](../security/authorization-patterns.md#текущий-пользователь-в-сервисах)).
- **Динамических модулей `forRoot()` / `forRootAsync()`**: модуль
  объявляет настройки полем `config`, инфраструктура подключается
  манифестом `@Infra` ([Инфраструктура](../infra/overview.md)).
- **Микросервисных транспортов `@nestjs/microservices`**: есть gRPC и
  WebSocket ([gRPC](../realtime/grpc.md), [WebSocket](../realtime/websocket.md)).

## Дальше

- [Первые шаги](../introduction/first-steps.md)
- [CRUD-модуль целиком](crud-module.md)
- [JWT и защита маршрутов](jwt-auth.md)
