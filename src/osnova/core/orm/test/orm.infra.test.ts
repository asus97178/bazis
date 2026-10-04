import { describe, expect, test } from "bun:test";
import { createContainer, createToken, Global, HOSTED_SERVICE, Module, singletonValue, type HostedService } from "@/core/di";
import { Configuration, defineConfig, LifecycleCoordinator, secret } from "@/core/kernel";
import { infraModule, InfraError, InfraLifecycle, type InfraConnector } from "@/core/infra";
import { DATABASE_PROVIDER, ormOsnovaConnect } from "@/core/orm";
import { ormHostedPlanValidator } from "../OrmHostedPlan.validator";

describe("ORM @Infra pure contracts", () => {
  test("postgres database connector with an empty host fails fast", () => {
    // A unique prefix keeps a developer .env (OSNOVA_DB__*) from filling the empty host.
    const config = defineConfig("broken-db", {
      default: { host: "", port: 5432, database: "app", username: "postgres", password: secret("x") },
    });
    @Global()
    @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] })
    class ConfigModule {}
    @Module({ imports: [ConfigModule, infraModule({ db: ormOsnovaConnect(config) })] })
    class Root {}
    expect(() => createContainer(Root).resolve(DATABASE_PROVIDER)).toThrow(InfraError);
  });

  test("database connector preserves the canonical provider token and early phase", () => {
    const config = defineConfig("db", {
      default: { host: "localhost", port: 5432, database: "app", username: "postgres", password: secret("x") },
    });
    const connector = ormOsnovaConnect(config);
    expect(connector.token).toBe(DATABASE_PROVIDER);
    expect(connector.phase).toBe(-110);
    expect("kind" in connector).toBe(false);
  });
});

describe("ORM interprets Infra lifecycle evidence", () => {
  function database(events: string[]): InfraConnector {
    return {
      token: DATABASE_PROVIDER, phase: -110,
      create: () => { events.push("db:create"); return {}; },
      connect: () => { events.push("db:start"); },
      dispose: () => { events.push("db:stop"); },
    };
  }
  function admission(events: string[], owned: boolean): HostedService {
    return {
      planValidator: ormHostedPlanValidator, phase: -105,
      ...(owned ? { __osnovaOrmOwnedStoreAdmission: true }
        : { __osnovaSchemaAdmission: { unit: [], tables: [], foreignKeys: [] } }),
      start: () => { events.push("schema:start"); },
      stop: () => { events.push("schema:stop"); },
    };
  }
  function coordinator(services: readonly HostedService[]) {
    return new LifecycleCoordinator({ resolveAll: <T>(token: unknown): readonly T[] => token === HOSTED_SERVICE ? services as unknown as readonly T[] : [] });
  }

  for (const owned of [false, true]) {
    test(`accepts a custom DB connector without kind and preserves reverse cleanup (owned=${owned})`, async () => {
      const events: string[] = [];
      const db = new InfraLifecycle("customer-records", database(events));
      const lifecycle = coordinator([db, admission(events, owned)]);
      await lifecycle.start();
      await lifecycle.stopServices();
      await db.dispose();
      expect(events).toEqual(["db:create", "db:start", "schema:start", "schema:stop", "db:stop"]);
    });

    for (const field of ["token", "phase"] as const) {
      test(`rejects an invalid DB ${field} before any client is created (owned=${owned})`, async () => {
        const events: string[] = [];
        // The same display name cannot substitute the shared token's identity.
        const change = { token: createToken("DatabaseProvider"), phase: -109 };
        const db = new InfraLifecycle("invalid", { ...database(events), [field]: change[field] });
        await expect(coordinator([db, admission(events, owned)]).start())
          .rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
        expect(events).toEqual([]);
      });
    }

    test(`rejects a failed custom DB connection before schema or application startup (owned=${owned})`, async () => {
      const events: string[] = [];
      const db = new InfraLifecycle("customer-records", {
        ...database(events),
        connect() { events.push("db:start"); throw new Error("database unavailable"); },
      });
      const application: HostedService = {
        start() { events.push("application:start"); },
        stop() { events.push("application:stop"); },
      };
      await expect(coordinator([application, admission(events, owned), db]).start()).rejects.toThrow("database unavailable");
      await db.dispose();
      expect(events).toEqual(["db:create", "db:start", "db:stop"]);
    });

    test(`copied lifecycle fields do not establish a DB prerequisite (owned=${owned})`, async () => {
      const events: string[] = [];
      const original = new InfraLifecycle("db", database(events));
      const copy = Object.assign(Object.create(Object.getPrototypeOf(original)), original);
      await expect(coordinator([copy, admission(events, owned)]).start())
        .rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
      expect(events).toEqual([]);
    });
  }
});
