import { registerGeneratedBindings } from "../Binding/autoBindings";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, createToken, singleton, type DiContainer } from "@/core/di";
import { Validator, modelValidatorAdapter } from "@/library/validation";
import {
  ActionFilter,
  ApiVersion,
  Catch,
  Controller,
  Created,
  Get,
  HttpCode,
  HttpServer,
  Middleware,
  NotFound,
  Post,
  Produces,
  Redirect,
  httpModule,
  useModelValidator,
  type HttpContext,
  type HttpMiddleware,
  type ResponseBuilder,
} from "@/core/http";

// ── Тестовое приложение ─────────────────────────────────────────────────────

interface UsersService {
  byId(id: number): { id: number; name: string } | undefined;
}
const USERS = createToken<UsersService>("E2eUsersService");

class InMemoryUsers implements UsersService {
  byId(id: number) {
    return id === 1 ? { id: 1, name: "Alice" } : undefined;
  }
}

class EntityMissingError extends Error {}

class CreateUserDto {
  @Validator({ required: true, minLength: 3 })
  name!: string;

  @Validator({ min: 18 })
  age?: number;
}

const markerMiddleware =
  (name: string): HttpMiddleware =>
  async (ctx, next) => {
    await next();
    ctx.response?.headers.append("x-trace", name);
  };

@Controller("users")
@Middleware(markerMiddleware("controller"))
class E2eUsersController {
  static inject = [USERS] as const;
  constructor(private readonly users: UsersService) {}

  @Get(":id(int)")
  getById(id: number) {
    const user = this.users.byId(id);
    if (!user) {
      throw new EntityMissingError(`user ${id} not found`);
    }
    return user;
  }

  @Get("search")
  search(q: string, limit: number = 10) {
    return { q, limit };
  }

  @Post()
  @HttpCode(201)
  create(dto: CreateUserDto) {
    return { created: dto.name };
  }

  @Catch(EntityMissingError)
  onMissing(error: EntityMissingError) {
    return NotFound({ error: error.message });
  }
}
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(E2eUsersController, {
  getById: [{source: "route", name: "id", type: "number", optional: false}],
  search: [{source: "query", name: "q", optional: false}, {source: "query", name: "limit", type: "number", optional: true}],
  create: [{source: "body", model: "CreateUserDto"}],
}, new Map([["CreateUserDto", CreateUserDto]]));

@Controller("misc")
class MiscController {
  @Get("text")
  @Produces("text/csv")
  text() {
    return "a;b;c";
  }

  @Get("explicit")
  explicitResponse() {
    return new Response("raw", { status: 418 });
  }

  @Get("created")
  created() {
    return Created("/misc/42", { id: 42 });
  }

  @Get("redirect")
  redirect() {
    return Redirect("/misc/text");
  }

  @Get("builder")
  builder(res: ResponseBuilder) {
    res.status(202).header("x-custom", "yes");
    return { queued: true };
  }

  @Get("services")
  services(ctx: HttpContext) {
    const users = ctx.services.resolve(USERS);
    return { hasAlice: users.byId(1) !== undefined };
  }

  @Get("fail")
  fail(): never {
    throw new Error("secret internals");
  }

  @Get("header")
  header(ctx: HttpContext) {
    const token = ctx.header("x-token");
    return { token: token ?? null };
  }

  @Get("inline", { code: 207, produces: "text/x-inline", middleware: [markerMiddleware("inline")] })
  inline() {
    return "multi";
  }

  @Post({ code: 202 })
  enqueue() {
    return { queued: true };
  }

  @Get("filtered")
  @ActionFilter({
    after: (_ctx, result) => ({ ...(result as object), wrapped: true }),
  })
  filtered() {
    return { value: 1 };
  }

  @Get("files/*path")
  files(path: string, ctx: HttpContext) {
    return { path, url: ctx.path };
  }
}
registerGeneratedBindings(MiscController, {
  builder: [{source: "response"}],
  files: [{source: "route", name: "path", optional: false}, {source: "context"}],
}, new Map([]));

