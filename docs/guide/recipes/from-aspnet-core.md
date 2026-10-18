# Если вы пришли с ASP.NET Core

Многое в bazis устроено как в ASP.NET Core:
- внедрение через конструктор;
- `singleton` / `scoped` / `transient`;
- контроллеры с атрибутами;
- конвейер middleware;
- настройки с окружениями;
- `DbContext` с `saveChanges`;
- проверка графа сервисов при запуске.

Ниже — что как называется, что устроено иначе и одно и то же приложение на
двух фреймворках.

Примеры bazis проверены на 0.100.6. Код C# — для сравнения, его мы не
запускали.

## Коротко о различиях

- **Модули вместо одного `Program.cs`.** Сервисы регистрируются не в общем
  `builder.Services`, а в модуле, которому принадлежат. Что модуль
  `exports`, видно остальным; остальное — только ему.
- **Атрибуты привязки — типы.** Источник bazis выбирает по имени и типу
  параметра, как `[ApiController]`. Явно — тип-маркер с тем же именем:
  `FromQuery<number, "page_size">`, `FromHeader<string, "x-request-id">`,
  `FromRoute<number>`, `FromBody<T>`; на свойствах модели —
  `@FromQuery("page_size")`, как `[FromQuery(Name = …)]`.
- **Зависимости записывает кодогенерация.** В TypeScript нет рефлексии
  типов во время выполнения, поэтому `bazis codegen` (его запускают `dev`,
  `test` и `build`) сохраняет зависимости конструкторов в `src/generated`.
- **Интерфейс — не токен.** Интерфейсы TypeScript исчезают при компиляции.
  Контракт сервиса — абстрактный класс: `singleton(IBookStore,
  MemoryBookStore)` вместо `AddSingleton<IBookStore, MemoryBookStore>()`.
- **Ошибки — не `ProblemDetails`.** Тело ошибки — `{"error": …,
  "details": …}` ([Ошибки](../overview/errors.md)).

## Что как называется

