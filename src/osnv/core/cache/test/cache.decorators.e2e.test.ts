import { registerGeneratedBindings } from "../../http/Binding/autoBindings";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Module, createToken, createContainer, HOSTED_SERVICE, type DiContainer } from "@/core/di";
import {
  OUTPUT_CACHE_PRINCIPAL_STATE_KEY,
  Cacheable,
  ICache,
  MemoryCache,
  OutputCache,
  memory,
  cachedSingleton,
  wrapCachedService,
} from "@/core/cache";
import {
  ActionFilter,
  Controller,
  ForbiddenError,
  Get,
  HttpServer,
  Middleware,
  httpModule,
  type HttpContext,
  type HttpMiddleware,
} from "@/core/http";

interface IGreetingService {
  greet(name: string): string;
}

const IGreetingService = createToken<IGreetingService>("IGreetingService");

let greetCalls = 0;
let oversizedResponseCalls = 0;
let optionalAuthCalls = 0;
let boundaryControllerConstructions = 0;
let boundaryActionCalls = 0;
let methodPermissionChecks = 0;
let inlineRateChecks = 0;
let filterPermissionChecks = 0;

const methodPermission: HttpMiddleware = async (ctx, next) => {
  methodPermissionChecks += 1;
  if (ctx.header("x-method-permitted") !== "yes") {
    ctx.response = new Response("Method policy denied", { status: 403 });
    return;
  }
  await next();
};

const inlineRateCounter: HttpMiddleware = async (_ctx, next) => {
  inlineRateChecks += 1;
  await next();
};

class GreetingService implements IGreetingService {
  @Cacheable({ seconds: 60, key: (...args: readonly unknown[]) => `greet:${String(args[0])}` })
  greet(name: string): string {
    greetCalls += 1;
    return `hello, ${name}`;
  }
}

@Controller("catalog")
class CatalogController {
  @Get("items")
  @OutputCache({ seconds: 60, varyByQuery: ["limit"] })
  list() {
    return { items: ["a", "b"] };
  }

  @Get("large")
  @OutputCache({ seconds: 60, maxBodyBytes: 4 })
  large(): Response {
    oversizedResponseCalls += 1;
    return new Response("12345", { headers: { "content-type": "text/plain" } });
  }

  @Get("optional-auth")
  @OutputCache({ seconds: 60 })
  optionalAuth(ctx: HttpContext) {
    optionalAuthCalls += 1;
    const principal = ctx.state.get(OUTPUT_CACHE_PRINCIPAL_STATE_KEY) as { subject?: string } | undefined;
    return { subject: principal?.subject ?? "anonymous" };
  }

  @Get("personalized")
  @OutputCache({ seconds: 60, varyByUser: true, clientCache: { maxAge: 60 } })
  personalized() {
    return { ok: true };
  }
}
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(CatalogController, {
  optionalAuth: [{source: "context"}],
}, new Map([]));

@Controller("cache-boundary")
class CacheBoundaryController {
  constructor() {
    boundaryControllerConstructions += 1;
  }

  @Get("value", { middleware: [inlineRateCounter] })
  @Middleware(methodPermission)
  @ActionFilter({
    before: (ctx) => {
      filterPermissionChecks += 1;
      if (ctx.header("x-filter-permitted") !== "yes") {
        throw new ForbiddenError("Filter policy denied");
      }
    },
  })
  @OutputCache({ seconds: 60 })
  value() {
    boundaryActionCalls += 1;
    return { generation: boundaryActionCalls };
  }
}

@Controller("collision-a")
class CollisionControllerA {
  @Get()
  @OutputCache({ seconds: 60 })
  value() {
    return { source: "a" };
  }
}

@Controller("collision-b")
class CollisionControllerB {
  @Get()
  @OutputCache({ seconds: 60 })
  value() {
    return { source: "b" };
  }
}

// Reproduce two independently loaded classes with the same runtime name.
Object.defineProperty(CollisionControllerA, "name", { value: "CollisionController" });
Object.defineProperty(CollisionControllerB, "name", { value: "CollisionController" });