@Controller("data")
@ApiVersion("1.0")
class DataV1Controller {
  @Get()
  get() {
    return { version: 1 };
  }
}

@Controller("data")
@ApiVersion("2.0")
class DataV2Controller {
  @Get()
  get() {
    return { version: 2 };
  }
}

// ── Инфраструктура тестов ───────────────────────────────────────────────────

let container: DiContainer;
let server: HttpServer;
let base: string;

beforeAll(async () => {
  useModelValidator(modelValidatorAdapter);

  @Module({
    providers: [singleton(USERS, InMemoryUsers)],
  })
  class E2eServicesModule {}

  @Module({
    imports: [E2eServicesModule],
    controllers: [E2eUsersController, MiscController, DataV1Controller, DataV2Controller],
  })
  class E2eControllersModule {}

  @Module({
    imports: [
      httpModule({
        imports: [E2eControllersModule],
        port: 0,
        prefix: "api",
        cors: { origin: "https://app.example.com", credentials: true },
        versioning: { source: "query", parameterName: "v", defaultVersion: "1.0" },
        middleware: [markerMiddleware("global")],
      }),
    ],
  })
  class E2eAppModule {}

  container = createContainer(E2eAppModule, { validateOnBuild: true });
  server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  await container.dispose();
});

// ── Тесты ───────────────────────────────────────────────────────────────────

describe("маршрутизация и привязка", () => {
  test("GET с int-параметром и DI-зависимостью контроллера", async () => {
    const response = await fetch(`${base}/api/users/1?v=`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1, name: "Alice" });
  });

  test("нарушение ограничения int -> 404", async () => {
    const response = await fetch(`${base}/api/users/abc`);
    expect(response.status).toBe(404);
  });

  test("query: обязательный и с default", async () => {
    const ok = await fetch(`${base}/api/users/search?q=test`);
    expect(await ok.json()).toEqual({ q: "test", limit: 10 });

    const custom = await fetch(`${base}/api/users/search?q=test&limit=5`);
    expect(await custom.json()).toEqual({ q: "test", limit: 5 });

    const missing = await fetch(`${base}/api/users/search`);
    expect(missing.status).toBe(400);

    const badType = await fetch(`${base}/api/users/search?q=x&limit=abc`);
    expect(badType.status).toBe(400);
  });

  test("wildcard и Ctx-привязка", async () => {
    const response = await fetch(`${base}/api/misc/files/css/site.css`);
    expect(await response.json()).toEqual({ path: "css/site.css", url: "/api/misc/files/css/site.css" });
  });

  test("опциональный заголовок", async () => {
    const without = await fetch(`${base}/api/misc/header`);
    expect(await without.json()).toEqual({ token: null });
    const with_ = await fetch(`${base}/api/misc/header`, { headers: { "x-token": "abc" } });
    expect(await with_.json()).toEqual({ token: "abc" });
  });

  test("FromServices: сервис из scope запроса", async () => {
    const response = await fetch(`${base}/api/misc/services`);
    expect(await response.json()).toEqual({ hasAlice: true });
  });

  test("404 и 405 c Allow", async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const blocked = await fetch(`${base}/api/users/search`, { method: "DELETE" });
    expect(blocked.status).toBe(405);
    expect(blocked.headers.get("allow")).toContain("GET");
  });
});

describe("тело запроса и валидация", () => {
  test("валидный DTO -> 201 (@HttpCode)", async () => {
    const response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bob", age: 30 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: "Bob" });
  });

  test("невалидный DTO -> 400 со списком ошибок", async () => {
    const response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", age: 10 }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; details: { property: string }[] };
    expect(payload.error).toBe("Validation failed");
    expect(payload.details.map((d) => d.property).sort()).toEqual(["age", "name"]);
  });

  test("битый JSON -> 400, prototype pollution отфильтрован", async () => {
    const broken = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);

    const polluted = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Eve", __proto__: { hacked: true }, constructor: { x: 1 } }),
    });
    expect(polluted.status).toBe(201);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  test("body-model binding rejects simple text/plain and accepts +json", async () => {
    const plain = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "Eve", age: 20 }),
    });
    expect(plain.status).toBe(415);

    const vendorJson = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/vnd.osnova+json" },
      body: JSON.stringify({ name: "Eve", age: 20 }),
    });
    expect(vendorJson.status).toBe(201);
  });
});

