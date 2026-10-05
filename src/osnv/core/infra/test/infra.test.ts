import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { createContainer, createToken, Global, HOSTED_SERVICE, Module, singletonValue, type HostedService } from "@/core/di";
import { Configuration, defineConfig, HEALTH_CHECK, LifecycleCoordinator, Osnv, secret, type HealthCheck } from "@/core/kernel";
import {
  Infra,
  infraModule,
  InfraError,
  InfraLifecycle,
  OpenSearchClient,
  OPENSEARCH,
  openSearchConnect,
  POSTGRES,
  postgres,
  REDIS,
  redisConnect,
  type InfraManifest,
  type InfraConnector,
} from "@/core/infra";

function containerFor(manifest: InfraManifest) {
  // Configuration больше не используется коннекторами (конфиг приходит объектом),
  // но Infra-фабрика всё ещё объявляет её зависимостью — даём пустую.
  @Global()
  @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] })
  class ConfigModule {}

  @Module({ imports: [ConfigModule, infraModule(manifest)] })
  class Root {}

  return createContainer(Root);
}

const dbConfig = defineConfig("db", {
  default: { host: "localhost", port: 5432, database: "app", username: "postgres", password: secret("pg-pass") },
});
const redisConfig = defineConfig("redis", { default: { url: "redis://localhost:6379" } });
const searchConfig = defineConfig("search", {
  default: { url: "https://localhost:9200", username: "admin", password: secret("os-pass") },
});

/** Манифест приложения: каждый коннектор получает свой конфиг-объект целиком. */
function appManifest(): InfraManifest {
  return {
    db: postgres(dbConfig),
    cache: redisConnect(redisConfig),
    search: openSearchConnect(searchConfig),
  };
}