describe("@OutputCache HTTP e2e", () => {
  let server: HttpServer;
  let base: string;
  let cache: ICache;

  beforeAll(async () => {
    const cacheModuleRef = memory({ maxEntries: 1000 });

    @Module({
      imports: [
        cacheModuleRef,
        httpModule({
          imports: [cacheModuleRef],
          controllers: [CatalogController, CacheBoundaryController, CollisionControllerA, CollisionControllerB],
          port: 0,
          prefix: "api",
          middleware: [async (ctx, next) => {
            const subject = ctx.header("x-test-user");
            if (subject !== undefined) {
              ctx.state.set(OUTPUT_CACHE_PRINCIPAL_STATE_KEY, { subject });
            }
            await next();
          }],
        }),
      ],
    })
    class OutputCacheE2eModule {}

    const container = createContainer(OutputCacheE2eModule, { validateOnBuild: true });
    cache = container.resolve(ICache);
    server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
    await server.start();
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop();
  });

  test("varies cache key by query parameter", async () => {
    cache.clear();

    const r1 = await fetch(`${base}/api/catalog/items?limit=10`);
    const r2 = await fetch(`${base}/api/catalog/items?limit=10`);
    const r3 = await fetch(`${base}/api/catalog/items?limit=20`);

    expect(r1.status).toBe(200);
    const body1 = await r1.json();
    const body2 = await r2.json();
    const body3 = await r3.json();
    expect(body1).toEqual(body2);
    expect(body1).toEqual({ items: ["a", "b"] });
    expect(body3).toEqual({ items: ["a", "b"] });
    expect(cache.size).toBe(2);
  });

  test("serves an oversized response normally without buffering it into cache", async () => {
    cache.clear();
    oversizedResponseCalls = 0;

    const first = await fetch(`${base}/api/catalog/large`);
    const second = await fetch(`${base}/api/catalog/large`);

    expect(await first.text()).toBe("12345");
    expect(await second.text()).toBe("12345");
    expect(oversizedResponseCalls).toBe(2);
    expect(cache.size).toBe(0);
  });

  test("isolates same-named controller actions by their concrete route path", async () => {
    cache.clear();

    const first = await fetch(`${base}/api/collision-a`);
    const second = await fetch(`${base}/api/collision-b`);

    expect(await first.json()).toEqual({ source: "a" });
    expect(await second.json()).toEqual({ source: "b" });
    expect(cache.size).toBe(2);
  });

  test("does not share an optional-auth response without an explicit opt-in", async () => {
    cache.clear();
    optionalAuthCalls = 0;

    const firstUser = await fetch(`${base}/api/catalog/optional-auth`, { headers: { "x-test-user": "alice" } });
    const secondUser = await fetch(`${base}/api/catalog/optional-auth`, { headers: { "x-test-user": "bob" } });
    expect(await firstUser.json()).toEqual({ subject: "alice" });
    expect(await secondUser.json()).toEqual({ subject: "bob" });
    expect(optionalAuthCalls).toBe(2);
    expect(cache.size).toBe(0);

    await fetch(`${base}/api/catalog/optional-auth`);
    await fetch(`${base}/api/catalog/optional-auth`);
    expect(optionalAuthCalls).toBe(3);
    expect(cache.size).toBe(1);
  });

  test("forces personalized client cache directives private", async () => {
    cache.clear();
    const response = await fetch(`${base}/api/catalog/personalized`, {
      headers: { "x-test-user": "alice" },
    });
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
  });

  test("cache hits still execute method/inline middleware and ActionFilter.before policies", async () => {
    cache.clear();
    boundaryControllerConstructions = 0;
    boundaryActionCalls = 0;
    methodPermissionChecks = 0;
    inlineRateChecks = 0;
    filterPermissionChecks = 0;

    const allowedHeaders = {
      "x-method-permitted": "yes",
      "x-filter-permitted": "yes",
    };
    const first = await fetch(`${base}/api/cache-boundary/value`, { headers: allowedHeaders });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ generation: 1 });

    const filterDenied = await fetch(`${base}/api/cache-boundary/value`, {
      headers: { "x-method-permitted": "yes" },
    });
    expect(filterDenied.status).toBe(403);

    const hit = await fetch(`${base}/api/cache-boundary/value`, { headers: allowedHeaders });
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ generation: 1 });

    const methodDenied = await fetch(`${base}/api/cache-boundary/value`, {
      headers: { "x-filter-permitted": "yes" },
    });
    expect(methodDenied.status).toBe(403);

    expect(methodPermissionChecks).toBe(4);
    expect(inlineRateChecks).toBeGreaterThanOrEqual(3);
    expect(filterPermissionChecks).toBe(3);
    expect(boundaryControllerConstructions).toBe(1);
    expect(boundaryActionCalls).toBe(1);
  });
});

describe("@Cacheable service cache", () => {
  let container: DiContainer;
  let cache: ICache;

  beforeAll(() => {
    greetCalls = 0;
    const cacheModuleRef = memory();

    @Module({
      imports: [cacheModuleRef],
      providers: [cachedSingleton(IGreetingService, GreetingService)],
    })
    class CacheableUnitModule {}

    container = createContainer(CacheableUnitModule, { validateOnBuild: true });
    cache = container.resolve(ICache);
  });

  test("works through interface token when registered with cachedSingleton", () => {
    cache.clear();
    greetCalls = 0;

    const service = container.resolve(IGreetingService);
    expect(service.greet("alice")).toBe("hello, alice");
    expect(service.greet("alice")).toBe("hello, alice");
    expect(greetCalls).toBe(1);
  });

  test("wrapCachedService applies @Cacheable metadata on raw instance", () => {
    cache.clear();
    greetCalls = 0;

    const raw = wrapCachedService(new GreetingService(), { memoryCache: cache, policies: {} });
    expect(raw.greet("bob")).toBe("hello, bob");
    expect(raw.greet("bob")).toBe("hello, bob");
    expect(greetCalls).toBe(1);
  });

  test("plain singleton without cachedSingleton ignores @Cacheable", () => {
    cache.clear();
    greetCalls = 0;

    const plain = new GreetingService();
    expect(plain.greet("z")).toBe("hello, z");
    expect(plain.greet("z")).toBe("hello, z");
    expect(greetCalls).toBe(2);
  });
});

describe("ICache tags", () => {
  test("evictByTag removes grouped entries", () => {
    const local = new MemoryCache<number>();
    local.set("a", 1, { tags: ["group"] });
    local.set("b", 2, { tags: ["group"] });
    local.set("c", 3, { tags: ["other"] });
    expect(local.evictByTag("group")).toBe(2);
    expect(local.get("a")).toBeUndefined();
    expect(local.get("b")).toBeUndefined();
    expect(local.get("c")).toBe(3);
  });
});