describe("ответы", () => {
  test("Produces задаёт Content-Type строки", async () => {
    const response = await fetch(`${base}/api/misc/text`);
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(await response.text()).toBe("a;b;c");
  });

  test("прямой Response возвращается как есть", async () => {
    const response = await fetch(`${base}/api/misc/explicit`);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("raw");
  });

  test("Created с Location", async () => {
    const response = await fetch(`${base}/api/misc/created`);
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/misc/42");
  });

  test("Redirect 302", async () => {
    const response = await fetch(`${base}/api/misc/redirect`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/misc/text");
  });

  test("inline-опции маршрута: code, produces, middleware", async () => {
    const response = await fetch(`${base}/api/misc/inline`);
    expect(response.status).toBe(207);
    expect(response.headers.get("content-type")).toBe("text/x-inline");
    expect(response.headers.get("x-trace")).toContain("inline");
    expect(await response.text()).toBe("multi");
  });

  test("inline-опции первым аргументом при пустом пути", async () => {
    const response = await fetch(`${base}/api/misc`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
  });

  test("ResponseBuilder: статус и заголовки для plain-результата", async () => {
    const response = await fetch(`${base}/api/misc/builder`);
    expect(response.status).toBe(202);
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(await response.json()).toEqual({ queued: true });
  });
});

describe("ошибки, фильтры, middleware", () => {
  test("@Catch контроллера превращает доменную ошибку в 404", async () => {
    const response = await fetch(`${base}/api/users/999`);
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("user 999 not found");
  });

  test("необработанное исключение -> 500 без деталей", async () => {
    const response = await fetch(`${base}/api/misc/fail`);
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string; message?: string };
    expect(payload.error).toBe("Internal Server Error");
    expect(payload.message).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("secret internals");
  });

  test("ActionFilter.after подменяет результат", async () => {
    const response = await fetch(`${base}/api/misc/filtered`);
    expect(await response.json()).toEqual({ value: 1, wrapped: true });
  });

  test("порядок middleware: global снаружи controller", async () => {
    const response = await fetch(`${base}/api/users/1`);
    // Заголовки добавляются после next() — изнутри наружу.
    expect(response.headers.get("x-trace")).toBe("controller, global");
  });
});

describe("версионирование (query source)", () => {
  test("v=1.0 и v=2.0 попадают в разные контроллеры", async () => {
    const v1 = await fetch(`${base}/api/data?v=1.0`);
    expect(await v1.json()).toEqual({ version: 1 });
    const v2 = await fetch(`${base}/api/data?v=2.0`);
    expect(await v2.json()).toEqual({ version: 2 });
  });

  test("без параметра действует defaultVersion", async () => {
    const response = await fetch(`${base}/api/data`);
    expect(await response.json()).toEqual({ version: 1 });
  });

  test("несуществующая версия -> 400 со списком поддерживаемых", async () => {
    const response = await fetch(`${base}/api/data?v=9.9`);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { details: { supported: string[] } };
    expect(payload.details.supported.sort()).toEqual(["1.0", "2.0"]);
  });
});

describe("CORS", () => {
  test("preflight отвечает 204 с заголовками без вызова роутов", async () => {
    const response = await fetch(`${base}/api/users/1`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  test("обычный запрос с Origin получает CORS-заголовки; чужой Origin — нет", async () => {
    const allowed = await fetch(`${base}/api/users/1`, { headers: { origin: "https://app.example.com" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

    const denied = await fetch(`${base}/api/users/1`, { headers: { origin: "https://evil.example.com" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