describe("@Infra manifest", () => {
  for (const name of ["payment-delivery", "очередь-писем"]) {
    test(`accepts a custom connector without kind under the application name ${name}`, async () => {
      const token = createToken<{ ready: boolean }>("CustomDeliveryClient");
      const events: string[] = [];
      const connector: InfraConnector<{ ready: boolean }> = {
        token,
        create() { events.push("create"); return { ready: false }; },
        connect(client) { events.push("connect"); client.ready = true; },
        dispose(client) { events.push("dispose"); client.ready = false; },
        healthCheck(client) { return client.ready; },
      };
      @Infra({ [name]: connector })
      class CustomInfra {}
      const container = createContainer(CustomInfra);
      const lifecycle = new LifecycleCoordinator(container);
      try {
        expect(events).toEqual([]);
        await lifecycle.start();
        expect(container.resolve(token).ready).toBe(true);
        const checks = container.resolveAll(HEALTH_CHECK);
        expect(checks.map((check) => check.name)).toEqual([`infra:${name}`]);
        expect(await checks[0]!.check()).toEqual({ healthy: true });
        await lifecycle.stopServices();
      } finally {
        await container.dispose();
      }
      expect(events).toEqual(["create", "connect", "dispose"]);
    });
  }

  test("decorator marks the class as a global module exporting connector tokens", () => {
    @Infra(appManifest())
    class AppInfra {}

    const meta = AppInfra as unknown as { global?: boolean; exports?: readonly unknown[]; config?: readonly unknown[] };
    expect(meta.global).toBe(true);
    expect(meta.exports).toEqual([POSTGRES, REDIS, OPENSEARCH]);
    expect(meta.config).toEqual([dbConfig, redisConfig, searchConfig]);
  });

  test("resolves each connector client under its token (constructed, not connected)", () => {
    const container = containerFor(appManifest());

    const sql = container.resolve(POSTGRES);
    expect(typeof sql.unsafe).toBe("function");
    expect(typeof sql.close).toBe("function");

    expect(container.resolve(REDIS)).toBeInstanceOf(RedisClient);
    expect(container.resolve(OPENSEARCH)).toBeInstanceOf(OpenSearchClient);
  });

  test("client is a singleton shared with its lifecycle", () => {
    const container = containerFor(appManifest());
    expect(container.resolve(POSTGRES)).toBe(container.resolve(POSTGRES));
  });

  test("registers one hosted lifecycle per connector with the early phase", () => {
    const container = containerFor(appManifest());
    const hosted = container.resolveAll(HOSTED_SERVICE) as readonly HostedService[];

    const lifecycles = hosted.filter((service): service is InfraLifecycle<unknown> => service instanceof InfraLifecycle);
    expect(lifecycles).toHaveLength(3);
    expect(lifecycles.map((l) => l.instanceName).sort()).toEqual(["cache", "db", "search"]);
    for (const lifecycle of lifecycles) {
      expect(lifecycle.phase).toBe(-100);
    }
  });

  test("registers a health-check named after each instance", () => {
    const container = containerFor(appManifest());
    const checks = container.resolveAll(HEALTH_CHECK) as readonly HealthCheck[];
    expect(checks.map((c) => c.name).sort()).toEqual(["infra:cache", "infra:db", "infra:search"]);
  });

  test("@Infra class carries the module marker when used as a kernel root", async () => {
    @Infra({})
    class EmptyInfra {}

    const kernel = await Osnv.createBuilder(EmptyInfra)
      .useEnvironment("test")
      .useStartupReport(false)
      .build();
    await kernel.stop();
  });

  test("failed connector startup disposes the partial client and aggregates rollback errors", async () => {
    const TOKEN = createToken<object>("BrokenInfraClient");
    const events: string[] = [];
    const connector: InfraConnector<object> = {
      token: TOKEN,
      create: () => ({}),
      connect: () => {
        events.push("connect");
        throw new Error("connect failed");
      },
      dispose: () => {
        events.push("dispose");
        throw new Error("dispose failed");
      },
    };
    const lifecycle = new InfraLifecycle("broken", connector, {});

    await expect(lifecycle.start()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(["connect", "dispose"]);
  });

  test("connector lifecycle is the sole owner of a disposable infra client", async () => {
    const TOKEN = createToken<{ dispose(): void }>("DisposableInfraClient");
    let disposals = 0;
    const connector: InfraConnector<{ dispose(): void }> = {
      token: TOKEN,
      create: () => ({ dispose: () => { disposals += 1; } }),
      connect: () => {},
      dispose: (client) => client.dispose(),
    };
    const root = infraModule({
      resource: connector,
    });
    const kernel = await Osnv.createBuilder(root)
      .useEnvironment("test")
      .useStartupReport(false)
      .build();

    await kernel.start();
    await kernel.stop();
    expect(disposals).toBe(1);
  });
});

describe("config objects (defineConfig → connector)", () => {
  test("connector reads declared keys from the config object", () => {
    const container = containerFor({ db: postgres(dbConfig) });
    expect(typeof container.resolve(POSTGRES).unsafe).toBe("function");
  });

  test("secret declared in the config is revealed for the connection", () => {
    const withSecret = defineConfig("db", {
      default: { host: "localhost", port: 5432, database: "app", username: "postgres", password: secret("hunter2") },
    });
    const container = containerFor({ db: postgres(withSecret) });
    expect(typeof container.resolve(POSTGRES).unsafe).toBe("function");
  });

  test("redis connection URL may be declared as a Secret", () => {
    const secretUrl = defineConfig("redis-secret", {
      default: { url: secret("redis://:password@localhost:6379") },
    });
    const connector = redisConnect(secretUrl);
    const client = connector.create();
    expect(client).toBeInstanceOf(RedisClient);
    client.close();
  });

  test("empty required host fails fast with a clear InfraError", () => {
    // A unique prefix keeps a developer .env (OSNV_DB__*) from filling the empty host.
    const broken = defineConfig("broken-db", {
      default: { host: "", port: 5432, database: "app", username: "postgres", password: secret("x") },
    });
    const container = containerFor({ db: postgres(broken) });
    expect(() => container.resolve(POSTGRES)).toThrow(/"host" is required/);
  });

  test("opensearch requires a url", () => {
    const broken = defineConfig("search", {
      default: { url: "", username: "admin", password: secret("x") },
    });
    const container = containerFor({ search: openSearchConnect(broken) });
    expect(() => container.resolve(OPENSEARCH)).toThrow(InfraError);
  });

  test("opensearch client trims trailing slash from the url", () => {
    expect(new OpenSearchClient({ url: "https://search.internal:9200/" })).toBeInstanceOf(OpenSearchClient);
  });

  test("duplicate connector token in the manifest fails fast", () => {
    const primary = defineConfig("db", {
      default: { host: "a", port: 5432, database: "app", username: "u", password: secret("x") },
    });
    const replica = defineConfig("db2", {
      default: { host: "b", port: 5432, database: "app", username: "u", password: secret("x") },
    });
    expect(() => infraModule({ primary: postgres(primary), replica: postgres(replica) })).toThrow(
      /share the same connector token/,
    );
  });
});
