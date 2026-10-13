import { describe, expect, test } from "bun:test";
import type { HostedService } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { InfraLifecycle, openSearchConnect, postgres, redisConnect, type InfraConnector } from "@/core/infra";
import { ormHostedPlanValidator } from "../OrmHostedPlan.validator";

// An application with ensureCreated on PostgreSQL (exact schema admission at
// phase -105) and a cache or search engine in @Infra failed to start on 0.99.6:
// framework connectors at phase -100 were rejected as application services.

const db = Object.freeze({ phase: -110, __bazisOrmProviderReady: true, start() {}, stop() {} }) as HostedService;
const schema = Object.freeze({
  phase: -105,
  planValidator: ormHostedPlanValidator,
  __bazisSchemaAdmission: Object.freeze({ owner: "TaskDbContext", unit: ["public.tasks"], tables: ["public.tasks"], foreignKeys: [] }),
  start() {}, stop() {},
}) as HostedService;

function validate(services: readonly HostedService[]): void {
  ormHostedPlanValidator.validate([db, schema, ...services]);
}

describe("schema admission with infrastructure connectors", () => {
  test("Redis, OpenSearch and raw PostgreSQL connectors start next to ensureCreated", () => {
    const redis = redisConnect(defineConfig("redis", { default: { url: "redis://127.0.0.1:6379" } }));
    const search = openSearchConnect(defineConfig("search", { default: { url: "http://127.0.0.1:9200", username: "admin", password: secret("x") } }));
    const sql = postgres(defineConfig("reports", { default: { host: "127.0.0.1", port: 5432, database: "app", username: "app", password: secret("x") } }));
    expect(() => validate([
      new InfraLifecycle("cache", redis),
      new InfraLifecycle("search", search),
      new InfraLifecycle("reports", sql),
    ])).not.toThrow();
  });

  test("a custom connector at a negative phase is rejected with its name and the fix", () => {
    const custom: InfraConnector<object> = { token: {} as never, create: () => ({}), connect: () => undefined, dispose: () => undefined };
    expect(() => validate([new InfraLifecycle("notify", custom)])).toThrow(
      "Application hosted services must use phase 0 or later with schema admission: infra:notify (phase -100) is not a framework connector; a custom or changed connector starts at phase 0 or later: set phase: 0 on it.",
    );
    expect(() => validate([new InfraLifecycle("notify", { ...custom, phase: 0 })])).not.toThrow();
  });

  test("a changed framework connector is not trusted", () => {
    const redis = { ...redisConnect(defineConfig("redis", { default: { url: "redis://127.0.0.1:6379" } })) };
    expect(() => validate([new InfraLifecycle("cache", redis)])).toThrow(/infra:cache \(phase -100\) is not a framework connector/);
  });
});