| ASP.NET Core | bazis | Где читать |
| --- | --- | --- |
| `WebApplication.CreateBuilder` … `app.Run()` | `runApp(AppModule, { http })` | [Приложение](../overview/application.md) |
| `builder.Services.Add…` в `Program.cs` | `providers` модуля | [Модули](../overview/modules.md) |
| `AddSingleton` / `AddScoped` / `AddTransient` | `singleton` / `scoped` / `transient` | [Провайдеры](../overview/providers.md#время-жизни) |
| `AddSingleton<IService, Impl>()` | `singleton(IService, Impl)`, `IService` — абстрактный класс | [Провайдеры](../overview/providers.md#регистрация-по-контракту) |
| Keyed services, `IEnumerable<T>`, `Lazy<T>` | Ключи, несколько реализаций, ленивые зависимости | [Внедрение зависимостей](../fundamentals/dependency-injection.md) |
| `ValidateScopes`, `ValidateOnBuild` | Всегда, в любом окружении | [Провайдеры](../overview/providers.md#ошибки-которые-ловятся-при-старте) |
| `[ApiController]`, `ControllerBase` | `@Controller` | [Контроллеры](../overview/controllers.md) |
| `[HttpGet("{id:int}")]` | `@Get(":id(int)")` | [Контроллеры](../overview/controllers.md#маршруты) |
| `[FromRoute]`, `[FromQuery]`, `[FromBody]`, `[FromHeader]` | Имя и тип параметра или маркеры `FromRoute<T>`, `FromQuery<T>`, `FromBody<T>`, `FromHeader<T>` | [Контроллеры](../overview/controllers.md#явный-источник-fromquery-fromheader-frombody-fromroute) |
| `[FromQuery] SearchQuery query` с DataAnnotations | `query: FromQuery<SearchQuery>` с `@Validator` на полях | [Модели строки запроса](../overview/controllers.md#модели-строки-запроса-и-заголовков) |
| `[FromQuery(Name = "page_size")]` на свойстве | `@FromQuery("page_size")` на поле | [Модели строки запроса](../overview/controllers.md#модели-строки-запроса-и-заголовков) |
| Model state: все ошибки привязки и проверки в одном `400` | Так же: `Validation failed` и все нарушения в `details` | [Контроллеры](../overview/controllers.md#модели-строки-запроса-и-заголовков) |
| `HttpContext` | `ctx: HttpContext` | [Контроллеры](../overview/controllers.md#httpcontext) |
| DataAnnotations, автоматический `400` | `@Validator` на полях класса, тоже `400`; `@RequestModel()` — по желанию | [Проверка данных](../overview/validation.md) |
| `Ok()`, `CreatedAtAction()`, `NoContent()` | `Ok`, `Created`, `NoContent` | [Ответы](../overview/responses.md#помощники) |
| `IOptions<T>` + `ValidateOnStart` | `defineConfig` + `ConfigView<T>`, проверка всегда при запуске | [Конфигурация](../fundamentals/configuration.md) |
| `appsettings.{Environment}.json` | Разделы `default`, `development`, `test`, `production` в `defineConfig` | [Конфигурация](../fundamentals/configuration.md#окружения) |
| `ASPNETCORE_ENVIRONMENT` | `BAZIS_ENV` | [Конфигурация](../fundamentals/configuration.md#окружения) |
| `Books__PageSize` | `BAZIS_BOOKS__PAGESIZE` | [Имена переменных](../fundamentals/configuration.md#имена-переменных-окружения) |
| User Secrets, Key Vault | `secret()`, файлы секретов | [Секреты](../security/secrets.md) |
| `app.Use…`, `IMiddleware` | `HttpMiddleware` в `http.middleware` | [Middleware](../overview/middleware.md) |
| Action filters | `@ActionFilter` | [Фильтры действий](../overview/middleware.md#фильтры-действий) |
| `UseExceptionHandler`, exception filters | Middleware, переводящий ошибку в `HttpError` | [Ошибки](../overview/errors.md#доменные-ошибки) |
| `[Authorize(Policy = …)]`, `IAuthorizationFilter` | `@Authorize(check)` | [Авторизация](../overview/authorization.md) |
| JWT Bearer | `bazis/library/jwt` + `bearerToken` | [JWT](../security/jwt.md) |
| `IHostedService.StartAsync` | `LifecycleHook.onInit` | [Жизненный цикл](../fundamentals/lifecycle.md#хуки-жизненного-цикла) |
| `BackgroundService.ExecuteAsync` | `BackgroundService.execute` в поле `background` модуля | [Жизненный цикл](../fundamentals/lifecycle.md#фоновые-службы) |
| `PeriodicTimer` в фоновой службе | `PeriodicBackgroundService` | [Фоновые службы](../realtime/background-services.md) |
| `CancellationToken` | `AbortSignal` | [Жизненный цикл](../fundamentals/lifecycle.md#отмена) |
| `ILogger<T>` | `Logger` | [Журнал](../fundamentals/logging.md) |
| `AddHealthChecks`, `IHealthCheck` | `health: true`, `HEALTH_CHECK` | [Health](../fundamentals/health-checks.md) |
| `[OutputCache]` | `@OutputCache` | [Кэш ответов](../http/output-cache.md) |
| `AddRateLimiter` | `rateLimit` | [Ограничение частоты](../http/rate-limit.md) |
| `Asp.Versioning` | `@ApiVersion` | [Версии API](../http/versioning.md) |
| `IHttpClientFactory` | `HttpClient` из `bazis/core/http-client` | [HTTP-клиент](../http/http-client.md) |
| SignalR | WebSocket-шлюз | [WebSocket](../realtime/websocket.md) |
| Grpc.AspNetCore | gRPC | [gRPC](../realtime/grpc.md) |
| Swashbuckle | Не нужен: OpenAPI строит кодогенерация, `/docs` | [OpenAPI](../http/openapi.md) |
| EF Core: `DbContext`, `DbSet`, `SaveChangesAsync` | `DbContext`, `DbSet`, `saveChanges` | [DbContext](../database/dbcontext.md) |
| `WebApplicationFactory` + `ConfigureTestServices` | `startTestApp(AppModule, { overrides })` | [Тестирование](../fundamentals/testing.md#http-starttestapp) |
| `dotnet new webapi` | `bazis new` | [Команды CLI](../cli/commands.md#bazis-new) |
| `dotnet publish -p:PublishSingleFile=true` | `bazis build --bin` | [Один исполняемый файл](../deployment/single-executable.md) |

## Одно приложение на двух фреймворках

Каталог книг:
- поиск;
- книга по номеру;
- добавление книги, только с ключом администратора;
- своя ошибка «книга не найдена».

### Регистрация

```csharp
// ASP.NET Core: Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.Configure<BooksOptions>(builder.Configuration.GetSection("Books"));
builder.Services.AddSingleton<IBookStore, MemoryBookStore>();
builder.Services.AddScoped<BooksService>();
builder.Services.AddScoped<AdminKeyFilter>();
builder.Services.AddHostedService<WarmUp>();
builder.Services.AddControllers();

var app = builder.Build();
app.UseMiddleware<BookErrorsMiddleware>();
app.MapControllers();
app.Run();
```

```ts
// bazis: Books.module.ts
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

// bazis: src/index.ts
await runApp(AppModule, { http: { /* … */ health: true, middleware: [bookErrors] } });
```

Контроллеры в `providers` не регистрируются: как и в ASP.NET, контроллер
создаётся на каждый запрос.

### Контракт и сервис

```csharp
// ASP.NET Core
public interface IBookStore { IEnumerable<Book> All(); Book? Find(int id); Book Add(string title, string author); }

public class BooksService(IBookStore store, IOptions<BooksOptions> options)
{
    public IEnumerable<Book> Search(string q, int limit) =>
        store.All().Where(b => b.Title.Contains(q, StringComparison.OrdinalIgnoreCase))
                   .Take(Math.Min(limit, options.Value.PageSize));

    public Book Get(int id) => store.Find(id) ?? throw new BookNotFoundException(id);
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

`abstract class` вместо `interface` — единственная уступка: такой контракт
существует во время выполнения, по нему контейнер и находит реализацию.

### Настройки

```csharp
// ASP.NET Core
public class BooksOptions { public int PageSize { get; set; } = 20; public string AdminKey { get; set; } = ""; }
// appsettings.json: { "Books": { "PageSize": 20 } }; секрет — User Secrets или Key Vault
```

```ts
// bazis
export interface BooksConfig { pageSize: number; adminKey: Secret }

export const booksConfig = defineConfig<BooksConfig>("books", {
  default: { pageSize: 20, adminKey: secret("dev-admin-key") },
  production: { adminKey: secret() },
});
```

- Значения по умолчанию и переопределения для окружений лежат в одном
  месте, а не в нескольких `appsettings.*.json`.
- Переменные окружения именуются, как в ASP.NET, через `__`, с префиксом
  `BAZIS_`. Проверено: `BAZIS_BOOKS__PAGESIZE=2` ограничивает поиск двумя
  книгами.
- Проверка — всегда при запуске, как `ValidateOnStart`. Неверный тип
  останавливает приложение:

  ```text
  [bazis] configuration error: Invalid configuration (environment "development"): books.pageSize — expected a finite number, got "abc" (BAZIS_BOOKS__PAGESIZE).
  ```

- Секрет production без значения тоже останавливает запуск:

  ```text
  [bazis] configuration error: Invalid configuration (environment "production"): books.adminKey — required non-empty secret is not set (BAZIS_BOOKS__ADMINKEY).
  ```

**Окружение по умолчанию — production**, как в ASP.NET без
`ASPNETCORE_ENVIRONMENT`. `bazis dev` выставляет `development`, в `bazis test`
среда — `test` (её задаёт `bun test` через `NODE_ENV`). При запуске
напрямую — `bun run src/index.ts` или собранного файла — задайте `BAZIS_ENV`.

### Контроллер

```csharp
// ASP.NET Core
[ApiController]
[Route("books")]
public class BooksController(BooksService books) : ControllerBase
{
    [HttpGet]
    [ServiceFilter(typeof(WrapFilter))]
    public IEnumerable<Book> Search([FromQuery] string q, [FromQuery] int limit = 10) => books.Search(q, limit);

    [HttpGet("{id:int}")]
    public Book Get(int id) => books.Get(id);

    [HttpPost]
    [ServiceFilter(typeof(AdminKeyFilter))]
    public IActionResult Add(AddBookRequest body)
    {
        var book = books.Add(body.Title, body.Author);
        return CreatedAtAction(nameof(Get), new { id = book.Id }, book);
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
| `body: AddBookRequest` | Класс из исходников приложения — из JSON-тела, с проверкой |
| `ctx: HttpContext` | Контекст запроса |

Ограничение `:id(int)` работает как `{id:int}`: `/books/abc` не совпадает
с маршрутом и получает `404`, а не `400`.

### Модель запроса

```csharp
// ASP.NET Core
public record AddBookRequest(
    [Required, StringLength(200, MinimumLength = 1)] string Title,
    [Required, StringLength(100, MinimumLength = 1)] string Author);
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

Как `[ApiController]`, bazis отвечает `400` до вызова метода. Поля,
которых нет в классе, отбрасываются. `@RequestModel()` не обязателен —
как и `[FromBody]`, источник понятен по типу; нужен он лишь классу из
другого пакета.

### Фильтр авторизации

```csharp
// ASP.NET Core
public class AdminKeyFilter(IOptions<BooksOptions> options) : IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext context)
    {
        var key = context.HttpContext.Request.Headers["x-admin-key"].ToString();
        if (key == "") context.Result = new UnauthorizedResult();
        else if (key != options.Value.AdminKey) context.Result = new StatusCodeResult(403);
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

Проверка — функция, а не класс. Сервисы запроса она берёт из
`ctx.services`, как `HttpContext.RequestServices`.
- `false` — ответ `403`.
- `UnauthorizedError` — ответ `401`.

### Middleware для доменной ошибки

```csharp
// ASP.NET Core
public class BookErrorsMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        try { await next(context); }
        catch (BookNotFoundException e)
        {
            context.Response.StatusCode = 404;
            await context.Response.WriteAsJsonAsync(new { error = e.Message, details = new { id = e.Id } });
        }
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
```

Ответ пишет не middleware, а bazis: брошенная `HttpError` превращается в
ответ с нужным кодом и телом.

### `IHostedService` → `LifecycleHook`

```csharp
// ASP.NET Core
public class WarmUp(IBookStore store, ILogger<WarmUp> logger) : IHostedService
{
    public Task StartAsync(CancellationToken ct) { logger.LogInformation("books ready: {Count}", store.All().Count()); return Task.CompletedTask; }
    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

```ts
// bazis
/** Runs once at start, like IHostedService.StartAsync. */
export class WarmUp implements LifecycleHook {
  constructor(private readonly store: IBookStore, private readonly logger: Logger) {}

  onInit() {
    this.logger.info("books ready", { count: this.store.all().length });
  }
}
// в модуле: singleton(LIFECYCLE_HOOK, WarmUp)
```

Долгая работа на всё время жизни приложения, как `BackgroundService`,
оформляется так же: наследник `BackgroundService` с методом `execute(signal)`
в поле `background` модуля ([Жизненный цикл](../fundamentals/lifecycle.md#фоновые-службы)).

### Захваченная зависимость

Как `ValidateScopes` в Development, только в любом окружении. Если `WarmUp`
(singleton) попросит scoped-сервис `BooksService`, приложение не
запустится:

```text
[bazis] configuration error: Service graph validation failed:
Singleton "WarmUp (as BazisLifecycleHook)" depends on scoped "BooksService". A scoped service lives for one request or scope: make "WarmUp" scoped too, or inject ServiceProvider and resolve "BooksService" in a scope you create (provider.createScope()).
```

`BazisLifecycleHook` — имя токена `LIFECYCLE_HOOK`, под которым
зарегистрирован `WarmUp`. `ServiceProvider` и `createScope()` — то же, что
`IServiceScopeFactory.CreateScope()`.

### Что получилось

```text
GET  /books?q=du&limit=5          → {"items":[{"id":1,"title":"Dune","author":"Herbert"}],"servedAt":"now"}
GET  /books                       → 400 {"error":"Validation failed","details":[{"property":"q","message":"Field \"q\" is required","code":"required"}]}
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
GET  /docs                        → 200 (OpenAPI без Swashbuckle)

info: books ready {"count":1}
```

### Тест

```csharp
// ASP.NET Core
public class BooksTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Get_uses_replaced_store()
    {
        var client = factory.WithWebHostBuilder(b => b.ConfigureTestServices(
            s => s.AddSingleton<IBookStore, FakeStore>())).CreateClient();
        var book = await client.GetFromJsonAsync<Book>("/books/7");
        Assert.Equal("Test Book", book!.Title);
    }
}
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

> [!WARNING]
> `WebApplicationFactory` запускает ваш `Program.cs`, а `startTestApp` —
> только модуль. Настройки HTTP из `src/index.ts` — middleware,
> обработчик ошибок — передайте в `http` теста сами. Без `bookErrors`
> выше `/books/1` вернул бы `500`, а не `404`. Удобно вынести общие
> настройки в одну функцию, как `startPlanner()` в рецепте
> [JWT](jwt-auth.md).

## Дальше

- [Первые шаги](../introduction/first-steps.md)
- [CRUD-модуль целиком](crud-module.md)
- [Один исполняемый файл](../deployment/single-executable.md)
